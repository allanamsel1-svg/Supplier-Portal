// api/tenant-auth.js
// Tenant user login, session validation, logout.
//
// Implemented in the portal's proven serverless style (ESM `export default` +
// native fetch to Supabase PostgREST with the service key) — the repo has no
// package.json / @supabase/supabase-js installed, so the SDK is unavailable here.
// Behaviour and JSON contracts are identical to the spec.
//
//   POST /api/tenant-auth?action=login    { email, password } → { token, expires_at, user }
//   POST /api/tenant-auth?action=validate (Bearer token)      → { valid, user }
//   POST /api/tenant-auth?action=logout   (Bearer token)      → { success }
export const config = { runtime: 'nodejs' };

import { createHash } from 'crypto';

const SB_URL = process.env.SUPABASE_URL || 'https://mjkjubctswjwjihxjpnd.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const H = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' };

function hashPassword(password) {
  // NOTE: correct precedence — defaults to 'tbg-salt-2026' when the env var is unset.
  const salt = process.env.TENANT_PASSWORD_SALT || 'tbg-salt-2026';
  return createHash('sha256').update(password + salt).digest('hex');
}

const TENANT_EMBED = 'tenants(name,slug,plan,billing_status,features)';

function userPayload(u, tenantId) {
  return {
    id: u.id,
    email: u.email,
    full_name: u.full_name,
    role: u.role,
    tenant: {
      id: tenantId,
      name: u.tenants.name,
      slug: u.tenants.slug,
      plan: u.tenants.plan,
      features: u.tenants.features,
    },
  };
}

function bearer(req) {
  const h = req.headers.authorization || req.headers.Authorization || '';
  return h.replace('Bearer ', '').trim();
}

async function readBody(req) {
  let b = req.body;
  if (b == null) {
    const chunks = [];
    await new Promise((res) => { req.on('data', (c) => chunks.push(c)); req.on('end', res); req.on('error', res); });
    const raw = Buffer.concat(chunks).toString('utf8');
    try { b = JSON.parse(raw); } catch { b = {}; }
  } else if (typeof b === 'string') {
    try { b = JSON.parse(b); } catch { b = {}; }
  }
  return b || {};
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const action = (req.query && req.query.action) || '';

  // ── LOGIN ──
  if (action === 'login') {
    const body = await readBody(req);
    const email = (body.email || '').toLowerCase().trim();
    const password = body.password || '';
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const hash = hashPassword(password);
    let user = null;
    try {
      const r = await fetch(SB_URL + '/rest/v1/tenant_users?select=id,tenant_id,email,full_name,role,is_active,' + TENANT_EMBED +
        '&email=eq.' + encodeURIComponent(email) + '&password_hash=eq.' + hash + '&limit=1', { headers: H });
      const arr = r.ok ? await r.json() : [];
      user = Array.isArray(arr) ? arr[0] : null;
    } catch { user = null; }

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
      const sarr = sr.ok ? await sr.json() : [];
      session = Array.isArray(sarr) ? sarr[0] : null;
      if (!sr.ok || !session) return res.status(500).json({ error: 'Session creation failed' });
    } catch { return res.status(500).json({ error: 'Session creation failed' }); }

    // Update last login (best-effort)
    fetch(SB_URL + '/rest/v1/tenant_users?id=eq.' + user.id, {
      method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
      body: JSON.stringify({ last_login_at: new Date().toISOString() }),
    }).catch(() => {});

    return res.status(200).json({ token: session.token, expires_at: session.expires_at, user: userPayload(user, user.tenant_id) });
  }

  // ── VALIDATE SESSION ──
  if (action === 'validate') {
    const token = bearer(req);
    if (!token) return res.status(401).json({ error: 'No token' });

    let session = null;
    try {
      const r = await fetch(SB_URL + '/rest/v1/tenant_sessions?select=id,tenant_id,expires_at,tenant_users(id,email,full_name,role,is_active,' + TENANT_EMBED + ')' +
        '&token=eq.' + encodeURIComponent(token) + '&limit=1', { headers: H });
      const arr = r.ok ? await r.json() : [];
      session = Array.isArray(arr) ? arr[0] : null;
    } catch { session = null; }

    if (!session || !session.tenant_users) return res.status(401).json({ error: 'Invalid session' });
    if (new Date(session.expires_at) < new Date()) {
      fetch(SB_URL + '/rest/v1/tenant_sessions?token=eq.' + encodeURIComponent(token), { method: 'DELETE', headers: H }).catch(() => {});
      return res.status(401).json({ error: 'Session expired' });
    }
    if (!session.tenant_users.is_active) return res.status(403).json({ error: 'Account inactive' });

    return res.status(200).json({ valid: true, user: userPayload(session.tenant_users, session.tenant_id) });
  }

  // ── LOGOUT ──
  if (action === 'logout') {
    const token = bearer(req);
    if (token) {
      try { await fetch(SB_URL + '/rest/v1/tenant_sessions?token=eq.' + encodeURIComponent(token), { method: 'DELETE', headers: H }); } catch {}
    }
    return res.status(200).json({ success: true });
  }

  return res.status(400).json({ error: 'Unknown action' });
}
