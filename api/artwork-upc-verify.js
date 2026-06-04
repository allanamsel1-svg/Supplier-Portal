// ============================================================
// /api/artwork-upc-verify.js
// Verifies the UPC declared on an artwork version against the brief UPC.
// Auth: Bearer tenant/designer session token.
//
// POST { version_id, upc_on_artwork, upc_from_brief }
//   → { match, upc_valid, upc_format, issues }
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY
// ============================================================
export const config = { runtime: 'nodejs' };

const SB_URL = process.env.SUPABASE_URL || 'https://mjkjubctswjwjihxjpnd.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-6';
const H = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' };

function readBody(req) { let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } } return b || {}; }
function bearer(req) { return (req.headers.authorization || req.headers.Authorization || '').replace('Bearer ', '').trim(); }
async function sbGet(path) { const r = await fetch(SB_URL + '/rest/v1/' + path, { headers: H }); if (!r.ok) return []; const d = await r.json(); return Array.isArray(d) ? d : []; }
async function sbPatch(path, body) { return (await fetch(SB_URL + '/rest/v1/' + path, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(body) })).ok; }
function extractJson(t) { let c = (t || '').trim().replace(/```json|```/g, '').trim(); const s = c.indexOf('{'), e = c.lastIndexOf('}'); if (s === -1 || e === -1) throw new Error('no json'); return JSON.parse(c.substring(s, e + 1)); }
function logMetric(metric_type, metric_value, cohort) {
  fetch(SB_URL + '/rest/v1/platform_metrics_log', { method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
    body: JSON.stringify({ metric_type, metric_value, cohort: cohort || null, recorded_at: new Date().toISOString() }) }).catch(() => {});
}
async function validSession(req) {
  const token = bearer(req); if (!token) return null;
  const arr = await sbGet('tenant_sessions?select=tenant_id,expires_at&token=eq.' + encodeURIComponent(token) + '&limit=1');
  const s = arr[0]; if (!s || new Date(s.expires_at) < new Date()) return null; return s;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!SB_KEY) return res.status(500).json({ error: 'Service temporarily unavailable. Please try again.' });
  if (!(await validSession(req))) return res.status(401).json({ error: 'Unauthorized' });

  const { version_id, upc_on_artwork, upc_from_brief } = readBody(req);
  if (!version_id) return res.status(400).json({ error: 'Missing version_id.' });

  const artwork = String(upc_on_artwork || '').trim();
  const brief = String(upc_from_brief || '').trim();
  let result = { match: artwork !== '' && artwork === brief, upc_valid: /^\d{12,13}$/.test(artwork), upc_format: artwork.length === 12 ? 'UPC-A' : artwork.length === 13 ? 'EAN-13' : 'invalid', issues: [] };

  // AI verification (best-effort; falls back to the deterministic comparison above).
  if (ANTHROPIC_KEY) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, max_tokens: 400,
          system: 'You are a product packaging QA specialist. Verify the UPC barcode information provided.',
          messages: [{ role: 'user', content: `The design brief specifies UPC: ${brief}. The designer has declared the UPC on the artwork as: ${artwork}. Do these match? Also assess if the UPC format is valid (should be 12 digits for UPC-A or 13 digits for EAN-13). Return JSON only: { "match": boolean, "upc_valid": boolean, "upc_format": "UPC-A"|"EAN-13"|"invalid", "issues": [] }` }] }),
      });
      if (r.ok) { const d = await r.json(); const ext = extractJson((d.content && d.content[0] && d.content[0].text) || ''); if (ext && typeof ext.match === 'boolean') result = { match: ext.match, upc_valid: !!ext.upc_valid, upc_format: ext.upc_format || result.upc_format, issues: Array.isArray(ext.issues) ? ext.issues : [] }; }
    } catch (e) { console.error('artwork-upc-verify ai error:', e.message); }
  }

  try {
    await sbPatch('artwork_versions?id=eq.' + encodeURIComponent(version_id), {
      upc_on_artwork: artwork || null, upc_ai_verified: true, upc_ai_verified_at: new Date().toISOString(), upc_ai_result: result,
    });
    if (result.match) {
      const vr = await sbGet('artwork_versions?id=eq.' + encodeURIComponent(version_id) + '&select=artwork_project_id&limit=1');
      if (vr[0]) await sbPatch('artwork_projects?id=eq.' + encodeURIComponent(vr[0].artwork_project_id), { upc_verified: true, upc_verified_at: new Date().toISOString() });
    }
    logMetric('artwork_upc_verify', result.match ? 1 : 0, result.upc_format);
    return res.status(200).json(result);
  } catch (err) {
    console.error('artwork-upc-verify error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
