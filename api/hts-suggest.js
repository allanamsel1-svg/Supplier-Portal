// api/hts-suggest.js
// Suggest a US HTS code for a product via Claude.
//   POST { product_name, description, category }   Auth: Bearer <tenant session | admin session>
//   → { hts_code, confidence, reasoning, alternative_codes:[] } | { error, message }
// Cost is logged to api_cost_log (1.5x markup) the same way api/tenant-search.js does.
export const config = { runtime: 'nodejs' };

import { createHmac, timingSafeEqual } from 'crypto';

const SB_URL = process.env.SUPABASE_URL || 'https://mjkjubctswjwjihxjpnd.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const H = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' };
const MODEL = 'claude-sonnet-4-6';

const ADMIN_TENANT_ID = 'f64c18ac-c0b4-4bba-a3e6-b64ef0fd3bf4';
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
async function resolveTenantId(token) {
  if (!token) return null;
  if (verifyAdminToken(token)) return ADMIN_TENANT_ID;
  try {
    const r = await fetch(SB_URL + '/rest/v1/tenant_sessions?select=tenant_id,expires_at&token=eq.' + encodeURIComponent(token) + '&limit=1', { headers: H });
    const arr = r.ok ? await r.json() : [];
    const s = Array.isArray(arr) ? arr[0] : null;
    if (s && new Date(s.expires_at) >= new Date()) return s.tenant_id;
  } catch { /* fall through */ }
  return null;
}
function logCost(tid, feature, model, usage) {
  const tin = (usage && usage.input_tokens) || 0, tout = (usage && usage.output_tokens) || 0;
  const haiku = /haiku/i.test(model);
  const costUsd = haiku ? (tin / 1e6) * 0.8 + (tout / 1e6) * 4 : (tin / 1e6) * 3 + (tout / 1e6) * 15;
  fetch(SB_URL + '/rest/v1/api_cost_log', { method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
    body: JSON.stringify({ tenant_id: tid, service: 'anthropic', feature, model, tokens_in: tin, tokens_out: tout, cost_usd: costUsd, cost_usd_marked_up: costUsd * 1.5, prompt_summary: feature }) }).catch(() => {});
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
function parseJson(text) {
  const t = (text || '').trim().replace(/```json|```/g, '').trim();
  try { return JSON.parse(t); } catch { /* try substring */ }
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s !== -1 && e !== -1) { try { return JSON.parse(t.substring(s, e + 1)); } catch { /* give up */ } }
  return null;
}

const SYSTEM = "You are a US customs classification expert. Given a product description, suggest the most appropriate 10-digit HTS code for import into the United States. Return ONLY valid JSON with no markdown: { hts_code: '3304.99.5000', description: 'the official tariff description for that heading, e.g. Vacuum cleaners with self-contained electric motor of a power not exceeding 1,500 W', confidence: 'high', reasoning: 'one sentence', alternative_codes: ['xxxx.xx.xxxx'] }";

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: true, message: 'Method not allowed' });

  try {
    const token = (req.headers.authorization || req.headers.Authorization || '').replace('Bearer ', '').trim();
    const tid = await resolveTenantId(token);
    if (!tid) return res.status(401).json({ error: true, message: 'Unauthorized' });
    if (!ANTHROPIC_KEY) return res.status(200).json({ error: true, message: 'AI service temporarily unavailable.' });

    const body = await readBody(req);
    const name = (body.product_name || '').toString().trim();
    const desc = (body.description || '').toString().trim();
    const cat = (body.category || '').toString().trim();
    if (!name && !desc) return res.status(400).json({ error: true, message: 'Product name or description required' });

    let r, d;
    try {
      r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, max_tokens: 300, system: SYSTEM,
          messages: [{ role: 'user', content: 'Product: ' + (name || '(unnamed)') + '. Description: ' + (desc || '(none)') + '. Category: ' + (cat || '(none)') }] }),
      });
      d = await r.json().catch(() => ({}));
    } catch (e) { return res.status(200).json({ error: true, message: 'AI request failed' }); }

    if (!r.ok) return res.status(200).json({ error: true, message: (d && d.error && d.error.message) || ('AI error ' + r.status) });

    logCost(tid, 'hts_suggest', MODEL, d.usage);

    const parsed = parseJson((d.content && d.content[0] && d.content[0].text) || '');
    if (!parsed || !parsed.hts_code) return res.status(200).json({ error: true, message: 'Could not parse AI response' });
    return res.status(200).json(parsed);
  } catch (e) {
    return res.status(200).json({ error: true, message: 'Suggestion failed' });
  }
}
