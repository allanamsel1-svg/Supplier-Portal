// api/hts-lookup.js
// Server-side proxy for USITC HTS lookups (avoids browser CORS).
//   GET  /api/hts-lookup?hts_code=3304995000
//   POST { hts_code }                         Auth: Bearer <tenant session | admin session>
//   → raw USITC JSON | { error: true, message: 'Lookup failed' }
// No AI call, no cost logging — pure proxy.
export const config = { runtime: 'nodejs' };

import { createHmac, timingSafeEqual } from 'crypto';

const SB_URL = process.env.SUPABASE_URL || 'https://mjkjubctswjwjihxjpnd.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const H = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' };

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
async function isAuthed(token) {
  if (!token) return false;
  if (verifyAdminToken(token)) return true;
  try {
    const r = await fetch(SB_URL + '/rest/v1/tenant_sessions?select=expires_at&token=eq.' + encodeURIComponent(token) + '&limit=1', { headers: H });
    const arr = r.ok ? await r.json() : [];
    const s = Array.isArray(arr) ? arr[0] : null;
    return !!(s && new Date(s.expires_at) >= new Date());
  } catch { return false; }
}
async function readBody(req) {
  let b = req.body;
  if (b == null) {
    const chunks = [];
    await new Promise((resolve) => { req.on('data', c => chunks.push(typeof c === 'string' ? Buffer.from(c) : c)); req.on('end', resolve); req.on('error', resolve); });
    try { b = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { b = {}; }
  } else if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
  else if (Buffer.isBuffer(b)) { try { b = JSON.parse(b.toString('utf8')); } catch { b = {}; } }
  return b || {};
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: true, message: 'Method not allowed' });

  try {
    const token = (req.headers.authorization || req.headers.Authorization || '').replace('Bearer ', '').trim();
    if (!(await isAuthed(token))) return res.status(401).json({ error: true, message: 'Unauthorized' });

    let code = '';
    if (req.method === 'GET') code = (req.query && (req.query.hts_code || req.query.code)) || '';
    else { const body = await readBody(req); code = body.hts_code || body.code || ''; }
    code = String(code).trim().replace(/\./g, '');
    if (!code) return res.status(400).json({ error: true, message: 'hts_code required' });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    let r, d;
    try {
      r = await fetch('https://hts.usitc.gov/reststop/api/details/getSection?query=' + encodeURIComponent(code), { signal: controller.signal });
      d = await r.json();
    } catch (e) {
      return res.status(200).json({ error: true, message: 'Lookup failed' });
    } finally { clearTimeout(timer); }

    if (!r.ok) return res.status(200).json({ error: true, message: 'Lookup failed' });
    return res.status(200).json(d);
  } catch (e) {
    return res.status(200).json({ error: true, message: 'Lookup failed' });
  }
}
