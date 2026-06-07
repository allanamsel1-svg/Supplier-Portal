// POLICY: Never reference "Claude" or "Anthropic" in any user-facing text, labels, messages, or UI elements.
// /api/classify-shop-out-photo.js
//
// Classifies a single shop-out photo as either:
//   'section' — a wide-angle shot of a shelf run / aisle / department signage
//   'product' — a close-up of one or two individual product packages
//
// Updates shop_out_photos.photo_type with the result and returns the
// classification so the browser pipeline can route the photo.
//
// IMAGES: resized to 1568px max edge via the Supabase image transform so we
// stay well under Anthropic's 5MB cap regardless of original size/format.

const SUPABASE_URL = 'https://mjkjubctswjwjihxjpnd.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
  || process.env.SUPABASE_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1qa2p1YmN0c3dqd2ppaHhqcG5kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczNjQxNjcsImV4cCI6MjA5Mjk0MDE2N30.cZrD_ymrDsRPyfX_g3hUui5_JXuW6BgE77QkIoGpqHo';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-6';

export const config = { runtime: 'nodejs' };
export const maxDuration = 60;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'AI service is not configured.' });

  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const { photo_id, shop_out_id } = body || {};
    if (!photo_id) return res.status(400).json({ error: 'Missing required field: photo_id' });

    // 1. Resolve the photo's storage path
    const photo = await fetchPhotoRow(photo_id);
    if (!photo || !photo.file_path) {
      return res.status(404).json({ error: `Photo not found or has no file_path: ${photo_id}` });
    }

    // 2. Fetch a resized base64 of the image
    const b64 = await fetchPhotoResizedAsBase64(photo.file_path);

    // 3. Ask Claude to classify
    const content = [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
      { type: 'text', text: buildPrompt() }
    ];

    const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 512,
        messages: [{ role: 'user', content }]
      })
    });

    if (!aiResp.ok) {
      const errText = await aiResp.text();
      throw new Error(`AI service error ${aiResp.status}: ${errText}`);
    }

    const aiData = await aiResp.json();
    const responseText = (aiData.content || []).map(c => c.text || '').join('\n');

    // 4. Parse JSON
    const extracted = parseJsonLoose(responseText);
    if (!extracted) throw new Error('AI returned unparseable JSON: ' + responseText.slice(0, 500));

    // Normalize — anything that isn't explicitly 'section' is treated as 'product'.
    const classification = extracted.classification === 'section' ? 'section' : 'product';
    const confidence = numOrNull(extracted.confidence);
    const reasoning = extracted.reasoning || null;

    // 5. Persist photo_type
    const upd = await sbFetch(`/rest/v1/shop_out_photos?id=eq.${photo_id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ photo_type: classification })
    });
    if (!upd.ok) {
      const errText = await upd.text();
      throw new Error(`Photo update failed (${upd.status}): ${errText}`);
    }

    return res.status(200).json({ photo_id, classification, confidence, reasoning });

  } catch (err) {
    console.error('classify-shop-out-photo error:', err);
    return res.status(500).json({ error: err.message || String(err) });
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────────

function buildPrompt() {
  return `You are classifying a single photo taken during a competitive-intelligence shop-out at a retail store.

Classify the photo as exactly one of:
- "section": a WIDE-ANGLE shot showing a shelf run, multiple products together, a store aisle, an end-cap, a planogram, or department signage. The intent is to capture how a category is merchandised, not one specific item.
- "product": a CLOSE-UP of one or two individual product packages, where the goal is to read a single item's branding, pack, or price sticker.

When in doubt between the two, lean on the dominant intent: many distinct products spanning shelf width = section; one or two items filling the frame = product.

Return STRICTLY a single JSON object, no prose, no markdown fences:

{
  "classification": "section" | "product",
  "confidence": 0.0-1.0,
  "reasoning": "one short sentence explaining the call"
}`;
}

async function fetchPhotoRow(photoId) {
  const r = await sbFetch(`/rest/v1/shop_out_photos?id=eq.${photoId}&select=id,file_path,photo_sequence_number`);
  if (!r.ok) throw new Error(`Photo row fetch failed (${r.status})`);
  const rows = await r.json();
  return rows[0] || null;
}

async function fetchPhotoResizedAsBase64(path) {
  const signR = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/shop-out-photos/${path}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      expiresIn: 600,
      transform: { width: 1568, height: 1568, resize: 'contain', quality: 85 }
    })
  });

  let imageUrl;
  if (signR.ok) {
    const signData = await signR.json();
    imageUrl = `${SUPABASE_URL}/storage/v1${signData.signedURL}`;
  } else {
    console.warn(`Sign with transform failed (${signR.status}), falling back to original`);
    imageUrl = `${SUPABASE_URL}/storage/v1/object/shop-out-photos/${path}`;
  }

  const r = await fetch(imageUrl, {
    headers: signR.ok ? {} : { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  });
  if (!r.ok) throw new Error(`Image fetch failed (${r.status}): ${path}`);
  const buf = await r.arrayBuffer();
  if (buf.byteLength > 4.5 * 1024 * 1024) {
    throw new Error(`Image still too large after resize: ${buf.byteLength} bytes`);
  }
  return Buffer.from(buf).toString('base64');
}

function parseJsonLoose(text) {
  const fenceMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  const braceMatch = text.match(/(\{[\s\S]*\})/);
  const jsonText = fenceMatch ? fenceMatch[1] : (braceMatch ? braceMatch[1] : text);
  try { return JSON.parse(jsonText); } catch (e) { return null; }
}

function sbFetch(path, opts = {}) {
  opts.headers = opts.headers || {};
  opts.headers.apikey = SUPABASE_KEY;
  opts.headers.Authorization = `Bearer ${SUPABASE_KEY}`;
  return fetch(`${SUPABASE_URL}${path}`, opts);
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
