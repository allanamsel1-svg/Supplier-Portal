// api/tenant-cap-increase.js
// Lets a logged-in tenant raise their own monthly AI cap in fixed $25 increments.
//
//   POST /api/tenant-cap-increase  (Bearer tenant_token)  { amount: 25 }
//     → { success: true, new_cap, previous_cap }
//
// Same serverless style as api/tenant-auth.js — native fetch to PostgREST with
// the service key (the anon key cannot UPDATE the tenants table).
export const config = { runtime: 'nodejs' };

const SB_URL = process.env.SUPABASE_URL || 'https://mjkjubctswjwjihxjpnd.supabase.co';
// Prefer a service key for the write; fall back to anon if that's all that's set.
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const H = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' };

const INCREMENT = 25;

function bearer(req) {
  const h = req.headers.authorization || req.headers.Authorization || '';
  return h.replace('Bearer ', '').trim();
}

async function readBody(req) {
  let b = req.body;
  if (b == null) {
    const chunks = [];
    await new Promise((resolve) => {
      req.on('data', (c) => chunks.push(typeof c === 'string' ? Buffer.from(c) : c));
      req.on('end', resolve);
      req.on('error', resolve);
    });
    try { b = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { b = {}; }
  } else if (typeof b === 'string') {
    try { b = JSON.parse(b); } catch { b = {}; }
  } else if (Buffer.isBuffer(b)) {
    try { b = JSON.parse(b.toString('utf8')); } catch { b = {}; }
  }
  return b || {};
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // ── Validate tenant session (same pattern as tenant-auth validate) ──
    const token = bearer(req);
    if (!token) return res.status(401).json({ error: 'No token' });

    let session = null;
    try {
      const r = await fetch(SB_URL + '/rest/v1/tenant_sessions?select=tenant_id,expires_at,tenant_user_id,tenant_users(is_active)' +
        '&token=eq.' + encodeURIComponent(token) + '&limit=1', { headers: H });
      const arr = r.ok ? await r.json() : [];
      session = Array.isArray(arr) ? arr[0] : null;
    } catch (e) { console.error('cap-increase: session fetch threw', e); session = null; }

    if (!session || !session.tenant_id) return res.status(401).json({ error: 'Invalid session' });
    if (new Date(session.expires_at) < new Date()) return res.status(401).json({ error: 'Session expired' });
    if (session.tenant_users && session.tenant_users.is_active === false) return res.status(403).json({ error: 'Account inactive' });

    const tenantId = session.tenant_id;

    // ── Validate amount (only $25 increments allowed) ──
    const body = await readBody(req);
    const amount = Number(body.amount);
    if (amount !== INCREMENT) return res.status(400).json({ error: 'Only $' + INCREMENT + ' increments are allowed' });

    // ── Read current cap ──
    let current = null;
    try {
      const r = await fetch(SB_URL + '/rest/v1/tenants?select=api_cost_cap_usd&id=eq.' + tenantId + '&limit=1', { headers: H });
      const arr = r.ok ? await r.json() : [];
      current = Array.isArray(arr) && arr[0] ? Number(arr[0].api_cost_cap_usd) : null;
    } catch (e) { console.error('cap-increase: cap fetch threw', e); }
    if (current == null || isNaN(current)) return res.status(500).json({ error: 'Could not read current cap' });

    const previous_cap = current;
    const new_cap = current + INCREMENT;

    // ── PATCH the new cap ──
    const pr = await fetch(SB_URL + '/rest/v1/tenants?id=eq.' + tenantId, {
      method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
      body: JSON.stringify({ api_cost_cap_usd: new_cap }),
    });
    if (!pr.ok) {
      console.error('cap-increase: PATCH failed', pr.status, await pr.text().catch(() => ''));
      return res.status(500).json({ error: 'Could not update cap' });
    }

    // ── Audit log (best-effort) ──
    fetch(SB_URL + '/rest/v1/cap_change_log', {
      method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
      body: JSON.stringify({
        tenant_id: tenantId,
        previous_cap,
        new_cap,
        change_amount: INCREMENT,
        changed_by: 'tenant',
        tenant_user_id: session.tenant_user_id || null,
      }),
    }).catch((e) => console.error('cap-increase: log insert threw', e));

    return res.status(200).json({ success: true, new_cap, previous_cap });
  } catch (e) {
    console.error('cap-increase: unhandled error', e);
    return res.status(500).json({ error: 'Cap increase failed' });
  }
}
