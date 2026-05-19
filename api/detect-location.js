// ════════════════════════════════════════════════════════════════════
// /api/detect-location.js
//
// Uses Claude vision on storefront photos to detect store location.
// Reads visible signs, street names, mall names, addresses.
// ════════════════════════════════════════════════════════════════════

export const config = { runtime: 'nodejs' };
export const maxDuration = 60;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const BUCKET = 'shop-out-photos';
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';

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

async function imgUrlToBase64(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Image fetch ${r.status}`);
  const buf = await r.arrayBuffer();
  return Buffer.from(buf).toString('base64');
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
  cleaned = cleaned.substring(0, lastBrace + 1);
  return JSON.parse(cleaned);
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
    // Get retailer name
    const shops = await sb(`/rest/v1/shop_outs?id=eq.${shop_out_id}&select=customer_id`);
    if (!shops || shops.length === 0) return res.status(404).json({ error: 'Not found' });

    let retailerName = null;
    if (shops[0].customer_id) {
      const cust = await sb(`/rest/v1/customers?id=eq.${shops[0].customer_id}&select=customer_name`);
      if (cust && cust.length > 0) retailerName = cust[0].customer_name;
    }

    // Get up to 5 storefront photos
    let photos = await sb(`/rest/v1/shop_out_photos?shop_out_id=eq.${shop_out_id}&group_role=eq.storefront&limit=5&select=*`);

    // Fallback: if no storefront photos, use first 3 photos (might catch a sign in product shots)
    if (!photos || photos.length === 0) {
      photos = await sb(`/rest/v1/shop_out_photos?shop_out_id=eq.${shop_out_id}&order=photo_sequence_number.asc&limit=3&select=*`);
    }

    if (!photos || photos.length === 0) {
      return res.status(200).json({ message: 'No photos to analyze' });
    }

    // Build vision request
    const content = [];
    for (const p of photos) {
      try {
        const url = await signUrl(p.file_path);
        const base64 = await imgUrlToBase64(url);
        content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } });
      } catch (err) { console.warn(`Skip photo: ${err.message}`); }
    }

    if (content.length === 0) return res.status(200).json({ message: 'No images could be loaded' });

    content.push({
      type: 'text',
      text: `These are storefront/exterior/aisle photos from a ${retailerName || 'retail'} store visit.

Look carefully for: visible store address, street name, mall name, plaza name, neighborhood, city, state, or any geographic markers in signs or storefront text.

Also identify and confirm the retailer name visible in signage.

Return ONLY JSON:
{
  "location": "Best location description, e.g. 'East Brunswick, NJ' or 'Garden State Plaza, Paramus NJ' or 'NYC' — null if no location markers visible",
  "address": "Full street address if visible, else null",
  "retailer_confirmed": "Confirmed retailer name from signage, or null if not visible",
  "confidence": 0.0 to 1.0
}`
    });

    const resp = await claudeMessage([{ role: 'user', content }], 600);
    const parsed = extractJson(resp.content[0].text);

    // Update shop_outs row
    const updates = {};
    if (parsed.location) updates.store_location_text = parsed.location;
    if (parsed.address) updates.store_address = parsed.address;
    if (parsed.retailer_confirmed) updates.retailer_detected_via = 'storefront_ai';

    if (Object.keys(updates).length > 0) {
      try {
        await sb(`/rest/v1/shop_outs?id=eq.${shop_out_id}`, {
          method: 'PATCH',
          body: JSON.stringify(updates)
        });
      } catch (err) {
        // store_address column might not exist; retry without it
        delete updates.store_address;
        if (Object.keys(updates).length > 0) {
          await sb(`/rest/v1/shop_outs?id=eq.${shop_out_id}`, {
            method: 'PATCH',
            body: JSON.stringify(updates)
          });
        }
      }
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
