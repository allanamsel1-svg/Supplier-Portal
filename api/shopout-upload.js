const { createClient } = require('@supabase/supabase-js');
const { createHmac, timingSafeEqual } = require('crypto');

// Same HMAC admin-session auth as other endpoints (e.g. api/sku-state.js).
// The admin token (localStorage 'admin_session') is a "<payload>.<sig>" string
// signed by api/admin-auth.js with ADMIN_SESSION_SECRET (falls back to ADMIN_PASSWORD).
function verifyAdminToken(token, key) {
  if (!token || typeof token !== 'string' || token.indexOf('.') === -1) return false;
  const [payload, sig] = token.split('.');
  const expected = createHmac('sha256', key).update(payload).digest('base64url');
  if (!sig || sig.length !== expected.length) return false;
  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return !obj.exp || Date.now() < obj.exp;
  } catch { return false; }
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? null : n;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  const PASS = process.env.ADMIN_PASSWORD != null ? String(process.env.ADMIN_PASSWORD).trim() : null;
  const KEY = String(process.env.ADMIN_SESSION_SECRET || PASS || '').trim();

  // Auth: admin session OR a valid tenant session. Tenant context forces its own
  // tenant_id (never trusts a client-supplied one). Admins may pass tenant_id.
  let authed = false, sessionTenantId = null;
  if (!PASS) {
    authed = true; // unconfigured → lenient legacy mode, matches admin-auth.js
  } else if (verifyAdminToken(token, KEY) || token === PASS) {
    authed = true;
  } else if (token) {
    try {
      const { data } = await supabase
        .from('tenant_sessions')
        .select('tenant_id, expires_at')
        .eq('token', token)
        .limit(1)
        .maybeSingle();
      if (data && (!data.expires_at || new Date(data.expires_at).getTime() > Date.now())) {
        authed = true; sessionTenantId = data.tenant_id;
      }
    } catch (e) { /* fall through to 401 */ }
  }
  if (!authed) return res.status(401).json({ error: 'Unauthorized' });

  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body || {};
    const { phase, store_name, visit_date, products, metadata, customer_id } = body;
    const tenantId = sessionTenantId || body.tenant_id || null;

    // ── Helpers ───────────────────────────────────────────────────────
    async function createShop(count) {
      const shopRow = {
        store_location_text: store_name || (metadata && metadata.store) || null,
        shop_date: visit_date || new Date().toISOString().split('T')[0],
        status: 'uploaded',
        processing_status: 'complete',
        processing_completed_at: new Date().toISOString(),
        total_observations: count || 0,
        captured_by: 'video',
        description: metadata && metadata.video_file ? ('Video shop out: ' + metadata.video_file) : 'Video shop out',
      };
      if (tenantId) shopRow.tenant_id = tenantId;
      if (customer_id) shopRow.customer_id = customer_id;
      return supabase.from('shop_outs').insert(shopRow).select().single();
    }

    // Insert photos (for products with thumbnail_url) then observations linked via front_photo_id.
    async function insertObservations(shopId, prods) {
      // 1. Photos — one per product that captured a thumbnail.
      const photoRows = [];
      prods.forEach((p, idx) => {
        if (!p.thumbnail_url) return;
        photoRows.push({
          shop_out_id: shopId,
          file_path: p.thumbnail_url,
          file_name: 'shopout_' + idx + '.jpg',
          photo_type: 'front',
          photo_sequence_number: idx,
          upload_status: 'complete',
          exif_camera_make: 'Meta Ray-Ban Glasses',
          ai_processed_at: new Date().toISOString(),
        });
      });
      const photoIdByIndex = {};
      if (photoRows.length) {
        const { data: insertedPhotos, error: photoErr } = await supabase
          .from('shop_out_photos').insert(photoRows).select('id, photo_sequence_number');
        if (photoErr) console.error('Photo insert error:', photoErr.message);
        else (insertedPhotos || []).forEach(ph => { photoIdByIndex[ph.photo_sequence_number] = ph.id; });
      }

      // 2. Observations — extra fields preserved in ai_extraction_json.
      const items = prods.map((p, idx) => {
        const row = {
          shop_out_id: shopId,
          brand: p.brand || null,
          product_name: p.product_name || null,
          retail_price: numOrNull(p.price),
          upc: p.upc || null,
          ai_suggested_category: p.category || null,
          ai_confidence: p.price_confidence === 'high' ? 0.9 : (p.price_confidence === 'low' ? 0.5 : 0.7),
          review_status: 'pending',
          is_category_gap: false,
          ai_extraction_json: {
            packaging: p.packaging || null,
            size: p.size || null,
            quantity_on_shelf: p.quantity_on_shelf != null ? p.quantity_on_shelf : null,
            notes: p.notes || null,
            price_confidence: p.price_confidence || null,
            source: 'video_ai',
          },
        };
        if (photoIdByIndex[idx]) row.front_photo_id = photoIdByIndex[idx];
        if (tenantId) row.tenant_id = tenantId;
        return row;
      });

      let inserted = 0;
      for (let i = 0; i < items.length; i += 50) {
        const { error } = await supabase.from('shop_out_observations').insert(items.slice(i, i + 50));
        if (error) console.error('Batch insert error:', error.message);
        else inserted += Math.min(50, items.length - i);
      }
      // Keep the run's observation count accurate.
      await supabase.from('shop_outs').update({ total_observations: inserted }).eq('id', shopId);
      return inserted;
    }

    // Tenant context may only finalize its own shop-outs.
    async function assertOwnsShop(shopId) {
      if (!sessionTenantId) return true; // admin
      const { data } = await supabase.from('shop_outs').select('tenant_id').eq('id', shopId).maybeSingle();
      return !!(data && data.tenant_id === sessionTenantId);
    }

    // ── PHASE 1: create the shop_outs record only, return its id ───────
    if (phase === 'create') {
      const { data: shop, error: shopError } = await createShop(0);
      if (shopError) return res.status(500).json({ error: shopError.message });
      return res.status(200).json({ success: true, shop_out_id: shop.id });
    }

    // ── PHASE 2: insert photos + observations for an existing shop-out ─
    if (phase === 'finalize') {
      const shopId = body.shop_out_id;
      if (!shopId) return res.status(400).json({ error: 'shop_out_id required' });
      if (!Array.isArray(products)) return res.status(400).json({ error: 'Invalid products array' });
      if (!(await assertOwnsShop(shopId))) return res.status(403).json({ error: 'Forbidden' });
      const count = await insertObservations(shopId, products);
      return res.status(200).json({ success: true, shop_out_id: shopId, count });
    }

    // ── DEFAULT: single-shot create + observations (back-compat) ───────
    if (!Array.isArray(products)) return res.status(400).json({ error: 'Invalid products array' });
    const { data: shop, error: shopError } = await createShop(products.length);
    if (shopError) return res.status(500).json({ error: shopError.message });
    const count = await insertObservations(shop.id, products);
    return res.status(200).json({ success: true, shop_out_id: shop.id, count });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
