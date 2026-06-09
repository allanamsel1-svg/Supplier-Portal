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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();

  // Gate matches other admin endpoints: skip only when ADMIN_PASSWORD is unset.
  const PASS = process.env.ADMIN_PASSWORD != null ? String(process.env.ADMIN_PASSWORD).trim() : null;
  const KEY = String(process.env.ADMIN_SESSION_SECRET || PASS || '').trim();
  if (PASS && !verifyAdminToken(token, KEY) && token !== PASS) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body || {};
    const { store_name, visit_date, products, metadata } = body;
    if (!products || !Array.isArray(products)) return res.status(400).json({ error: 'Invalid products array' });

    const { data: session, error: sessionError } = await supabase
      .from('shop_out_sessions')
      .insert({ store_name: store_name || metadata?.store, visit_date: visit_date || new Date().toISOString().split('T')[0], source: 'video', video_filename: metadata?.video_file, total_items: products.length, status: 'processed' })
      .select().single();

    if (sessionError) return res.status(500).json({ error: sessionError.message });

    const items = products.map(p => ({ session_id: session.id, store_name: session.store_name, product_name: p.product_name, brand: p.brand, category: p.category, retail_price: p.price, packaging_type: p.packaging, size: p.size, upc: p.upc, quantity_on_shelf: p.quantity_on_shelf, notes: p.notes, source: 'video_ai', confidence: p.price_confidence === 'high' ? 0.9 : 0.7 }));

    for (let i = 0; i < items.length; i += 50) {
      const { error } = await supabase.from('shop_out_items').insert(items.slice(i, i + 50));
      if (error) console.error('Batch insert error:', error.message);
    }

    return res.status(200).json({ success: true, session_id: session.id, count: products.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
