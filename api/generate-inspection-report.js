// ============================================================
// /api/generate-inspection-report.js
// Builds a printable HTML inspection report (browser handles "Save as PDF").
// Admin auth: Authorization: Bearer <admin_session HMAC token>.
//
// POST { inspection_id }  → text/html  (200) | { error } (401/404/500)
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_PASSWORD/ADMIN_SESSION_SECRET
// ============================================================
export const config = { runtime: 'nodejs' };

import { createHmac, timingSafeEqual } from 'crypto';

const SB_URL = process.env.SUPABASE_URL || 'https://mjkjubctswjwjihxjpnd.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const H = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' };

function readBody(req) { let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } } return b || {}; }
function bearer(req) { return (req.headers.authorization || req.headers.Authorization || '').replace('Bearer ', '').trim(); }
async function sbGet(path) { const r = await fetch(SB_URL + '/rest/v1/' + path, { headers: H }); if (!r.ok) return []; const d = await r.json(); return Array.isArray(d) ? d : []; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function verifyAdminToken(token, key) {
  if (!token || typeof token !== 'string' || token.indexOf('.') === -1) return false;
  const [payload, sig] = token.split('.');
  const expected = createHmac('sha256', key).update(payload).digest('base64url');
  if (!sig || sig.length !== expected.length) return false;
  try { if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false; } catch { return false; }
  try { const obj = JSON.parse(Buffer.from(payload, 'base64url').toString()); return !obj.exp || Date.now() < obj.exp; } catch { return false; }
}

function mc(v) { return v == null || v === '' ? '—' : esc(v); }
function matchMark(m) { return m === true ? '✓' : m === false ? '✗' : '—'; }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Admin auth (skip only if ADMIN_PASSWORD unconfigured — matches admin-auth.js legacy mode).
  const PASS = process.env.ADMIN_PASSWORD != null ? String(process.env.ADMIN_PASSWORD).trim() : null;
  const KEY = String(process.env.ADMIN_SESSION_SECRET || PASS || '').trim();
  if (PASS) { if (!verifyAdminToken(bearer(req), KEY)) return res.status(401).json({ error: 'Unauthorized' }); }

  const { inspection_id } = readBody(req);
  if (!inspection_id) return res.status(400).json({ error: 'Missing inspection_id.' });

  try {
    const irows = await sbGet('inspections?id=eq.' + encodeURIComponent(inspection_id) +
      '&select=*,purchase_orders(po_number,quantity,expected_ship_date),factories(factory_name_english,city,country),tenants(name)&limit=1');
    const insp = irows[0];
    if (!insp) return res.status(404).json({ error: 'Inspection not found.' });

    const measurements = await sbGet('inspection_measurements?inspection_id=eq.' + encodeURIComponent(inspection_id) + '&select=*');
    const defects = await sbGet('inspection_defects?inspection_id=eq.' + encodeURIComponent(inspection_id) + '&select=*&order=created_at.asc');
    const conf = await sbGet('inspection_confirmations?inspection_id=eq.' + encodeURIComponent(inspection_id) + '&select=*&order=sent_at.desc&limit=1');

    const po = insp.purchase_orders || {}, fac = insp.factories || {}, ten = insp.tenants || {};
    const outcome = insp.outcome || (insp.status === 'pass' || insp.status === 'fail' || insp.status === 'conditional_pass' ? insp.status : '');
    const resultCls = outcome === 'pass' ? 'pass' : outcome === 'fail' ? 'fail' : outcome === 'conditional_pass' ? 'conditional' : '';
    const resultTxt = outcome === 'pass' ? 'PASS' : outcome === 'fail' ? 'FAIL' : outcome === 'conditional_pass' ? 'CONDITIONAL PASS' : 'PENDING';
    const cf = insp.critical_defects_found || 0, mf = insp.major_defects_found || 0, nf = insp.minor_defects_found || 0;
    const ma = insp.major_defects_allowed || 0, na = insp.minor_defects_allowed || 0;
    const today = new Date().toISOString().slice(0, 10);

    const mByType = {}; measurements.forEach(m => { mByType[m.measurement_type] = m; });
    const measRows = ['unit', 'inner', 'master'].map(t => {
      const m = mByType[t] || {};
      return `<tr><td>${t}</td>` +
        `<td>${mc(m.weight_spec)}</td><td>${mc(m.weight_actual)}</td><td>${matchMark(m.weight_match)}</td>` +
        `<td>${mc(m.length_spec)}</td><td>${mc(m.length_actual)}</td><td>${matchMark(m.length_match)}</td>` +
        `<td>${mc(m.width_spec)}</td><td>${mc(m.width_actual)}</td><td>${matchMark(m.width_match)}</td>` +
        `<td>${mc(m.height_spec)}</td><td>${mc(m.height_actual)}</td><td>${matchMark(m.height_match)}</td>` +
        `<td>${mc(m.upc_spec)}</td><td>${mc(m.upc_actual)}</td><td>${matchMark(m.upc_match)}</td></tr>`;
    }).join('');

    const defectRows = defects.length ? defects.map((d, i) =>
      `<tr><td>${i + 1}</td><td>${mc(d.defect_type)}</td><td>${mc(d.defect_category)}</td><td>${mc(d.description)}</td><td>${mc(d.qty_affected != null ? d.qty_affected : 1)}</td><td>${mc(d.tenant_action || 'Awaiting')}</td></tr>`
    ).join('') : '<tr><td colspan="6">No defects recorded.</td></tr>';

    const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Inspection Report — ${esc(po.po_number || inspection_id)}</title><style>
  body { font-family: Arial, sans-serif; font-size: 12px; color: #1a1a2e; padding: 40px; }
  h1 { font-size: 20px; border-bottom: 2px solid #1a1a2e; padding-bottom: 8px; }
  h2 { font-size: 14px; background: #f0f0e8; padding: 6px 10px; margin-top: 20px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { border: 1px solid #ddd; padding: 6px 8px; text-align: left; }
  th { background: #f0f0e8; font-weight: 700; }
  .pass { color: #1a7a1a; font-weight: 700; }
  .fail { color: #b00; font-weight: 700; }
  .amber { color: #a86b00; font-weight: 700; }
  .header-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px; }
  .header-item .label { font-size: 10px; color: #888; text-transform: uppercase; }
  .header-item .value { font-size: 13px; font-weight: 600; }
  .result-box { border: 2px solid; border-radius: 8px; padding: 16px; text-align: center; margin: 20px 0; }
  .result-box.pass { border-color: #1a7a1a; background: #e8f8e8; }
  .result-box.fail { border-color: #b00; background: #fde8e8; }
  .result-box.conditional { border-color: #a86b00; background: #fff8e0; }
</style></head>
<body>
<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px;">
  <div><h1>Pre-Shipment Inspection Report</h1><div style="color:#888;font-size:11px;">Generated by TBG Sourcing · ${today}</div></div>
  <div style="text-align:right;font-size:11px;color:#888;">CONFIDENTIAL</div>
</div>
<div class="header-grid">
  <div class="header-item"><div class="label">PO Number</div><div class="value">${mc(po.po_number)}</div></div>
  <div class="header-item"><div class="label">Tenant</div><div class="value">${mc(ten.name)}</div></div>
  <div class="header-item"><div class="label">Factory</div><div class="value">${mc(fac.factory_name_english)} · ${mc(fac.city)}, ${mc(fac.country)}</div></div>
  <div class="header-item"><div class="label">Inspection Date</div><div class="value">${mc(insp.scheduled_date)}</div></div>
  <div class="header-item"><div class="label">Inspection Type</div><div class="value">${mc(insp.inspection_type)}</div></div>
  <div class="header-item"><div class="label">Inspector</div><div class="value">${mc(insp.inspector_company || insp.inspection_method)}</div></div>
  <div class="header-item"><div class="label">PO Quantity</div><div class="value">${po.quantity != null ? esc(po.quantity) + ' units' : '—'}</div></div>
  <div class="header-item"><div class="label">Sample Size</div><div class="value">${insp.sample_size != null ? esc(insp.sample_size) + ' units' : '—'}</div></div>
  <div class="header-item"><div class="label">AQL Level</div><div class="value">${mc(insp.aql_level)} / Level ${mc(insp.inspection_level)}</div></div>
  <div class="header-item"><div class="label">Factory Confirmed</div><div class="value">${insp.factory_confirmed_at ? esc(String(insp.factory_confirmed_at).slice(0, 10)) : 'Not confirmed'}</div></div>
</div>
<div class="result-box ${resultCls}">
  <div style="font-size:24px;font-weight:700;">${resultTxt}</div>
  <div style="font-size:13px;margin-top:4px;">Critical: ${cf} found (0 allowed) · Major: ${mf} found (${ma} allowed) · Minor: ${nf} found (${na} allowed)</div>
</div>
<h2>Measurements Verification</h2>
<table>
  <tr><th>Type</th><th>Weight Spec</th><th>Weight Actual</th><th>Match</th><th>L Spec</th><th>L Actual</th><th>Match</th><th>W Spec</th><th>W Actual</th><th>Match</th><th>H Spec</th><th>H Actual</th><th>Match</th><th>UPC Spec</th><th>UPC Actual</th><th>Match</th></tr>
  ${measRows}
</table>
<h2>Defects Found (${defects.length} total)</h2>
<table>
  <tr><th>#</th><th>Type</th><th>Category</th><th>Description</th><th>Qty Affected</th><th>Tenant Decision</th></tr>
  ${defectRows}
</table>
${insp.outcome_notes ? '<h2>Inspector Notes</h2><p>' + esc(insp.outcome_notes) + '</p>' : ''}
${conf[0] ? '<h2>Factory Confirmation</h2><p>Sent ' + esc(String(conf[0].sent_at || '').slice(0, 10)) + ' · ' + (conf[0].factory_responded_at ? (conf[0].confirmed ? 'Confirmed' : 'Flagged: ' + esc(conf[0].response_notes || '')) : 'Awaiting response') + '</p>' : ''}
<div style="margin-top:40px;border-top:1px solid #ddd;padding-top:16px;font-size:10px;color:#888;">
  This report was generated by TBG Sourcing portal. All measurements and defect assessments are recorded as-observed. This document is confidential and intended for internal use only.
</div>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  } catch (err) {
    console.error('generate-inspection-report error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
