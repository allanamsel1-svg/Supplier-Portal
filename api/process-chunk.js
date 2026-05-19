// ════════════════════════════════════════════════════════════════════
// /api/process-chunk.js
//
// Processes a batch of shop-out photos through Claude vision.
// Pass 1: Group consecutive product photos
// Pass 2: Extract product details per group
//
// Built-in:
// - Image resize/recompress to fit Anthropic's 5MB limit
// - Schema-correct column names (matches actual shop_out_observations)
// - Per-photo and per-group error isolation (one failure doesn't kill the batch)
// - Zero npm dependencies
// ════════════════════════════════════════════════════════════════════

export const config = { runtime: 'nodejs' };
export const maxDuration = 240;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const BUCKET = 'shop-out-photos';
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';

const GROUP_BATCH_SIZE = 8;          // photos per grouping call (smaller = safer payload)
const EXTRACT_CONCURRENCY = 3;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;  // 4MB safety margin under Anthropic's 5MB cap
const MAX_DIMENSION = 1568;          // Anthropic's recommended max edge

// ─── SUPABASE HELPERS ───────────────────────────────────────────────
async function sb(path, opts = {}) {
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...(opts.headers || {})
  };
  const r = await fetch(`${SUPABASE_URL}${path}`, { ...opts, headers });
  if (!r.ok) throw new Error(`Supabase ${r.status} ${path}: ${await r.text()}`);
  if (r.status === 204) return null;
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

