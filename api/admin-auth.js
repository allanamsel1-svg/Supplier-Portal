// /api/admin-auth.js
//
// Server-side admin authentication. The password is NOT in client code or the
// repo — it lives only in Vercel env vars:
//   ADMIN_PASSWORD        (required)  the admin login password
//   ADMIN_USERNAME        (optional)  defaults to 'admin'
//   ADMIN_SESSION_SECRET  (optional)  HMAC key for session tokens; falls back to
//                                     ADMIN_PASSWORD (so rotating the password
//                                     invalidates existing sessions).
//
//   POST ?action=login   { username, password } → { ok, token } | { ok:false }
//   POST ?action=verify  { token }              → { ok }
//
// Transitional safety: until ADMIN_PASSWORD is set in Vercel, every response is
// { ok:false, unconfigured:true } and the client stays in its lenient legacy
// mode — so deploying this never locks out an existing admin session.

import { createHmac, timingSafeEqual } from 'crypto';

export const config = { runtime: 'nodejs' };

function eq(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
function sign(payloadObj, key) {
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const sig = createHmac('sha256', key).update(payload).digest('base64url');
  return payload + '.' + sig;
}
function verifyToken(token, key) {
  if (!token || typeof token !== 'string' || token.indexOf('.') === -1) return false;
  const [payload, sig] = token.split('.');
  const expected = createHmac('sha256', key).update(payload).digest('base64url');
  if (!sig || sig.length !== expected.length) return false;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  try {
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return !obj.exp || Date.now() < obj.exp;
  } catch { return false; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const PASS = process.env.ADMIN_PASSWORD;
  const USER = process.env.ADMIN_USERNAME || 'admin';
  const KEY = process.env.ADMIN_SESSION_SECRET || PASS || '';

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  const action = (req.query && req.query.action) || body.action || 'login';

  // Not yet configured → tell the client to stay in lenient legacy mode.
  if (!PASS) return res.status(200).json({ ok: false, unconfigured: true });

  if (action === 'verify') {
    return res.status(200).json({ ok: verifyToken(body.token, KEY) });
  }
  // login
  if (eq(body.username || '', USER) && eq(body.password || '', PASS)) {
    const token = sign({ exp: Date.now() + 30 * 24 * 3600 * 1000 }, KEY);
    return res.status(200).json({ ok: true, token });
  }
  return res.status(200).json({ ok: false });
}
