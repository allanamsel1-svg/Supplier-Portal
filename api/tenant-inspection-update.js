// ============================================================
// /api/tenant-inspection-update.js
// Tenant-side inspection workflow actions. Tenant auth (Bearer session) required.
//
// POST body (action determines behaviour):
//   { action:'set_method', inspection_id, inspection_method, inspector_company, inspector_contact_name, inspector_contact_email, waiver_reason, waiver_acknowledged }
//   { action:'defect_action', inspection_id, defect_id, tenant_action, tenant_action_notes, rework_instructions }
//   { action:'accept_upc', inspection_id, new_upc, sku_id }
//   { action:'request_rework', inspection_id, rework_reason }
//   → { success:true, action_taken }
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PUBLIC_BASE_URL (optional)
// ============================================================
export const config = { runtime: 'nodejs' };

import { createHmac, timingSafeEqual } from 'crypto';

const SB_URL = process.env.SUPABASE_URL || 'https://mjkjubctswjwjihxjpnd.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const BASE = process.env.PUBLIC_BASE_URL || 'https://portal.tbgsourcing.net';
const H = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' };

async function readBody(req) {
  let b = req.body;
  if (b == null) {
    const chunks = [];
    await new Promise((resolve) => { req.on('data', c => chunks.push(typeof c === 'string' ? Buffer.from(c) : c)); req.on('end', resolve); req.on('error', resolve); });
    try { b = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { b = {}; }
  } else if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
  return b || {};
}
function bearer(req) { return (req.headers.authorization || req.headers.Authorization || '').replace('Bearer ', '').trim(); }
async function sbGet(path) { const r = await fetch(SB_URL + '/rest/v1/' + path, { headers: H }); if (!r.ok) return []; const d = await r.json(); return Array.isArray(d) ? d : []; }
async function sbPatch(path, body) { const r = await fetch(SB_URL + '/rest/v1/' + path, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(body) }); return r.ok; }
async function sbPost(path, body, rep) { const r = await fetch(SB_URL + '/rest/v1/' + path, { method: 'POST', headers: { ...H, Prefer: rep ? 'return=representation' : 'return=minimal' }, body: JSON.stringify(body) }); if (!r.ok) return null; return rep ? await r.json() : true; }
function logMetric(metric_type, metric_value, cohort) {
  // NOTE: platform_metrics_log intentionally stores NO tenant_id.
  fetch(SB_URL + '/rest/v1/platform_metrics_log', { method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
    body: JSON.stringify({ metric_type, metric_value: metric_value == null ? null : metric_value, cohort: cohort || null, recorded_at: new Date().toISOString() }) }).catch(() => {});
}

async function validateSession(req) {
  const token = bearer(req);
  if (!token) return null;
  const arr = await sbGet('tenant_sessions?select=tenant_id,tenant_user_id,expires_at&token=eq.' + encodeURIComponent(token) + '&limit=1');
  const s = arr[0];
  if (!s || new Date(s.expires_at) < new Date()) return null;
  return { tenant_id: s.tenant_id, tenant_user_id: s.tenant_user_id };
}
// Admin override: a valid admin_session HMAC token may act on any tenant (admin mirror view).
function isAdminToken(req) {
  const token = bearer(req);
  if (!token || token.indexOf('.') === -1) return false;
  const PASS = process.env.ADMIN_PASSWORD != null ? String(process.env.ADMIN_PASSWORD).trim() : null;
  if (!PASS) return false;
  const key = String(process.env.ADMIN_SESSION_SECRET || PASS || '').trim();
  const [payload, sig] = token.split('.');
  const expected = createHmac('sha256', key).update(payload).digest('base64url');
  if (!sig || sig.length !== expected.length) return false;
  try { if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false; } catch { return false; }
  try { const obj = JSON.parse(Buffer.from(payload, 'base64url').toString()); return !obj.exp || Date.now() < obj.exp; } catch { return false; }
}

