// ════════════════════════════════════════════════════════════════════
// /api/process-chunk.js
//
// CHUNKED shop-out processor.
// Takes a slice of photo IDs and processes ONLY those.
// Each invocation fits well under Vercel's 5-min limit.
// Front-end orchestrates the loop across chunks.
//
// Request:  POST { shop_out_id, photo_ids: [uuid, ...] }
// Response: { groups, observations_added, observations_total }
// ════════════════════════════════════════════════════════════════════

export const config = { runtime: 'nodejs' };
export const maxDuration = 240;  // 4 min — well under Pro's 300s

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const BUCKET = 'shop-out-photos';
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
const GROUP_BATCH_SIZE = 10;
const EXTRACT_CONCURRENCY = 3;

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

async function claudeMessage(messages, maxTokens = 2000) {
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
  const firstBrace = Math.min(
    cleaned.indexOf('{') === -1 ? Infinity : cleaned.indexOf('{'),
    cleaned.indexOf('[') === -1 ? Infinity : cleaned.indexOf('[')
  );
  if (firstBrace === Infinity) throw new Error('No JSON');
  cleaned = cleaned.substring(firstBrace);
  const lastBrace = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
  cleaned = cleaned.substring(0, lastBrace + 1);
  return JSON.parse(cleaned);
}

async function groupPhotos(photos, retailerName) {
  const groups = [];
  let counter = Date.now();

  for (let i = 0; i < photos.length; i += GROUP_BATCH_SIZE) {
    const batch = photos.slice(i, i + GROUP_BATCH_SIZE);
    const content = [];

    for (let bi = 0; bi < batch.length; bi++) {
      const p = batch[bi];
      try {
        const url = await signUrl(p.file_path);
        const base64 = await imgUrlToBase64(url);
        content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } });
        content.push({ type: 'text', text: `[id:${p.id}]` });
      } catch (err) {
        console.warn(`Skip photo ${p.id}: ${err.message}`);
      }
    }

    content.push({
      type: 'text',
      text: `Shop-out photos at ${retailerName || 'a retailer'}. Group consecutive photos showing the same product (typically 2-3 shots per product). Identify storefront/aisle/sign photos separately.

Return ONLY JSON:
{"groups":[{"photoIds":["id1","id2"],"role":"product"},{"photoIds":["id3"],"role":"storefront"}]}

Roles: "product", "storefront", "skip".`
    });

    try {
      const resp = await claudeMessage([{ role: 'user', content }], 1500);
      const parsed = extractJson(resp.content[0].text);
      if (parsed.groups && Array.isArray(parsed.groups)) {
        for (const g of parsed.groups) {
          groups.push({
            id: `g${counter++}`,
            photoIds: g.photoIds || [],
            role: g.role || 'product'
          });
        }
      }
    } catch (err) {
      console.error(`Group batch ${i} failed: ${err.message}`);
      for (const p of batch) {
        groups.push({ id: `g${counter++}`, photoIds: [p.id], role: 'product' });
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
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } });
    } catch (err) { console.warn(err.message); }
  }
  if (content.length === 0) return null;

  content.push({
    type: 'text',
    text: `Product at ${retailerName || 'retailer'}. Extract details, return ONLY JSON:
{"brand":"...","sub_brand":"...","product_name":"...","pack_size":"3.4","pack_size_unit":"fl oz","retail_price":12.99,"compare_at_price":null,"upc":"...","department":"Beauty|HBC|Apparel|Home|Food|Toys|Electronics|Other","ai_suggested_category":"e.g. Mascara, Body Lotion, Pasta Sauce","retailer_vendor_code":"vendor code if visible on tag","retailer_class_code":"class code if visible","country_of_origin":"country if visible","confidence":0.85}
Use null for missing fields. retail_price and compare_at_price are numbers without dollar sign.`
  });

  try {
    const resp = await claudeMessage([{ role: 'user', content }], 1000);
    return extractJson(resp.content[0].text);
  } catch (err) {
    console.error(`Extract failed: ${err.message}`);
    return null;
  }
}

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
    // Fetch retailer name once
    const shops = await sb(`/rest/v1/shop_outs?id=eq.${shop_out_id}&select=customer_id`);
    if (!shops || shops.length === 0) return res.status(404).json({ error: 'Shop-out not found' });

    let retailerName = null;
    if (shops[0].customer_id) {
      const cust = await sb(`/rest/v1/customers?id=eq.${shops[0].customer_id}&select=customer_name`);
      if (cust && cust.length > 0) retailerName = cust[0].customer_name;
    }

    // Fetch the chunk's photos
    const idList = photo_ids.map(id => `"${id}"`).join(',');
    const photos = await sb(`/rest/v1/shop_out_photos?id=in.(${idList})&order=photo_sequence_number.asc&select=*`);
    if (!photos || photos.length === 0) return res.status(400).json({ error: 'No photos found' });

    const photosById = {};
    photos.forEach(p => { photosById[p.id] = p; });

    // PASS 1: group
    console.log(`[chunk] grouping ${photos.length} photos`);
    const groups = await groupPhotos(photos, retailerName);
    console.log(`[chunk] ${groups.length} groups`);

    // Save group assignments
    for (const group of groups) {
      for (const pid of group.photoIds) {
        try {
          await sb(`/rest/v1/shop_out_photos?id=eq.${pid}`, {
            method: 'PATCH',
            body: JSON.stringify({ photo_group_id: group.id, group_role: group.role })
          });
        } catch (err) { console.warn(`Save group ${pid}: ${err.message}`); }
      }
    }

    // PASS 2: extract
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

    const obsRows = observations.map(({ group, obs }) => {
      // Find front and back photo IDs from the group
      const photoIds = group.photoIds || [];
      const row = {
        shop_out_id,
        brand: obs.brand || null,
        sub_brand: obs.sub_brand || null,
        product_name: obs.product_name || null,
        pack_size: obs.pack_size ? String(obs.pack_size) : null,
        pack_size_unit: obs.pack_size_unit || null,
        retail_price: obs.retail_price || null,
        compare_at_price: obs.compare_at_price || null,
        upc: obs.upc || null,
        department: obs.department || null,
        ai_suggested_category: obs.ai_suggested_category || null,
        retailer_vendor_code: obs.retailer_vendor_code || null,
        retailer_class_code: obs.retailer_class_code || null,
        country_of_origin: obs.country_of_origin || null,
        ai_confidence: obs.confidence || null,
        ai_extraction_json: obs,  // full raw extraction as safety net
        photo_group_id: group.id,
        source_photo_count: photoIds.length
      };
      if (photoIds[0]) row.front_photo_id = photoIds[0];
      if (photoIds[1]) row.back_photo_id = photoIds[1];
      if (photoIds.length > 2) row.supplemental_photo_ids = photoIds.slice(2);
      return row;
    });

    if (obsRows.length > 0) {
      await sb(`/rest/v1/shop_out_observations`, {
        method: 'POST',
        body: JSON.stringify(obsRows)
      });
    }

    // Get current total
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
      observations_added: obsRows.length,
      observations_total: totalObs
    });
  } catch (err) {
    console.error('[chunk] fatal:', err);
    return res.status(500).json({ error: err.message });
  }
}
