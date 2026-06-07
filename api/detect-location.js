// POLICY: Never reference "Claude" or "Anthropic" in any user-facing text, labels, messages, or UI elements.
// /api/detect-location.js

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
    const { shop_out_id } = body || {};
    if (!shop_out_id) return res.status(400).json({ error: 'shop_out_id required' });

    const shopR = await sbFetch(`/rest/v1/shop_outs?id=eq.${shop_out_id}&select=customer_id`);
    if (!shopR.ok) return res.status(500).json({ error: `Shop fetch ${shopR.status}` });
    const shops = await shopR.json();
    if (!shops.length) return res.status(404).json({ error: 'Shop-out not found' });

    let retailerName = null;
    if (shops[0].customer_id) {
      const custR = await sbFetch(`/rest/v1/customers?id=eq.${shops[0].customer_id}&select=customer_name`);
      if (custR.ok) {
        const c = await custR.json();
        if (c.length) retailerName = c[0].customer_name;
      }
    }

    // First 8 photos — usually includes storefront shots since people start there
    const photoR = await sbFetch(`/rest/v1/shop_out_photos?shop_out_id=eq.${shop_out_id}&order=photo_sequence_number.asc&limit=8&select=*`);
    const photos = photoR.ok ? await photoR.json() : [];
    if (photos.length === 0) return res.status(400).json({ error: 'No photos found' });

    const content = [];
    const errors = [];
    for (const p of photos) {
      try {
        const b64 = await fetchPhotoResizedAsBase64(p.file_path);
        content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } });
      } catch (err) {
        errors.push(`${p.file_path}: ${err.message}`);
      }
    }
    if (content.length === 0) {
      return res.status(500).json({ error: 'All image fetches failed', details: errors });
    }

    content.push({
      type: 'text',
      text: `These are photos from a ${retailerName || 'retail'} store visit. Look carefully for visible markers of WHERE the store is located: store address signs, street names, mall names, plaza names, city/state on receipts or fixtures, ZIP codes, regional area names, license plates, neighborhood signs.

Also confirm the retailer name visible in signage.

Return ONLY a single JSON object, no prose, no markdown fences:
{
  "location": "Best location, e.g. 'East Brunswick, NJ' or 'Garden State Plaza, Paramus NJ' — null if no markers visible",
  "address": "Full street address if visible, else null",
  "retailer_confirmed": "Retailer name from signage if visible, else null",
  "confidence": 0.0 to 1.0
}`
    });

    const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 600,
        messages: [{ role: 'user', content }]
      })
    });
    if (!aiResp.ok) return res.status(500).json({ error: `AI service error ${aiResp.status}: ${await aiResp.text()}` });
    const aiData = await aiResp.json();
    const responseText = (aiData.content || []).map(c => c.text || '').join('\n');

    const fenceMatch = responseText.match(/```json\s*([\s\S]*?)\s*```/);
    const braceMatch = responseText.match(/(\{[\s\S]*\})/);
    const jsonText = fenceMatch ? fenceMatch[1] : (braceMatch ? braceMatch[1] : responseText);
    let parsed;
    try { parsed = JSON.parse(jsonText); }
    catch (e) { return res.status(500).json({ error: 'AI returned unparseable JSON', responseText: responseText.slice(0, 500) }); }

    const updates = {};
    if (parsed.location) updates.store_location_text = parsed.location;
    if (parsed.retailer_confirmed) updates.retailer_detected_via = 'storefront_ai';

    if (Object.keys(updates).length > 0) {
      await sbFetch(`/rest/v1/shop_outs?id=eq.${shop_out_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });
    }

    return res.status(200).json({
      location: parsed.location,
      address: parsed.address,
      retailer_confirmed: parsed.retailer_confirmed,
      confidence: parsed.confidence,
      photos_analyzed: content.length - 1,
      fetch_errors: errors.length > 0 ? errors : undefined
    });

  } catch (err) {
    console.error('detect-location error:', err);
    return res.status(500).json({ error: err.message || String(err) });
  }
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
    console.warn(`Sign+transform failed (${signR.status}), trying original`);
    imageUrl = `${SUPABASE_URL}/storage/v1/object/shop-out-photos/${path}`;
  }

  const r = await fetch(imageUrl, {
    headers: signR.ok ? {} : { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  });
  if (!r.ok) throw new Error(`Image fetch ${r.status}`);
  const buf = await r.arrayBuffer();
  if (buf.byteLength > 4.5 * 1024 * 1024) throw new Error(`Too large after resize: ${buf.byteLength}`);
  return Buffer.from(buf).toString('base64');
}

function sbFetch(path, opts = {}) {
  opts.headers = opts.headers || {};
  opts.headers.apikey = SUPABASE_KEY;
  opts.headers.Authorization = `Bearer ${SUPABASE_KEY}`;
  return fetch(`${SUPABASE_URL}${path}`, opts);
}