// Flip an inspection to rework_required, create the child inspection, notify factory, create the action item.
async function scheduleReworkChild(insp, desc, sess) {
  await sbPatch('inspections?id=eq.' + insp.id, { status: 'rework_required', tenant_decision: 'rework_requested', rework_instructions: desc, updated_at: new Date().toISOString() });
  const child = await sbPost('inspections', { tenant_id: insp.tenant_id, po_id: insp.po_id, factory_id: insp.factory_id, inspection_type: insp.inspection_type, inspection_method: insp.inspection_method, status: 'scheduled', parent_inspection_id: insp.id }, true);
  const childId = (child && child[0] && child[0].id) || null;
  await sbPost('tenant_action_items', { tenant_id: insp.tenant_id, type: 'rework_scheduled', reference_id: childId || insp.id, reference_type: 'inspection', title: 'Rework inspection scheduled', description: desc, priority: 'critical', status: 'open', due_date: insp.scheduled_date || null });
  if (childId) { try { await fetch(BASE + '/api/inspection-confirm-request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ inspection_id: childId, days_before: null }) }); } catch (e) {} }
  return childId;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!SB_KEY) return res.status(500).json({ error: 'Supabase service key not set.' });

  const body = await readBody(req);
  let sess = await validateSession(req);
  if (!sess && isAdminToken(req)) sess = { tenant_id: body.tenant_id || null, tenant_user_id: null, admin: true };
  if (!sess) return res.status(401).json({ error: 'Unauthorized' });

  const action = body.action;
  const inspectionId = body.inspection_id;
  if (!action || !inspectionId) return res.status(400).json({ error: 'Missing action or inspection_id.' });

  // Validate the tenant owns the inspection (admin override may act on any tenant).
  const irows = await sbGet('inspections?id=eq.' + encodeURIComponent(inspectionId) + '&select=*&limit=1');
  const insp = irows[0];
  if (!insp) return res.status(404).json({ error: 'Inspection not found.' });
  if (sess.admin) sess.tenant_id = insp.tenant_id;
  else if (insp.tenant_id !== sess.tenant_id) return res.status(403).json({ error: 'Not your inspection.' });

  try {
    if (action === 'set_method') {
      const patch = { inspection_method: body.inspection_method || null, updated_at: new Date().toISOString() };
      if (body.inspection_method === 'third_party') {
        patch.inspector_company = body.inspector_company || null;
        patch.inspector_contact_name = body.inspector_contact_name || null;
        patch.inspector_contact_email = body.inspector_contact_email || null;
      } else if (body.inspection_method === 'self_inspection') {
        patch.waiver_reason = body.waiver_reason || null;
        if (body.waiver_acknowledged) { patch.waiver_acknowledged_at = new Date().toISOString(); patch.waiver_acknowledged_by = sess.tenant_user_id; }
      }
      await sbPatch('inspections?id=eq.' + inspectionId, patch);
      logMetric('inspection_method_choice', null, body.inspection_method);
      return res.status(200).json({ success: true, action_taken: 'set_method' });
    }

    if (action === 'defect_action') {
      if (!body.defect_id) return res.status(400).json({ error: 'Missing defect_id.' });
      const ta = body.tenant_action === 'accept' ? 'accept' : 'reject';
      await sbPatch('inspection_defects?id=eq.' + encodeURIComponent(body.defect_id) + '&inspection_id=eq.' + encodeURIComponent(inspectionId), {
        tenant_action: ta, tenant_action_notes: body.tenant_action_notes || null, actioned_at: new Date().toISOString(), actioned_by: sess.tenant_user_id,
      });
      logMetric('defect_decision', ta === 'accept' ? 1 : 0, null);
      if (ta === 'reject') {
        await scheduleReworkChild(insp, body.rework_instructions || 'Defect rejected by buyer — rework required.', sess);
        return res.status(200).json({ success: true, action_taken: 'defect_rejected_rework_scheduled' });
      }
      // Accept: if all defects now actioned, create a completion action item.
      const remaining = await sbGet('inspection_defects?inspection_id=eq.' + encodeURIComponent(inspectionId) + '&tenant_action=is.null&select=id');
      if (!remaining.length) {
        await sbPost('tenant_action_items', { tenant_id: insp.tenant_id, type: 'inspection_complete', reference_id: inspectionId, reference_type: 'inspection', title: 'Inspection accepted — ready to proceed', description: 'All defects reviewed and accepted.', priority: 'medium', status: 'open' });
      }
      return res.status(200).json({ success: true, action_taken: 'defect_accepted' });
    }

    if (action === 'accept_upc') {
      if (body.sku_id) await sbPatch('skus?id=eq.' + encodeURIComponent(body.sku_id), { upc_code: body.new_upc || null, updated_at: new Date().toISOString() });
      const po = await sbGet('purchase_orders?id=eq.' + encodeURIComponent(insp.po_id) + '&select=po_number&limit=1');
      const poNum = (po[0] && po[0].po_number) || insp.po_id;
      await sbPost('tenant_action_items', { tenant_id: insp.tenant_id, type: 'sku_update_required', reference_id: inspectionId, reference_type: 'inspection', title: 'Customer SKU forms need updating — UPC changed', description: 'UPC updated to ' + (body.new_upc || '?') + ' on PO ' + poNum + '. Update all customer vendor portals.', priority: 'high', status: 'open' });
      await sbPatch('inspections?id=eq.' + inspectionId, { upc_verified: false, measurements_notes: 'UPC accepted and updated in SKU library — customer form update pending', updated_at: new Date().toISOString() });
      return res.status(200).json({ success: true, action_taken: 'accept_upc' });
    }

    if (action === 'request_rework') {
      await scheduleReworkChild(insp, body.rework_reason || 'Buyer requested rework.', sess);
      return res.status(200).json({ success: true, action_taken: 'request_rework' });
    }

    return res.status(400).json({ error: 'Unknown action.' });
  } catch (err) {
    console.error('tenant-inspection-update error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
