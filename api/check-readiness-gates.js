// ============================================================
// /api/check-readiness-gates.js
//
// Computes the 8 readiness gates for a Product Development Item (PDI)
// using the CORRECT identifier (product_development_items.id).
//
// This replaces inline admin gate logic that was querying product_documents
// with the wrong id (product_development.id instead of product_development_items.id),
// causing "Product images uploaded" and "Technical drawing uploaded" gates
// to always show missing even when factory had uploaded.
//
// POST { pdi_id } OR { product_development_item_id }
//   → {
//       success: true,
//       gates: [{ id, name, section, passed, detail }, ...8],
//       passed_count: N,
//       total: 8,
//       can_activate: boolean,
//       meta: { pdi_id, checked_at }
//     }
//
// Gate sources:
//   1. Golden sample approved   → sample_evaluations.decision='approve' on latest version
//   2. Carton dimensions        → product_development_items.master_* fields all filled
//   3. Product images           → product_documents document_type='Product Image' exists
//   4. Technical drawing        → product_documents document_type IN ('Technical Drawing','Die Lines')
//   5. Compliance docs current  → /api/check-compliance-status returns no blocking flags
//   6. Packaging finalized      → product_development_items.packaging_finalized_at (admin)
//   7. Freight confirmed        → product_development_items.freight_cost_confirmed_at (admin)
//   8. Tariff confirmed         → product_development_items.tariff_confirmed_at (admin)
//
// NOTE: gates 6-8 read columns whose exact names may differ in your schema. If a
// gate stays stuck at "false" even after admin confirmation, check the column
// names below and adjust to match product_development_items.
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Supabase ${res.status}: ${txt}`);
  }
  if (res.status === 204) return null;
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'SUPABASE env vars not set.' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const pdi_id = body.pdi_id || body.product_development_item_id;
  if (!pdi_id) {
    return res.status(400).json({ error: 'Missing pdi_id (UUID from product_development_items).' });
  }

  try {
    // ── Load the PDI ──
    const pdiRows = await sb(
      `product_development_items?id=eq.${pdi_id}&select=*&limit=1`
    );
    if (!pdiRows || !pdiRows.length) {
      return res.status(404).json({ error: 'PDI not found.' });
    }
    const pdi = pdiRows[0];

    // ── Load all current product docs for this PDI (correct id) ──
    const productDocs = await sb(
      `product_documents?product_development_id=eq.${pdi_id}` +
      `&is_current=eq.true&select=document_type,document_type_other,file_name`
    ) || [];

    function hasDocType(typeName) {
      const target = String(typeName || '').toLowerCase().trim();
      return productDocs.some(d => {
        const dt  = String(d.document_type || '').toLowerCase().trim();
        const dto = String(d.document_type_other || '').toLowerCase().trim();
        return dt === target || dto === target;
      });
    }

    // ── 1. Golden sample approved ──
    let goldenApproved = false;
    let goldenDetail = 'No samples shipped yet.';
    if (pdi.status === 'live' || pdi.sku_lifecycle_status === 'live') {
      goldenApproved = true;
      goldenDetail = 'Golden sample approved.';
    } else {
      const subs = await sb(
        `sample_submissions?product_development_id=eq.${pdi_id}` +
        `&select=id,version_number,sample_evaluations(decision)` +
        `&order=version_number.desc&limit=1`
      ) || [];
      if (subs.length) {
        const evals = Array.isArray(subs[0].sample_evaluations) ? subs[0].sample_evaluations : [];
        const latest = evals.length ? evals[evals.length - 1] : null;
        if (latest && latest.decision === 'approve') {
          goldenApproved = true;
          goldenDetail = `Golden sample (v${subs[0].version_number}) approved.`;
        } else if (latest && latest.decision === 'reject') {
          goldenDetail = `Sample v${subs[0].version_number} rejected — revision required.`;
        } else {
          goldenDetail = `Sample v${subs[0].version_number} awaiting evaluation.`;
        }
      }
    }

    // ── 2. Carton dimensions confirmed (master required) ──
    const cartonsOk =
      !!pdi.master_case_pack_units && !!pdi.master_length_cm &&
      !!pdi.master_width_cm        && !!pdi.master_height_cm  &&
      !!pdi.master_weight_kg;
    const cartonsDetail = cartonsOk
      ? `Confirmed${pdi.cartons_confirmed_at ? ' on ' + String(pdi.cartons_confirmed_at).slice(0,10) : ''}.`
      : 'Factory has not confirmed master case dimensions.';

    // ── 3. Product images uploaded ──
    const imagesOk = hasDocType('Product Image');
    const imagesDetail = imagesOk
      ? 'Factory has uploaded product image(s).'
      : 'Factory has not uploaded any product images.';

    // ── 4. Technical drawing uploaded (accept Technical Drawing OR Die Lines) ──
    const drawingOk = hasDocType('Technical Drawing') || hasDocType('Die Lines');
    const drawingDetail = drawingOk
      ? 'Factory has uploaded a technical drawing or dieline.'
      : 'Factory has not uploaded a technical drawing or dieline.';

    // ── 5. Compliance docs current (call check-compliance-status) ──
    let complianceOk = false;
    let complianceDetail = 'Compliance check did not return.';
    try {
      const host  = req.headers['x-forwarded-host'] || req.headers.host;
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const ccsRes = await fetch(`${proto}://${host}/api/check-compliance-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          factory_id: pdi.factory_id,
          rfq_id:     pdi.rfq_id,
          quote_id:   pdi.accepted_quote_id
        })
      });
      if (ccsRes.ok) {
        const ccsData = await ccsRes.json();
        if (ccsData && ccsData.success) {
          complianceOk = !ccsData.status.blocks_po;
          complianceDetail = complianceOk
            ? 'No blocking compliance flags.'
            : 'Blocking compliance issues — see Compliance panel.';
        }
      } else {
        complianceDetail = `Compliance check returned HTTP ${ccsRes.status}.`;
      }
    } catch (e) {
      complianceDetail = 'Compliance check failed: ' + e.message;
    }

    // ── 6, 7, 8. Manual admin confirmations ──
    // Column names below are best-guess. If your schema uses different names,
    // adjust the LHS to match product_development_items columns.
    const packagingOk = !!pdi.packaging_finalized_at;
    const freightOk   = !!pdi.freight_cost_confirmed_at;
    const tariffOk    = !!pdi.tariff_confirmed_at;

    const gates = [
      { id: 'golden_sample',     name: 'Golden sample approved',          section: 'auto',   passed: goldenApproved, detail: goldenDetail   },
      { id: 'carton_dimensions', name: 'Carton dimensions confirmed',     section: 'auto',   passed: cartonsOk,      detail: cartonsDetail  },
      { id: 'product_images',    name: 'Product images uploaded',         section: 'auto',   passed: imagesOk,       detail: imagesDetail   },
      { id: 'technical_drawing', name: 'Technical drawing uploaded',      section: 'auto',   passed: drawingOk,      detail: drawingDetail  },
      { id: 'compliance_docs',   name: 'Compliance docs current',         section: 'auto',   passed: complianceOk,   detail: complianceDetail },
      { id: 'packaging_design',  name: 'Packaging design finalized',      section: 'manual', passed: packagingOk,    detail: packagingOk ? 'Confirmed.' : 'Awaiting admin confirmation.' },
      { id: 'freight_cost',      name: 'Freight cost confirmed',          section: 'manual', passed: freightOk,      detail: freightOk    ? 'Confirmed.' : 'Awaiting admin confirmation.' },
      { id: 'tariff_class',      name: 'Tariff classification confirmed', section: 'manual', passed: tariffOk,       detail: tariffOk     ? 'Confirmed.' : 'Awaiting admin confirmation.' }
    ];

    const passed_count = gates.filter(g => g.passed).length;
    const total = gates.length;

    return res.status(200).json({
      success: true,
      gates,
      passed_count,
      total,
      can_activate: passed_count === total,
      meta: { pdi_id, checked_at: new Date().toISOString() }
    });
  } catch (err) {
    console.error('check-readiness-gates error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}

module.exports = handler;
module.exports.default = handler;
