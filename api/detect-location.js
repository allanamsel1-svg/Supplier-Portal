// ════════════════════════════════════════════════════════════════════
// /api/detect-location.js
//
// Reads storefront photos to detect store location.
// Uses URL-based image source so Anthropic fetches directly — works for
// images of any size including HEIC.
// ════════════════════════════════════════════════════════════════════

export const config = { runtime: 'nodejs' };
export const maxDuration = 60;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const BUCKET = 'shop-out-photos';
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

async function sb(path, opts = {}) {
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...(opts.headers || {})
  };
  const r = await fetch(`${SUPABASE_URL}${path}`, { ...opts, headers });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  if (r.status === 204) return null;
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

async function signUrl(filePath) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${filePath}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ expiresIn: 3600 })
  });
  if (!r.ok) throw new Error(`Sign URL ${r.status}`);
  const data = await r.json();
  return `${SUPABASE_URL}/storage/v1${data.signedURL}`;
}

async function fetchImageForClaude(filePath) {
  const url = await signUrl(filePath);
  // Check size first
  try {
    const head = await fetch(url, { method: 'HEAD' });
    const sizeHeader = head.headers.get('content-length');
    const size = sizeHeader ? parseInt(sizeHeader, 10) : null;
    if (size && size <= MAX_IMAGE_BYTES) {
      // Small — fetch and send as base64
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Image fetch ${r.status}`);
      const buf = await r.arrayBuffer();
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: Buffer.from(buf).toString('base64')
        }
      };
    }
  } catch (e) {
    // Fall through to URL mode
  }
  // Large or HEAD failed — let Anthropic fetch via URL (they auto-resize)
  return {
    type: 'image',
    source: { type: 'url', url: url }
  };
}

async function claudeMessage(messages, maxTokens = 800) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: maxTokens, messages })
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${await r.text()}`);
  return r.json();
}

function extractJson(text) {
  let cleaned = text.replace(/```json|```/g, '').trim();
  const firstBrace = cleaned.indexOf('{');
  if (firstBrace === -1) throw new Error('No JSON');
  cleaned = cleaned.substring(firstBrace);
  const lastBrace = cleaned.lastIndexOf('}');
  return JSON.parse(cleaned.substring(0, lastBrace + 1));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  if (!SUPABASE_URL || !SUPABASE_KEY || !ANTHROPIC_KEY) {
    return res.status(500).json({ error: 'Missing env vars' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const { shop_out_id } = body || {};
  if (!shop_out_id) return res.status(400).json({ error: 'shop_out_id required' });

  try {
    const shops = await sb(`/rest/v1/shop_outs?id=eq.${shop_out_id}&select=customer_id`);
    if (!shops || shops.length === 0) return res.status(404).json({ error: 'Not found' });

    let retailerName = null;
    if (shops[0].customer_id) {
      const cust = await sb(`/rest/v1/customers?id=eq.${shops[0].customer_id}&select=customer_name`);
      if (cust && cust.length > 0) retailerName = cust[0].customer_name;
    }

    // Prefer storefront-tagged photos; if none, use first 5 photos
    let photos = await sb(`/rest/v1/shop_out_photos?shop_out_id=eq.${shop_out_id}&group_role=eq.storefront&limit=5&select=*`);
    if (!photos || photos.length === 0) {
      photos = await sb(`/rest/v1/shop_out_photos?shop_out_id=eq.${shop_out_id}&order=photo_sequence_number.asc&limit=5&select=*`);
    }

    if (!photos || photos.length === 0) return res.status(200).json({ error: 'No photos' });

    const content = [];
    for (const p of photos) {
      try {
        const imgBlock = await fetchImageForClaude(p.file_path);
        content.push(imgBlock);
      } catch (err) { console.warn(`Skip: ${err.message}`); }
    }
    if (content.length === 0) return res.status(200).json({ error: 'No loadable images' });

    content.push({
      type: 'text',
      text: `These are photos from a ${retailerName || 'retail'} store visit. Look for visible: store address, street name, mall/plaza name, neighborhood, city, state, ZIP code, or geographic markers on signs, receipts, or fixtures. Also confirm the retailer name visible in signage.

Return ONLY JSON:
{
  "location": "Best location string, e.g. 'East Brunswick, NJ' or 'Garden State Plaza, Paramus NJ' — null if no markers visible",
  "address": "Full street address if visible, else null",
  "retailer_confirmed": "Retailer name from signage if visible, else null",
  "confidence": 0.0 to 1.0
}`
    });

    const resp = await claudeMessage([{ role: 'user', content }], 600);
    const parsed = extractJson(resp.content[0].text);

    const updates = {};
    if (parsed.location) updates.store_location_text = parsed.location;
    if (parsed.retailer_confirmed) updates.retailer_detected_via = 'storefront_ai';

    if (Object.keys(updates).length > 0) {
      await sb(`/rest/v1/shop_outs?id=eq.${shop_out_id}`, {
        method: 'PATCH',
        body: JSON.stringify(updates)
      });
    }

    return res.status(200).json({
      location: parsed.location,
      address: parsed.address,
      retailer_confirmed: parsed.retailer_confirmed,
      confidence: parsed.confidence,
      photos_analyzed: content.length - 1
    });
  } catch (err) {
    console.error('[detect-location] fatal:', err);
    return res.status(500).json({ error: err.message });
  }
}
