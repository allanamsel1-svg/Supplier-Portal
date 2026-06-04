// ============================================================
// /api/tenant-user-create.js
// Admin-only: create a tenant_users record (e.g. a designer account).
// Auth: Authorization: Bearer <admin_session HMAC token>.
//
// POST { tenant_id, full_name, email, password, role }
//   → { success:true, user_id }
//
// NOTE: password hashing matches api/tenant-auth.js exactly (SHA256 of
// password + TENANT_PASSWORD_SALT). The login endpoint hashes the same way,
// so anything else would 401 on login.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_PASSWORD/ADMIN_SESSION_SECRET, TENANT_PASSWORD_SALT
// ============================================================
export const config = { runtime: 'nodejs' };

import { createHash, createHmac, timingSafeEqual } from 'crypto';

const SB_URL = process.env.SUPABASE_URL || 'https://mjkjubctswjwjihxjpnd.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const H = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' };

function readBody(req) { let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } } return b || {}; }
function bearer(req) { return (req.headers.authorization || req.headers.Authorization || '').replace('Bearer ', '').trim(); }
function hashPassword(password) {
  const salt = process.env.TENANT_PASSWORD_SALT || 'tbg-salt-2026';
  return createHash('sha256').update(password + salt).digest('hex');
}
function verifyAdminToken(token, key) {
  if (!token || typeof token !== 'string' || token.indexOf('.') === -1) return false;
  const [payload, sig] = token.split('.');
  const expected = createHmac('sha256', key).update(payload).digest('base64url');
  if (!sig || sig.length !== expected.length) return false;
  try { if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false; } catch { return false; }
  try { const obj = JSON.parse(Buffer.from(payload, 'base64url').toString()); return !obj.exp || Date.now() < obj.exp; } catch { return false; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!SB_KEY) return res.status(500).json({ error: 'Service temporarily unavailable. Please try again.' });

  // Admin auth (HMAC token). Skip only when ADMIN_PASSWORD is unconfigured (legacy mode).
  const PASS = process.env.ADMIN_PASSWORD != null ? String(process.env.ADMIN_PASSWORD).trim() : null;
  const KEY = String(process.env.ADMIN_SESSION_SECRET || PASS || '').trim();
  if (PASS && !verifyAdminToken(bearer(req), KEY)) return res.status(401).json({ error: 'Unauthorized' });

  const body = readBody(req);
  const tenant_id = body.tenant_id;
  const full_name = (body.full_name || '').trim();
  const email = (body.email || '').toLowerCase().trim();
  const password = body.password || '';
  const role = (body.role || 'designer').trim();
  if (!tenant_id || !email || !password) return res.status(400).json({ error: 'Missing tenant_id, email, or password.' });

  try {
    // Reject duplicate emails.
    const existing = await fetch(SB_URL + '/rest/v1/tenant_users?email=eq.' + encodeURIComponent(email) + '&select=id&limit=1', { headers: H });
    const earr = existing.ok ? await existing.json() : [];
    if (Array.isArray(earr) && earr.length) return res.status(409).json({ error: 'A user with that email already exists.' });

    const r = await fetch(SB_URL + '/rest/v1/tenant_users', {
      method: 'POST', headers: { ...H, Prefer: 'return=representation' },
      body: JSON.stringify({ tenant_id, full_name: full_name || null, email, password_hash: hashPassword(password), role, is_active: true }),
    });
    if (!r.ok) return res.status(500).json({ error: 'Could not create user: ' + (await r.text()).slice(0, 200) });
    const arr = await r.json();
    const user = Array.isArray(arr) ? arr[0] : arr;
    return res.status(200).json({ success: true, user_id: user && user.id });
  } catch (err) {
    console.error('tenant-user-create error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
