// api/auto-create-sku.js
// Automatically create a Live SKU + design brief once every outstanding item
// (assets_required + dims_required + certs_required) for an artwork project is received.
//
//   POST { artwork_project_id, pd_item_id }
//   → { success, model_number, unit_upc, inner_upc, master_upc, pallet_upc } | { success:false, reason }
//
// Idempotent: if the linked product_development already has a sku_id, it returns the
// existing identifiers without claiming a new UPC.
export const config = { runtime: 'nodejs' };

const SB_URL = process.env.SUPABASE_URL || 'https://mjkjubctswjwjihxjpnd.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const H = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' };

// ITF-14 from a 12-digit UPC and a packaging indicator (1=inner, 2=master, 3=pallet).
function deriveItf14(upc12, indicator) {
  const base = String(indicator) + String(upc12).slice(0, 12);
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += (parseInt(base[i], 10) || 0) * (i % 2 === 0 ? 3 : 1);
  const check = (10 - (sum % 10)) % 10;
  return base + check;
}
function prefix3(s, fb) {
  const t = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return t ? t.slice(0, 3) : (fb || 'GEN');
}
function normReceived(v) {
  return (Array.isArray(v) ? v : []).filter(a => a && (typeof a === 'object' ? a.name : true));
}
function allReceived(ap) {
  const all = ['assets_required', 'dims_required', 'certs_required']
    .reduce((acc, col) => acc.concat(normReceived(ap[col])), []);
  if (!all.length) return false;
  return all.every(a => (typeof a === 'object') ? a.received === true : false);
}

