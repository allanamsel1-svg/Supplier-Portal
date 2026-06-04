// ============================================================
// /api/tenant-action-update.js
// Tenant resolves a tenant_action_item. Tenant auth (Bearer session) required.
//
// POST { action_item_id, action:'complete'|'acknowledge'|'ignore', ignore_reason }
//   → { success:true }
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// ============================================================
export const config = { runtime: 'nodejs' };

const SB_URL = process.env.SUPABASE_URL || 'https://mjkjubctswjwjihxjpnd.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
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
function logMetric(metric_type, metric_value, cohort) {
  // platform_metrics_log stores NO tenant_id.
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!SB_KEY) return res.status(500).json({ error: 'Supabase service key not set.' });

  const sess = await validateSession(req);
  if (!sess) return res.status(401).json({ error: 'Unauthorized' });

  const body = await readBody(req);
  const { action_item_id, action, ignore_reason } = body;
  if (!action_item_id || !action) return res.status(400).json({ error: 'Missing action_item_id or action.' });

  // Validate the tenant owns the action item.
  const rows = await sbGet('tenant_action_items?id=eq.' + encodeURIComponent(action_item_id) + '&select=id,tenant_id,reminder_count&limit=1');
  const item = rows[0];
  if (!item) return res.status(404).json({ error: 'Action item not found.' });
  if (item.tenant_id !== sess.tenant_id) return res.status(403).json({ error: 'Not your action item.' });

  const now = new Date().toISOString();
  try {
    let patch, cohort;
    if (action === 'complete') {
      patch = { status: 'completed', completed_at: now, completed_by: sess.tenant_user_id };
      cohort = 'completed';
    } else if (action === 'acknowledge') {
      const tomorrow = new Date(Date.now() + 864e5).toISOString();
      patch = { status: 'acknowledged', acknowledged_at: now, acknowledged_by: sess.tenant_user_id, snoozed_until: tomorrow, reminder_count: (item.reminder_count || 0) + 1, last_reminded_at: now };
      cohort = 'acknowledged';
    } else if (action === 'ignore') {
      patch = { status: 'intentionally_ignored', ignored_at: now, ignored_by: sess.tenant_user_id, ignore_reason: ignore_reason || null };
      cohort = 'intentionally_ignored';
    } else {
      return res.status(400).json({ error: 'Unknown action.' });
    }
    const ok = await sbPatch('tenant_action_items?id=eq.' + encodeURIComponent(action_item_id), patch);
    if (!ok) return res.status(500).json({ error: 'Update failed.' });
    logMetric('action_item_resolution', null, cohort);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('tenant-action-update error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