async function signUrl(filePath, options = {}) {
  // options.transform can include { width, height, resize, quality }
  const body = { expiresIn: 3600 };
  if (options.transform) body.transform = options.transform;
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${filePath}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`Sign URL ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return `${SUPABASE_URL}/storage/v1${data.signedURL}`;
}

// ─── IMAGE PREP (resize + base64) ────────────────────────────────────
// Strategy: fetch the image, check size; if over MAX_IMAGE_BYTES, use
// Anthropic's URL-based image source which lets them fetch directly
// (they handle resizing). For under-limit images, send as base64.
async function fetchImageForClaude(filePath) {
  // Always request a resized version from Supabase image transform.
  // This brings even 12MP HEIC photos down to ~300-800KB, well under
  // Anthropic's 5MB limit. width:1568 matches Anthropic's recommended max.
  const url = await signUrl(filePath, {
    transform: { width: 1568, height: 1568, resize: 'contain', quality: 85 }
  });

  const r = await fetch(url);
  if (!r.ok) throw new Error(`Image fetch ${r.status}: ${await r.text()}`);
  const buf = await r.arrayBuffer();
  const bytes = buf.byteLength;

  if (bytes > MAX_IMAGE_BYTES) {
    // Shouldn't happen with the transform, but guard anyway
    console.warn(`[image] post-resize still ${bytes} bytes, skipping`);
    throw new Error(`Image too large even after resize: ${bytes} bytes`);
  }

  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/jpeg',
      data: Buffer.from(buf).toString('base64')
    }
  };
}

// ─── ANTHROPIC ──────────────────────────────────────────────────────
async function claudeMessage(messages, maxTokens = 2000, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: maxTokens, messages })
    });
    if (r.ok) return r.json();
    const errBody = await r.text();
    // Don't retry on bad input (400); do retry on rate limit (429) or server (500+)
    if (r.status === 400) throw new Error(`Anthropic 400: ${errBody}`);
    if (attempt === retries) throw new Error(`Anthropic ${r.status}: ${errBody}`);
    await new Promise(res => setTimeout(res, 1000 * (attempt + 1)));
  }
}

function extractJson(text) {
  let cleaned = text.replace(/```json|```/g, '').trim();
  const firstObj = cleaned.indexOf('{');
  const firstArr = cleaned.indexOf('[');
  let firstBrace;
  if (firstObj === -1) firstBrace = firstArr;
  else if (firstArr === -1) firstBrace = firstObj;
  else firstBrace = Math.min(firstObj, firstArr);
  if (firstBrace === -1) throw new Error('No JSON in response');
  cleaned = cleaned.substring(firstBrace);
  const lastObj = cleaned.lastIndexOf('}');
  const lastArr = cleaned.lastIndexOf(']');
  const lastBrace = Math.max(lastObj, lastArr);
  if (lastBrace === -1) throw new Error('No closing brace');
  return JSON.parse(cleaned.substring(0, lastBrace + 1));
}

// ─── PASS 1: GROUPING ────────────────────────────────────────────────
async function groupPhotos(photos, retailerName) {
  const groups = [];

  for (let i = 0; i < photos.length; i += GROUP_BATCH_SIZE) {
    const batch = photos.slice(i, i + GROUP_BATCH_SIZE);
    const content = [];

    for (const p of batch) {
      try {
        const imgBlock = await fetchImageForClaude(p.file_path);
        content.push(imgBlock);
        content.push({ type: 'text', text: `[id:${p.id}]` });
      } catch (err) {
        console.warn(`[group] skip photo ${p.id}: ${err.message}`);
      }
    }

    if (content.length === 0) continue;

    content.push({
      type: 'text',
      text: `Shop-out photos at ${retailerName || 'a retailer'}. Group consecutive photos showing the same product. A typical product group is 2-3 shots (wide shelf, front of pack, back of pack, price tag). Identify storefront/aisle/sign photos separately.

Return ONLY JSON:
{"groups":[{"photoIds":["id1","id2"],"role":"product"},{"photoIds":["id3"],"role":"storefront"}]}

Roles: "product", "storefront", "skip" (blurry/unusable).`
    });

    try {
      const resp = await claudeMessage([{ role: 'user', content }], 1500);
      const parsed = extractJson(resp.content[0].text);
      if (parsed.groups && Array.isArray(parsed.groups)) {
        for (const g of parsed.groups) {
          if (g.photoIds && g.photoIds.length > 0) {
            groups.push({
              photoIds: g.photoIds,
              role: g.role || 'product'
            });
          }
        }
      }
    } catch (err) {
      console.error(`[group] batch ${i} failed: ${err.message}`);
      // Fallback: each photo is its own product group
      for (const p of batch) {
        groups.push({ photoIds: [p.id], role: 'product' });
      }
    }
  }
  return groups;
}

// ─── PASS 2: EXTRACTION ──────────────────────────────────────────────
async function extractObservation(group, photosById, retailerName) {
  const content = [];
  for (const pid of group.photoIds) {
    const p = photosById[pid];
    if (!p) continue;
    try {
      const imgBlock = await fetchImageForClaude(p.file_path);
      content.push(imgBlock);
    } catch (err) {
      console.warn(`[extract] skip photo: ${err.message}`);
    }
  }
  if (content.length === 0) return null;

  content.push({
    type: 'text',
    text: `Product at ${retailerName || 'retailer'}. Extract product details from these photos. Return ONLY JSON:

{
  "brand": "main brand name",
  "sub_brand": "sub-brand or line if applicable",
  "product_name": "full product name including descriptor",
  "pack_size": "numeric size, e.g. 3.4",
  "pack_size_unit": "fl oz | ml | oz | g | ct | etc",
  "retail_price": numeric price without dollar sign,
  "compare_at_price": "original price if marked down, else null",
  "upc": "UPC if visible, else null",
  "department": "Beauty | HBC | Apparel | Home | Food | Toys | Electronics | Other",
  "ai_suggested_category": "specific category, e.g. Mascara, Body Lotion, Pasta Sauce",
  "retailer_vendor_code": "vendor code on price tag if visible, else null",
  "retailer_class_code": "class code on price tag if visible, else null",
  "country_of_origin": "country if visible on packaging, else null",
  "confidence": 0.0 to 1.0
}

Use null (NOT "null" string) for missing fields. retail_price MUST be a number (12.99) not a string.`
  });

  try {
    const resp = await claudeMessage([{ role: 'user', content }], 1000);
    return extractJson(resp.content[0].text);
  } catch (err) {
    console.error(`[extract] failed: ${err.message}`);
    return null;
  }
}

// ─── INSERT OBSERVATIONS (with verification) ─────────────────────────
async function insertObservations(obsRows) {
  if (obsRows.length === 0) return 0;
  // Insert one at a time so a single bad row doesn't fail the whole batch
  let inserted = 0;
  for (const row of obsRows) {
    try {
      await sb(`/rest/v1/shop_out_observations`, {
        method: 'POST',
        headers: { 'Prefer': 'return=minimal' },
        body: JSON.stringify(row)
      });
      inserted++;
    } catch (err) {
      console.error(`[insert] row failed: ${err.message}`);
      console.error(`[insert] failing row:`, JSON.stringify(row).substring(0, 500));
    }
  }
  return inserted;
}

// ─── MAIN HANDLER ────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

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
  const { shop_out_id, photo_ids } = body || {};
  if (!shop_out_id) return res.status(400).json({ error: 'shop_out_id required' });
  if (!photo_ids || !Array.isArray(photo_ids) || photo_ids.length === 0) {
    return res.status(400).json({ error: 'photo_ids array required' });
  }

  try {
    // Get retailer name
    const shops = await sb(`/rest/v1/shop_outs?id=eq.${shop_out_id}&select=customer_id`);
    if (!shops || shops.length === 0) return res.status(404).json({ error: 'Shop-out not found' });

    let retailerName = null;
    if (shops[0].customer_id) {
      const cust = await sb(`/rest/v1/customers?id=eq.${shops[0].customer_id}&select=customer_name`);
      if (cust && cust.length > 0) retailerName = cust[0].customer_name;
    }

    // Fetch chunk's photos
    const idList = photo_ids.map(id => `"${id}"`).join(',');
    const photos = await sb(`/rest/v1/shop_out_photos?id=in.(${idList})&order=photo_sequence_number.asc&select=*`);
    if (!photos || photos.length === 0) return res.status(400).json({ error: 'No photos found' });

    const photosById = {};
    photos.forEach(p => { photosById[p.id] = p; });

    // PASS 1: group
    console.log(`[chunk] grouping ${photos.length} photos for ${retailerName || 'unknown retailer'}`);
    const groups = await groupPhotos(photos, retailerName);
    console.log(`[chunk] ${groups.length} groups detected`);

    // Save group_role to photos
    for (const group of groups) {
      for (const pid of group.photoIds) {
        try {
          await sb(`/rest/v1/shop_out_photos?id=eq.${pid}`, {
            method: 'PATCH',
            body: JSON.stringify({ group_role: group.role })
          });
        } catch (err) {
          console.warn(`[chunk] save group_role for ${pid}: ${err.message}`);
        }
      }
    }

    // PASS 2: extract observations from product groups
    const productGroups = groups.filter(g => g.role === 'product' && g.photoIds.length > 0);
    console.log(`[chunk] extracting from ${productGroups.length} product groups`);

    const observations = [];
    for (let i = 0; i < productGroups.length; i += EXTRACT_CONCURRENCY) {
      const batch = productGroups.slice(i, i + EXTRACT_CONCURRENCY);
      const results = await Promise.all(batch.map(g => extractObservation(g, photosById, retailerName)));
      for (let bi = 0; bi < batch.length; bi++) {
        if (results[bi]) observations.push({ group: batch[bi], obs: results[bi] });
      }
    }
    console.log(`[chunk] extracted ${observations.length} observations`);

    // Build observation rows matching ACTUAL schema
    const obsRows = observations.map(({ group, obs }) => {
      const photoIds = group.photoIds || [];

      // Parse retail_price safely
      let retailPrice = null;
      if (obs.retail_price != null && obs.retail_price !== 'null') {
        const parsed = parseFloat(obs.retail_price);
        if (!isNaN(parsed)) retailPrice = parsed;
      }
      let compareAtPrice = null;
      if (obs.compare_at_price != null && obs.compare_at_price !== 'null') {
        const parsed = parseFloat(obs.compare_at_price);
        if (!isNaN(parsed)) compareAtPrice = parsed;
      }
      let confidence = null;
      if (obs.confidence != null) {
        const parsed = parseFloat(obs.confidence);
        if (!isNaN(parsed)) confidence = parsed;
      }

      const row = {
        shop_out_id,
        brand: obs.brand || null,
        sub_brand: obs.sub_brand || null,
        product_name: obs.product_name || null,
        pack_size: obs.pack_size != null ? String(obs.pack_size) : null,
        pack_size_unit: obs.pack_size_unit || null,
        retail_price: retailPrice,
        compare_at_price: compareAtPrice,
        upc: obs.upc || null,
        department: obs.department || null,
        ai_suggested_category: obs.ai_suggested_category || null,
        retailer_vendor_code: obs.retailer_vendor_code || null,
        retailer_class_code: obs.retailer_class_code || null,
        country_of_origin: obs.country_of_origin || null,
        ai_confidence: confidence,
        ai_extraction_json: obs,
        source_photo_count: photoIds.length
      };
      if (photoIds[0]) row.front_photo_id = photoIds[0];
      if (photoIds[1]) row.back_photo_id = photoIds[1];
      if (photoIds.length > 2) row.supplemental_photo_ids = photoIds.slice(2);
      return row;
    });

    const insertedCount = await insertObservations(obsRows);
    console.log(`[chunk] inserted ${insertedCount} / ${obsRows.length} observations`);

    // Update total_observations from actual count
    const allObs = await sb(`/rest/v1/shop_out_observations?shop_out_id=eq.${shop_out_id}&select=id`);
    const totalObs = allObs ? allObs.length : 0;

    await sb(`/rest/v1/shop_outs?id=eq.${shop_out_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ total_observations: totalObs })
    });

    return res.status(200).json({
      success: true,
      photos_processed: photos.length,
      groups: groups.length,
      product_groups: productGroups.length,
      observations_attempted: obsRows.length,
      observations_inserted: insertedCount,
      observations_total: totalObs,
      retailer: retailerName
    });
  } catch (err) {
    console.error('[chunk] fatal:', err);
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
}