async function sbGet(path) {
  const r = await fetch(SB_URL + '/rest/v1/' + path, { headers: H });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });
  if (!SB_KEY) return res.status(500).json({ error: 'Service not configured.' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const artworkProjectId = (body.artwork_project_id || '').toString().trim();
  const pdItemId = (body.pd_item_id || '').toString().trim();
  if (!artworkProjectId || !pdItemId) return res.status(400).json({ error: 'artwork_project_id and pd_item_id are required.' });

  try {
    // 1) Load the artwork project; verify it matches the PD item and is fully received.
    const apRows = await sbGet('artwork_projects?id=eq.' + encodeURIComponent(artworkProjectId) +
      '&select=id,pd_item_id,assets_required,dims_required,certs_required,packaging_selections,sku_id&limit=1');
    const ap = apRows[0];
    if (!ap) return res.status(404).json({ success: false, reason: 'artwork project not found' });
    if (ap.pd_item_id && pdItemId && ap.pd_item_id !== pdItemId) return res.status(400).json({ success: false, reason: 'pd_item_id mismatch' });
    if (!allReceived(ap)) return res.status(200).json({ success: false, reason: 'not all items received' });

    // 2) PDI → product_development.
    const pdiRows = await sbGet('product_development_items?id=eq.' + encodeURIComponent(pdItemId) + '&select=id,product_development_id&limit=1');
    const pdi = pdiRows[0];
    if (!pdi || !pdi.product_development_id) return res.status(404).json({ success: false, reason: 'product_development_items not found' });

    const pdRows = await sbGet('product_development?id=eq.' + encodeURIComponent(pdi.product_development_id) +
      '&select=id,item_description,category,category_id,brand_id,factory_id,rfq_id,tenant_id,sku_id,is_cosmetic&limit=1');
    const pd = pdRows[0];
    if (!pd) return res.status(404).json({ success: false, reason: 'product_development not found' });

    // 3) Idempotency — already has a SKU.
    if (pd.sku_id) {
      return res.status(200).json({ success: true, skipped: true, sku_id: pd.sku_id });
    }

    const tenantId = pd.tenant_id || ap.tenant_id || null;

    // 4) Claim the next available unit UPC from the pool.
    const pool = await sbGet('upc_pool?is_assigned=eq.false&level=eq.unit&order=upc_code&limit=1');
    if (!pool.length) return res.status(409).json({ success: false, reason: 'UPC pool empty' });
    const unitUpc = pool[0].upc_code;
    const claim = await fetch(SB_URL + '/rest/v1/upc_pool?upc_code=eq.' + encodeURIComponent(unitUpc), {
      method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
      body: JSON.stringify({ is_assigned: true, assigned_to_pd_id: pd.id, assigned_at: new Date().toISOString() })
    });
    if (!claim.ok) return res.status(500).json({ success: false, reason: 'could not claim UPC (' + claim.status + ')' });

    const innerUpc = deriveItf14(unitUpc, 1);
    const masterUpc = deriveItf14(unitUpc, 2);
    const palletUpc = deriveItf14(unitUpc, 3);

    // 5) Model number: [BRAND 3][-CAT 3][-SEQ 4]. Brand prefix from tenant name, category from PD category.
    let tenantName = '';
    if (tenantId) { const tr = await sbGet('tenants?id=eq.' + encodeURIComponent(tenantId) + '&select=name&limit=1'); tenantName = (tr[0] && tr[0].name) || ''; }
    const brandPfx = prefix3(tenantName, 'BRD');
    const catPfx = prefix3(pd.category, 'GEN');
    // Sequence = count of this tenant's SKUs + 1, padded to 4 digits.
    let seq = 1;
    try {
      const cr = await fetch(SB_URL + '/rest/v1/skus?select=id' + (tenantId ? '&tenant_id=eq.' + encodeURIComponent(tenantId) : ''),
        { headers: { ...H, Prefer: 'count=exact', Range: '0-0' } });
      const crange = cr.headers.get('content-range') || '';
      const totalStr = crange.split('/')[1];
      const total = parseInt(totalStr, 10);
      if (!isNaN(total)) seq = total + 1;
    } catch (e) { /* default 1 */ }
    const modelNumber = brandPfx + '-' + catPfx + '-' + String(seq).padStart(4, '0');

    // 6) Insert the SKU.
    const skuPayload = {
      model_number: modelNumber, brand_prefix: brandPfx, category_prefix: catPfx, sequence_number: seq,
      description: pd.item_description || modelNumber, status: 'active', upc_code: unitUpc,
      tenant_id: tenantId, category_id: pd.category_id || null, brand_id: pd.brand_id || null,
      is_kit: false, is_cosmetic: !!pd.is_cosmetic
    };
    const skuR = await fetch(SB_URL + '/rest/v1/skus', { method: 'POST', headers: { ...H, Prefer: 'return=representation' }, body: JSON.stringify(skuPayload) });
    if (!skuR.ok) {
      const t = await skuR.text().catch(() => '');
      // Release the UPC we claimed so it isn't stranded.
      fetch(SB_URL + '/rest/v1/upc_pool?upc_code=eq.' + encodeURIComponent(unitUpc), { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ is_assigned: false, assigned_to_pd_id: null, assigned_at: null }) }).catch(() => {});
      return res.status(500).json({ success: false, reason: 'SKU insert failed (' + skuR.status + ') ' + t.slice(0, 200) });
    }
    const skuRows = await skuR.json().catch(() => []);
    const newSku = Array.isArray(skuRows) ? skuRows[0] : skuRows;
    const skuId = newSku && newSku.id;

    // Lock the pool UPC to the SKU.
    fetch(SB_URL + '/rest/v1/upc_pool?upc_code=eq.' + encodeURIComponent(unitUpc), { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ assigned_to_sku: skuId }) }).catch(() => {});

    // 7) Update product_development → live, with all four UPCs + gate.
    await fetch(SB_URL + '/rest/v1/product_development?id=eq.' + pd.id, {
      method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
      body: JSON.stringify({ sku_id: skuId, activated_sku_id: skuId, unit_upc: unitUpc, inner_upc: innerUpc, master_upc: masterUpc, pallet_upc: palletUpc, sku_lifecycle_status: 'live', gate_assets_ok: true, updated_at: new Date().toISOString() })
    });

    // 8) Update artwork_projects → ready_for_design + link SKU.
    await fetch(SB_URL + '/rest/v1/artwork_projects?id=eq.' + encodeURIComponent(ap.id), {
      method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
      body: JSON.stringify({ sku_id: skuId, status: 'ready_for_design', updated_at: new Date().toISOString() })
    });

    // 9) Auto-generate the design brief (with the UPCs embedded) and save it.
    try {
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      if (host) {
        const pkg = Array.isArray(ap.packaging_selections) ? ap.packaging_selections : [];
        const br = await fetch(proto + '://' + host + '/api/generate-design-brief', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sku_description: pd.item_description || modelNumber, category: pd.category || '', packaging_selections: pkg, unit_upc: unitUpc, inner_upc: innerUpc, master_upc: masterUpc, pallet_upc: palletUpc })
        });
        const bd = await br.json().catch(() => ({}));
        if (br.ok && bd && bd.brief) {
          await fetch(SB_URL + '/rest/v1/artwork_projects?id=eq.' + encodeURIComponent(ap.id), { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ ai_brief: bd.brief }) });
        }
      }
    } catch (e) { console.error('auto-create-sku: brief generation failed (non-fatal)', e); }

    // 10) Best-effort logic_log entry.
    try {
      await fetch(SB_URL + '/rest/v1/logic_log', { method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ module: 'auto-create-sku', area: 'Product Development', location: 'api/auto-create-sku.js', what_it_does: 'SKU auto-created: ' + modelNumber + ' with UPC ' + unitUpc + ' triggered by all assets received', status: 'active' }) });
    } catch (e) { /* non-fatal */ }

    return res.status(200).json({ success: true, model_number: modelNumber, unit_upc: unitUpc, inner_upc: innerUpc, master_upc: masterUpc, pallet_upc: palletUpc });
  } catch (err) {
    console.error('auto-create-sku error:', err);
    return res.status(500).json({ success: false, reason: String(err.message || err) });
  }
}
