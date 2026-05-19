// ════════════════════════════════════════════════════════════════════
// /api/process-shop-out-v2.js
//
// AI processing pipeline for shop-outs.
// - Pass 1 (grouping): Claude vision groups photos into product groups
//                      and detects role (storefront vs product).
// - Pass 2 (extraction): For each product group, Claude extracts
//                        brand, name, price, department, etc.
//
// ZERO npm dependencies — uses raw fetch for both Supabase + Anthropic.
// Works regardless of package.json state.
// ════════════════════════════════════════════════════════════════════

export const config = { runtime: 'nodejs' };
export const maxDuration = 300;  // 5 minutes (Vercel Pro)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const BUCKET = 'shop-out-photos';
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
const GROUP_BATCH_SIZE = 15;
const EXTRACT_CONCURRENCY = 4;

async function sb(path, opts = {}) {
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...(opts.headers || {})
  };
  const r = await fetch(`${SUPABASE_URL}${path}`, { ...opts, headers });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Supabase ${r.status} ${path}: ${body}`);
  }
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
  if (!r.ok) throw new Error(`Sign URL ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return `${SUPABASE_URL}/storage/v1${data.signedURL}`;
}

async function imgUrlToBase64(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Image fetch ${r.status}`);
  const buf = await r.arrayBuffer();
  return Buffer.from(buf).toString('base64');
}

async function claudeMessage(messages, maxTokens = 4000) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      messages
    })
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Anthropic ${r.status}: ${body}`);
  }
  return r.json();
}

function extractJson(text) {
  let cleaned = text.replace(/```json|```/g, '').trim();
  const firstBrace = Math.min(
    cleaned.indexOf('{') === -1 ? Infinity : cleaned.indexOf('{'),
    cleaned.indexOf('[') === -1 ? Infinity : cleaned.indexOf('[')
  );
  if (firstBrace === Infinity) throw new Error('No JSON in response');
  cleaned = cleaned.substring(firstBrace);
  const lastBrace = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
  if (lastBrace === -1) throw new Error('No closing brace');
  cleaned = cleaned.substring(0, lastBrace + 1);
  return JSON.parse(cleaned);
}

async function groupPhotos(photos, retailerName) {
  const groups = [];
  let groupCounter = 0;

  for (let i = 0; i < photos.length; i += GROUP_BATCH_SIZE) {
    const batch = photos.slice(i, i + GROUP_BATCH_SIZE);
    const content = [];

    for (let bi = 0; bi < batch.length; bi++) {
      const p = batch[bi];
      try {
        const url = await signUrl(p.file_path);
        const base64 = await imgUrlToBase64(url);
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: base64 }
        });
        content.push({
          type: 'text',
          text: `[Photo ${i + bi + 1} — id:${p.id}]`
        });
      } catch (err) {
        console.warn(`Skip photo ${p.id}: ${err.message}`);
      }
    }

    content.push({
      type: 'text',
      text: `These photos are from a shop-out at ${retailerName || 'a retailer'}.

Group consecutive photos that show the same product. A typical product group is 2-3 photos: a wide shot of the product on shelf, then close-ups of the front packaging, back of pack, or price tag.

Identify storefront/exterior photos separately.

Return ONLY valid JSON in this exact format:
{
  "groups": [
    {"photoIds": ["id1", "id2"], "role": "product"},
    {"photoIds": ["id3"], "role": "storefront"}
  ]
}

Roles: "product" (product shots), "storefront" (store exterior/aisle/section signs), "skip" (blurry/unusable).`
    });

    try {
      const resp = await claudeMessage([{ role: 'user', content }], 2000);
      const text = resp.content[0].text;
      const parsed = extractJson(text);
      if (parsed.groups && Array.isArray(parsed.groups)) {
        for (const g of parsed.groups) {
          groups.push({
            id: `g${groupCounter++}`,
            photoIds: g.photoIds || [],
            role: g.role || 'product'
          });
        }
      }
    } catch (err) {
      console.error(`Grouping batch ${i} failed: ${err.message}`);
      for (const p of batch) {
        groups.push({ id: `g${groupCounter++}`, photoIds: [p.id], role: 'product' });
      }
    }
  }

  return groups;
}

async function extractObservation(group, photosById, retailerName) {
  const content = [];
  for (const pid of group.photoIds) {
    const p = photosById[pid];
    if (!p) continue;
    try {
      const url = await signUrl(p.file_path);
      const base64 = await imgUrlToBase64(url);
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: base64 }
      });
    } catch (err) {
      console.warn(`Skip photo in group: ${err.message}`);
    }
  }
  if (content.length === 0) return null;

  content.push({
    type: 'text',
    text: `These photos show a single product at ${retailerName || 'a retailer'}.

Extract product details. Return ONLY valid JSON in this format:
{
  "brand": "brand name or null",
  "product_name": "full product name or null",
  "pack_size": "e.g. '3.4 fl oz' or null",
  "retail_price": numeric price or null,
  "list_price": numeric list price (if shown separately) or null,
  "upc": "UPC code if visible, else null",
  "department": "Beauty | HBC | Apparel | Home | Food | Toys | Electronics | Other",
  "sub_category": "more specific category if clear, else null",
  "promo_text": "any promotional text on tag, else null",
  "confidence": 0.0 to 1.0 (your confidence)
}`
  });

  try {
    const resp = await claudeMessage([{ role: 'user', content }], 1500);
    const text = resp.content[0].text;
    return extractJson(text);
  } catch (err) {
    console.error(`Extraction failed: ${err.message}`);
    return null;
  }
}

