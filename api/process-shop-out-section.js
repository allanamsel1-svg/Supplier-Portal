// /api/process-shop-out-section.js
//
// Analyzes one wide-angle "section" photo (a shelf run / aisle / department)
// from a shop-out via Anthropic Vision, inserts a shop_out_sections row, and
// marks the photo as a section.
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
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set in env' });

  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const { photo_id, shop_out_id } = body || {};
    if (!photo_id || !shop_out_id) {
      return res.status(400).json({ error: 'Missing required fields: photo_id, shop_out_id' });
    }

    // 1. Resolve the photo's storage path + sequence
    const photo = await fetchPhotoRow(photo_id);
    if (!photo || !photo.file_path) {
      return res.status(404).json({ error: `Photo not found or has no file_path: ${photo_id}` });
    }

    // 2. Fetch a resized base64 of the image
    const b64 = await fetchPhotoResizedAsBase64(photo.file_path);

    // 3. Ask Claude to analyze the section
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
        max_tokens: 3072,
        messages: [{ role: 'user', content }]
      })
    });

    if (!aiResp.ok) {
      const errText = await aiResp.text();
      throw new Error(`Anthropic API ${aiResp.status}: ${errText}`);
    }

    const aiData = await aiResp.json();
    const responseText = (aiData.content || []).map(c => c.text || '').join('\n');

    // 4. Parse JSON
    const extracted = parseJsonLoose(responseText);
    if (!extracted) throw new Error('AI returned unparseable JSON: ' + responseText.slice(0, 500));

    // 5. Build + insert section row
    const sectionPayload = {
      shop_out_id,
      section_photo_id: photo_id,
      department: extracted.department || null,
      category_detected: extracted.category_detected || null,
      estimated_linear_feet: numOrNull(extracted.estimated_linear_feet),
      brand_summary: Array.isArray(extracted.brands) ? extracted.brands : (extracted.brands || null),
      ai_confidence: numOrNull(extracted.overall_confidence),
      ai_extraction_json: extracted,
      sequence_number: photo.photo_sequence_number != null ? photo.photo_sequence_number : null
    };

    const insR = await sbFetch('/rest/v1/shop_out_sections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify(sectionPayload)
    });
    if (!insR.ok) {
      const errText = await insR.text();
      throw new Error(`Section insert failed (${insR.status}): ${errText}`);
    }
    const inserted = await insR.json();
    const sectionId = inserted[0] && inserted[0].id;

    // 6. Mark the photo as a section and link it back to the new row
    await sbFetch(`/rest/v1/shop_out_photos?id=eq.${photo_id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        photo_type: 'section',
        section_id: sectionId || null,
        ai_processed_at: new Date().toISOString()
      })
    });

    return res.status(200).json({ success: true, section: inserted[0], extracted });

  } catch (err) {
    console.error('process-shop-out-section error:', err);
    return res.status(500).json({ error: err.message || String(err) });
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────────

function buildPrompt() {
  return `You're analyzing a single WIDE-ANGLE photo of a retail shelf, aisle, end-cap, or department captured during a competitive-intelligence shop-out at an off-price / discount chain. The goal is to understand how this section is merchandised — NOT to read one specific product.

Examine the visible shelving and return STRICTLY a single JSON object (no prose, no markdown fences):

{
  "department": "string — e.g. Beauty, HBC, Apparel, Home, Food, Toys, Electronics, Other",
  "category_detected": "string — the dominant category on display, e.g. 'Skincare', 'Hair Care', 'Snacks', 'Bath Towels'. Use the most specific category that covers most of the shelf.",
  "estimated_linear_feet": "number — estimate the linear shelf width visible in feet. A standard gondola/shelf unit bay is ~4 ft wide; use that as your unit of measure (e.g. one bay ≈ 4, two bays ≈ 8). If the width is unclear, assume a single 4 ft unit.",
  "brands": [
    {
      "brand_name": "string — brand as printed",
      "product_type": "string — what kind of product (e.g. 'face serum', 'shampoo')",
      "distinct_skus_visible": "number — count of visibly distinct SKUs for this brand",
      "facing_count": "number — total shelf facings (product fronts) for this brand",
      "price_points_seen": "array of numbers — distinct retail prices visible for this brand (empty array if none legible)",
      "notes": "string or null — anything notable (promo tag, end-cap, premium placement)"
    }
  ],
  "shelf_organization": "string — describe how the section is organized (by brand, by price, by product type, planogram quality, eye-level placement, etc.)",
  "overall_confidence": "number 0.0-1.0 — your confidence in this section read",
  "analysis_notes": "string — call out anything unusual: messy/disorganized shelf, obscured or out-of-stock product, items clearly in the wrong place, glare, partial view, etc."
}

Be conservative with counts — only count what you can actually see. Use an empty array for brands if no brands are legible. CRITICAL: output a single JSON object only.`;
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
