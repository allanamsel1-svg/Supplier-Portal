// /api/backfill-clearance-placement.js
//
// Server-side runner for the clearance/placement vision backfill (the Anthropic
// key lives here, not locally). Self-contained so Vercel bundles it cleanly.
// The same logic lives in lib/clearance-detect.mjs for the CLI script.
// Processes one bounded batch per request; call repeatedly until remaining = 0.
//
//   GET/POST ?shopOutId=<uuid>&limit=<n>   → one shop-out (re-detect all)
//   GET/POST ?limit=<n>                    → observations with placement_type IS NULL

const SUPABASE_URL = 'https://mjkjubctswjwjihxjpnd.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1qa2p1YmN0c3dqd2ppaHhqcG5kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczNjQxNjcsImV4cCI6MjA5Mjk0MDE2N30.cZrD_ymrDsRPyfX_g3hUui5_JXuW6BgE77QkIoGpqHo';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-6';
const BUCKET = 'shop-out-photos';
const BATCH = 20;
const PLACEMENT_TYPES = ['main_floor', 'clearance', 'checkout_register', 'end_cap', 'display'];
const PROMPT = 'Analyze this retail shelf photo. Determine: (1) is_clearance: true if you see clearance tags, red markdown stickers, clearance signage, or the product is in a clearance bin. clearance_confidence: 0.0-1.0. (2) placement_type: one of main_floor, clearance, checkout_register, end_cap, display. Base placement on visual cues — checkout items are small format near POS, end caps are at aisle ends, displays are freestanding fixtures. Return JSON only: {is_clearance, clearance_confidence, placement_type}';

export const config = { runtime: 'nodejs' };
export const maxDuration = 300;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set in env' });

  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const shopOutId = (req.query && req.query.shopOutId) || (body && body.shopOutId) || null;
    const limit = Number((req.query && req.query.limit) || (body && body.limit) || 60);

    const logs = [];
    const summary = await runBackfill({ shopOutId, limit, log: m => logs.push(m) });
    return res.status(200).json({ success: true, shopOutId: shopOutId || null, ...summary, logs });
  } catch (err) {
    console.error('backfill-clearance-placement error:', err);
    return res.status(500).json({ error: err.message || String(err) });
  }
}

// ─── backfill ────────────────────────────────────────────────────────
async function runBackfill(opts) {
  const log = opts.log || (() => {});
  let q = '/rest/v1/shop_out_observations?select=id,shop_out_id,front_photo_id&front_photo_id=not.is.null&order=created_at.asc';
  if (opts.shopOutId) q += '&shop_out_id=eq.' + opts.shopOutId;
  else q += '&placement_type=is.null';
  if (opts.limit) q += '&limit=' + opts.limit;
  const obs = await (await sb(q)).json();
  if (!Array.isArray(obs) || !obs.length) { log('Nothing to process.'); return { processed: 0, clearance: 0, placement: {}, errors: 0, remaining: 0 }; }

  const fpids = [...new Set(obs.map(o => o.front_photo_id).filter(Boolean))];
  const pathById = {};
  const pr = await sb('/rest/v1/shop_out_photos?id=in.(' + fpids.join(',') + ')&select=id,file_path');
  if (pr.ok) (await pr.json()).forEach(p => { pathById[p.id] = p.file_path; });

  const summary = { processed: 0, clearance: 0, placement: {}, errors: 0 };
  for (let i = 0; i < obs.length; i += BATCH) {
    const batch = obs.slice(i, i + BATCH);
    await Promise.all(batch.map(async o => {
      try {
        const path = pathById[o.front_photo_id]; if (!path) return;
        const b64 = await fetchPhotoB64(path);
        const d = await detect(b64);
        const pt = PLACEMENT_TYPES.includes(d.placement_type) ? d.placement_type : 'main_floor';
        const ic = d.is_clearance === true;
        const pr2 = await sb('/rest/v1/shop_out_observations?id=eq.' + o.id, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_clearance: ic, clearance_confidence: numOrNull(d.clearance_confidence), placement_type: pt })
        });
        if (!pr2.ok) throw new Error('patch ' + pr2.status);
        summary.processed++; if (ic) summary.clearance++;
        summary.placement[pt] = (summary.placement[pt] || 0) + 1;
      } catch (e) { summary.errors++; log('err ' + o.id + ': ' + e.message); }
    }));
    log('processed ' + Math.min(i + BATCH, obs.length) + '/' + obs.length);
  }
  return summary;
}

async function fetchPhotoB64(filePath) {
  const signR = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${filePath}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: 600, transform: { width: 1568, height: 1568, resize: 'contain', quality: 85 } })
  });
  let imageUrl, headers = {};
  if (signR.ok) { imageUrl = `${SUPABASE_URL}/storage/v1${(await signR.json()).signedURL}`; }
  else { imageUrl = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${filePath}`; headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }; }
  const r = await fetch(imageUrl, { headers });
  if (!r.ok) throw new Error(`photo fetch ${r.status}`);
  const buf = await r.arrayBuffer();
  if (buf.byteLength > 4.5 * 1024 * 1024) throw new Error('photo too large after resize');
  return Buffer.from(buf).toString('base64');
}

async function detect(b64) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 300,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
        { type: 'text', text: PROMPT }
      ] }]
    })
  });
  if (!r.ok) throw new Error(`anthropic ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  const text = (data.content || []).map(c => c.text || '').join('\n');
  const fence = text.match(/```json\s*([\s\S]*?)\s*```/);
  const brace = text.match(/(\{[\s\S]*\})/);
  return JSON.parse(fence ? fence[1] : (brace ? brace[1] : text));
}

function sb(path, opts = {}) {
  opts.headers = { ...(opts.headers || {}), apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY };
  return fetch(SUPABASE_URL + path, opts);
}
function numOrNull(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