async function runExtractionPool(groups, photosById, retailerName) {
  const observations = [];
  for (let i = 0; i < groups.length; i += EXTRACT_CONCURRENCY) {
    const batch = groups.slice(i, i + EXTRACT_CONCURRENCY);
    const results = await Promise.all(batch.map(g => extractObservation(g, photosById, retailerName)));
    for (let bi = 0; bi < batch.length; bi++) {
      if (results[bi]) observations.push({ group: batch[bi], observation: results[bi] });
    }
  }
  return observations;
}

function detectDateFromExif(photos) {
  const timestamps = photos
    .map(p => p.exif_timestamp)
    .filter(Boolean)
    .map(t => new Date(t).getTime())
    .filter(t => !isNaN(t))
    .sort((a, b) => a - b);
  if (timestamps.length === 0) return null;
  const median = timestamps[Math.floor(timestamps.length / 2)];
  return new Date(median).toISOString().substring(0, 10);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!SUPABASE_URL || !SUPABASE_KEY || !ANTHROPIC_KEY) {
    return res.status(500).json({
      error: 'Missing env vars',
      missing: {
        SUPABASE_URL: !SUPABASE_URL,
        SUPABASE_SERVICE_KEY: !SUPABASE_KEY,
        ANTHROPIC_API_KEY: !ANTHROPIC_KEY
      }
    });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const { shop_out_id } = body || {};
  if (!shop_out_id) return res.status(400).json({ error: 'shop_out_id required' });

  try {
    const shops = await sb(`/rest/v1/shop_outs?id=eq.${shop_out_id}&select=*`);
    if (!shops || shops.length === 0) return res.status(404).json({ error: 'Shop-out not found' });
    const shop = shops[0];

    let retailerName = null;
    if (shop.customer_id) {
      const cust = await sb(`/rest/v1/customers?id=eq.${shop.customer_id}&select=customer_name`);
      if (cust && cust.length > 0) retailerName = cust[0].customer_name;
    }

    await sb(`/rest/v1/shop_outs?id=eq.${shop_out_id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        processing_status: 'grouping',
        processing_started_at: new Date().toISOString(),
        processing_error: null
      })
    });

    const photos = await sb(`/rest/v1/shop_out_photos?shop_out_id=eq.${shop_out_id}&order=photo_sequence_number.asc&select=*`);
    if (!photos || photos.length === 0) {
      await sb(`/rest/v1/shop_outs?id=eq.${shop_out_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ processing_status: 'failed', processing_error: 'No photos uploaded' })
      });
      return res.status(400).json({ error: 'No photos' });
    }

    const photosById = {};
    photos.forEach(p => { photosById[p.id] = p; });

    const detectedDate = detectDateFromExif(photos);
    if (detectedDate && !shop.shop_date) {
      await sb(`/rest/v1/shop_outs?id=eq.${shop_out_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ shop_date: detectedDate, date_detected_via: 'exif_median' })
      });
    }

    console.log(`[process-shop-out-v2] grouping ${photos.length} photos`);
    const groups = await groupPhotos(photos, retailerName);
    console.log(`[process-shop-out-v2] ${groups.length} groups`);

    for (const group of groups) {
      for (const pid of group.photoIds) {
        try {
          await sb(`/rest/v1/shop_out_photos?id=eq.${pid}`, {
            method: 'PATCH',
            body: JSON.stringify({ photo_group_id: group.id, group_role: group.role })
          });
        } catch (err) {
          console.warn(`Save group for photo ${pid}: ${err.message}`);
        }
      }
    }

    await sb(`/rest/v1/shop_outs?id=eq.${shop_out_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ processing_status: 'extracting' })
    });

    const productGroups = groups.filter(g => g.role === 'product' && g.photoIds.length > 0);
    console.log(`[process-shop-out-v2] extracting from ${productGroups.length} product groups`);

    const extracted = await runExtractionPool(productGroups, photosById, retailerName);

    const obsRows = extracted.map(({ group, observation }) => ({
      shop_out_id,
      brand: observation.brand || null,
      product_name: observation.product_name || null,
      pack_size: observation.pack_size || null,
      retail_price: observation.retail_price || null,
      list_price: observation.list_price || null,
      upc: observation.upc || null,
      department: observation.department || null,
      sub_category: observation.sub_category || null,
      promo_text: observation.promo_text || null,
      ai_confidence: observation.confidence || null,
      photo_group_id: group.id
    }));

    if (obsRows.length > 0) {
      await sb(`/rest/v1/shop_out_observations`, {
        method: 'POST',
        body: JSON.stringify(obsRows)
      });
    }

    const cost = (photos.length * 0.04).toFixed(2);
    await sb(`/rest/v1/shop_outs?id=eq.${shop_out_id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        processing_status: 'complete',
        processing_completed_at: new Date().toISOString(),
        total_observations: obsRows.length,
        estimated_cost_usd: cost
      })
    });

    return res.status(200).json({
      success: true,
      groups: groups.length,
      product_groups: productGroups.length,
      observations: obsRows.length,
      detected_date: detectedDate
    });
  } catch (err) {
    console.error('process-shop-out-v2 fatal:', err);
    try {
      await sb(`/rest/v1/shop_outs?id=eq.${shop_out_id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          processing_status: 'failed',
          processing_error: err.message.substring(0, 500)
        })
      });
    } catch {}
    return res.status(500).json({ error: err.message });
  }
}
