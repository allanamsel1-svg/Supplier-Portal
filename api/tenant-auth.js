// api/tenant-auth.js
// Tenant user login, session validation, logout.
//
// Implemented in the portal's proven serverless style (ESM `export default` +
// native fetch to Supabase PostgREST with the service key) — the repo has no
// package.json / @supabase/supabase-js installed, so the SDK is unavailable here.
//
//   GET  /api/tenant-auth?action=test     → { ok: true }                       (reachability probe)
//   POST /api/tenant-auth?action=login    { email, password } → { token, expires_at, user }
//   POST /api/tenant-auth?action=validate (Bearer token)      → { valid, user }
//   POST /api/tenant-auth?action=logout   (Bearer token)      → { success }
export const config = { runtime: 'nodejs' };

import { createHash, createHmac, timingSafeEqual } from 'crypto';

const SB_URL = process.env.SUPABASE_URL || 'https://mjkjubctswjwjihxjpnd.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const H = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' };

// Byline Brands — the tenant an authenticated admin is shown when browsing the tenant
// portal pages (admins hold an admin_session, not a tenant_token / tenant_users row).
const ADMIN_TENANT_ID = 'f64c18ac-c0b4-4bba-a3e6-b64ef0fd3bf4';

// Verify an admin session token exactly the way api/admin-auth.js does:
// token = base64url(payload) + '.' + base64url(HMAC-SHA256(payload, KEY)),
// KEY = ADMIN_SESSION_SECRET || ADMIN_PASSWORD. Returns false if unconfigured.
function verifyAdminToken(token) {
  const key = String(process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASSWORD || '').trim();
  if (!key || !token || typeof token !== 'string' || token.indexOf('.') === -1) return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  const expected = createHmac('sha256', key).update(payload).digest('base64url');
  if (sig.length !== expected.length) return false;
  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return !obj.exp || Date.now() < obj.exp;
  } catch { return false; }
}

function hashPassword(password) {
  // SHA256 of password + salt, concatenated with no separator.
  // Defaults to 'tbg-salt-2026' when TENANT_PASSWORD_SALT is unset — this MUST
  // match the salt used when seeding password_hash or every login will 401.
  const salt = process.env.TENANT_PASSWORD_SALT || 'tbg-salt-2026';
  return createHash('sha256').update(password + salt).digest('hex');
}

const TENANT_EMBED = 'tenants(id,name,slug,plan,billing_status,features,api_cost_cap_usd,api_markup_rate)';

function userPayload(u, tenantId) {
  return {
    id: u.id,
    email: u.email,
    full_name: u.full_name,
    role: u.role,
    // Role-based landing page. Designers go to the creative portal; everyone else to the dashboard.
    redirect: u.role === 'designer' ? 'designer-portal.html' : 'tenant-dashboard.html',
    tenant: {
      id: tenantId,
      name: u.tenants.name,
      slug: u.tenants.slug,
      plan: u.tenants.plan,
      features: u.tenants.features,
      api_cost_cap_usd: u.tenants.api_cost_cap_usd,
      api_markup_rate: u.tenants.api_markup_rate,
    },
  };
}

function bearer(req) {
  const h = req.headers.authorization || req.headers.Authorization || '';
  return h.replace('Bearer ', '').trim();
}

// Read and JSON-parse the request body. Vercel does not always populate req.body
// (depends on content-type), so fall back to draining the raw stream manually.
async function readBody(req) {
  let b = req.body;
  if (b == null) {
    const chunks = [];
    await new Promise((resolve) => {
      req.on('data', (c) => chunks.push(typeof c === 'string' ? Buffer.from(c) : c));
      req.on('end', resolve);
      req.on('error', resolve);
    });
    const raw = Buffer.concat(chunks).toString('utf8');
    try { b = JSON.parse(raw); } catch { b = {}; }
  } else if (typeof b === 'string') {
    try { b = JSON.parse(b); } catch { b = {}; }
  } else if (Buffer.isBuffer(b)) {
    try { b = JSON.parse(b.toString('utf8')); } catch { b = {}; }
  }
  return b || {};
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = (req.query && req.query.action) || '';

  // ── TEST (reachability probe) ── any method
  if (action === 'test') {
    return res.status(200).json({ ok: true });
  }

  // ── VALIDATE SESSION ── works over GET or POST (only needs the Bearer token)
  if (action === 'validate') {
    try {
      const token = bearer(req);
      if (!token) return res.status(401).json({ error: 'No token' });

      // Cross-portal access: a valid admin session token loads the tenant portal as the
      // Byline Brands tenant (admins have no separate tenant login). Checked before the
      // tenant-session lookup; a tenant token fails verifyAdminToken and falls through.
      if (verifyAdminToken(token)) {
        try {
          const tr = await fetch(SB_URL + '/rest/v1/tenants?id=eq.' + ADMIN_TENANT_ID +
            '&select=id,name,slug,plan,features,api_cost_cap_usd,api_markup_rate&limit=1', { headers: H });
          if (!tr.ok) console.error('tenant-auth validate(admin): tenant query failed', tr.status, await tr.text().catch(() => ''));
          const tarr = tr.ok ? await tr.json() : [];
          const tenant = Array.isArray(tarr) ? tarr[0] : null;
          if (tenant) {
            const adminUser = { id: 'admin', email: 'admin@tbgsourcing.net', full_name: 'Admin', role: 'admin', tenants: tenant };
            return res.status(200).json({ valid: true, user: userPayload(adminUser, tenant.id) });
          }
          // tenant row missing → fall through to the normal tenant-session check below.
        } catch (e) { console.error('tenant-auth validate(admin): fetch threw', e); }
      }

      let session = null;
      try {
        const r = await fetch(SB_URL + '/rest/v1/tenant_sessions?select=id,tenant_id,expires_at,tenant_users(id,email,full_name,role,is_active,' + TENANT_EMBED + ')' +
          '&token=eq.' + encodeURIComponent(token) + '&limit=1', { headers: H });
        if (!r.ok) console.error('tenant-auth validate: session query failed', r.status, await r.text().catch(() => ''));
        const arr = r.ok ? await r.json() : [];
        session = Array.isArray(arr) ? arr[0] : null;
      } catch (e) { console.error('tenant-auth validate: fetch threw', e); session = null; }

      if (!session || !session.tenant_users) return res.status(401).json({ error: 'Invalid session' });
      if (new Date(session.expires_at) < new Date()) {
        fetch(SB_URL + '/rest/v1/tenant_sessions?token=eq.' + encodeURIComponent(token), { method: 'DELETE', headers: H }).catch(() => {});
        return res.status(401).json({ error: 'Session expired' });
      }
      if (!session.tenant_users.is_active) return res.status(403).json({ error: 'Account inactive' });

      return res.status(200).json({ valid: true, user: userPayload(session.tenant_users, session.tenant_id) });
    } catch (e) {
      console.error('tenant-auth validate: unhandled error', e);
      return res.status(500).json({ error: 'Validation failed' });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── LOGIN ──
  if (action === 'login') {
    try {
      const body = await readBody(req);
      const email = (body.email || '').toLowerCase().trim();
      const password = body.password || '';
      if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

      const hash = hashPassword(password);
      let user = null;
      try {
        const r = await fetch(SB_URL + '/rest/v1/tenant_users?select=id,tenant_id,email,full_name,role,is_active,' + TENANT_EMBED +
          '&email=eq.' + encodeURIComponent(email) + '&password_hash=eq.' + hash + '&limit=1', { headers: H });
        if (!r.ok) console.error('tenant-auth login: Supabase user query failed', r.status, await r.text().catch(() => ''));
        const arr = r.ok ? await r.json() : [];
        user = Array.isArray(arr) ? arr[0] : null;
      } catch (e) { console.error('tenant-auth login: user fetch threw', e); user = null; }

      if (!user || !user.tenants) return res.status(401).json({ error: 'Invalid email or password' });
      if (!user.is_active) return res.status(403).json({ error: 'Account is inactive' });
      if (user.tenants.billing_status === 'suspended') return res.status(403).json({ error: 'Account suspended — contact support' });

      // Create session
      let session = null;
      try {
        const sr = await fetch(SB_URL + '/rest/v1/tenant_sessions?select=token,expires_at', {
          method: 'POST', headers: { ...H, Prefer: 'return=representation' },
          body: JSON.stringify({ tenant_user_id: user.id, tenant_id: user.tenant_id }),
        });
        if (!sr.ok) console.error('tenant-auth login: session insert failed', sr.status, await sr.text().catch(() => ''));
        const sarr = sr.ok ? await sr.json() : [];
        session = Array.isArray(sarr) ? sarr[0] : null;
        if (!sr.ok || !session) return res.status(500).json({ error: 'Session creation failed' });
      } catch (e) { console.error('tenant-auth login: session insert threw', e); return res.status(500).json({ error: 'Session creation failed' }); }

      // Update last login (best-effort)
      fetch(SB_URL + '/rest/v1/tenant_users?id=eq.' + user.id, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
        body: JSON.stringify({ last_login_at: new Date().toISOString() }),
      }).catch(() => {});

      return res.status(200).json({ token: session.token, expires_at: session.expires_at, user: userPayload(user, user.tenant_id) });
    } catch (e) {
      console.error('tenant-auth login: unhandled error', e);
      return res.status(500).json({ error: 'Login failed' });
    }
  }

  // ── LOGOUT ──
  if (action === 'logout') {
    const token = bearer(req);
    if (token) {
      try { await fetch(SB_URL + '/rest/v1/tenant_sessions?token=eq.' + encodeURIComponent(token), { method: 'DELETE', headers: H }); }
      catch (e) { console.error('tenant-auth logout: delete threw', e); }
    }
    return res.status(200).json({ success: true });
  }

  return res.status(400).json({ error: 'Unknown action' });
}
