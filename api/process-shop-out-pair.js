// /api/process-shop-out-pair.js
//
// Processes one (front, back) photo pair from a shop-out, extracts product
// data via Anthropic Vision API, inserts a shop_out_observations row, and
// marks the photos as processed.
//
// Env vars required:
//   ANTHROPIC_API_KEY   (you should already have this from other endpoints)
//   SUPABASE_SERVICE_KEY (optional — falls back to anon if not set)

const SUPABASE_URL = 'https://mjkjubctswjwjihxjpnd.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY
  || process.env.SUPABASE_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1qa2p1YmN0c3dqd2ppaHhqcG5kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczNjQxNjcsImV4cCI6MjA5Mjk0MDE2N30.cZrD_ymrDsRPyfX_g3hUui5_JXuW6BgE77QkIoGpqHo';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-6';   // change to 'claude-haiku-4-5-20251001' for cheaper but lower-fidelity

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set in env' });

  try {
    const {
      shopOutId, frontPhotoId, backPhotoId,
      frontPath, backPath,
      retailerName, retailerCountry
    } = req.body || {};

    if (!shopOutId || !frontPhotoId || !frontPath) {
      return res.status(400).json({ error: 'Missing required fields: shopOutId, frontPhotoId, frontPath' });
    }

    // 1. Fetch both photos from Supabase storage as base64
    const frontB64 = await fetchPhotoAsBase64(frontPath);
    const backB64  = backPath ? await fetchPhotoAsBase64(backPath) : null;

    const frontMediaType = mediaTypeFromPath(frontPath);
    const backMediaType  = backPath ? mediaTypeFromPath(backPath) : null;

    // 2. Build Anthropic request
    const content = [
      { type: 'image', source: { type: 'base64', media_type: frontMediaType, data: frontB64 } }
    ];
    if (backB64) {
      content.push({ type: 'image', source: { type: 'base64', media_type: backMediaType, data: backB64 } });
    }
    content.push({ type: 'text', text: buildPrompt(retailerName, retailerCountry, backB64 !== null) });

    // 3. Call Anthropic
    const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2048,
        messages: [{ role: 'user', content }]
      })
    });

    if (!aiResp.ok) {
      const errText = await aiResp.text();
      throw new Error(`Anthropic API ${aiResp.status}: ${errText}`);
    }

    const aiData = await aiResp.json();
    const responseText = (aiData.content || []).map(c => c.text || '').join('\n');

    // 4. Parse JSON from response (tolerate markdown fences or stray prose)
    let extracted = null;
    const fenceMatch = responseText.match(/```json\s*([\s\S]*?)\s*```/);
    const braceMatch = responseText.match(/(\{[\s\S]*\})/);
    const jsonText = fenceMatch ? fenceMatch[1] : (braceMatch ? braceMatch[1] : responseText);
    try { extracted = JSON.parse(jsonText); }
    catch (e) { throw new Error('AI returned unparseable JSON: ' + responseText.slice(0, 500)); }

    // 5. Map category to TBG categories.id (best-effort)
    let categoryId = null;
    if (extracted.ai_suggested_category) {
      const parts = String(extracted.ai_suggested_category).split(/\s*>\s*/).map(p => p.trim());
      if (parts.length >= 1 && parts[0]) {
        const qParams = ['select=id', `category=eq.${encodeURIComponent(parts[0])}`];
        if (parts[1]) qParams.push(`sub_category=eq.${encodeURIComponent(parts[1])}`);
        if (parts[2]) qParams.push(`sub_sub_category=eq.${encodeURIComponent(parts[2])}`);
        qParams.push('limit=1');
        const catR = await sbFetch(`/rest/v1/categories?${qParams.join('&')}`);
        if (catR.ok) {
          const cats = await catR.json();
          if (cats.length) categoryId = cats[0].id;
        }
      }
    }

    // 6. Build observation insert
    const obsPayload = {
      shop_out_id: shopOutId,
      front_photo_id: frontPhotoId,
      back_photo_id: backPhotoId || null,
      brand: extracted.brand || null,
      product_name: extracted.product_name || null,
      sub_brand: extracted.sub_brand || null,
      pack_size: numOrNull(extracted.pack_size),
      pack_size_unit: extracted.pack_size_unit || null,
      retail_price: numOrNull(extracted.retail_price),
      compare_at_price: numOrNull(extracted.compare_at_price),
      retailer_vendor_code: extracted.retailer_vendor_code || null,
      retailer_style_code: extracted.retailer_style_code || null,
      retailer_class_code: extracted.retailer_class_code || null,
      retailer_season: extracted.retailer_season || null,
      retailer_week: extracted.retailer_week || null,
      retailer_color: extracted.retailer_color || null,
      upc: extracted.upc || null,
      country_of_origin: extracted.country_of_origin || null,
      country_confidence: extracted.country_confidence || null,
      category_id: categoryId,
      ai_suggested_category: extracted.ai_suggested_category || null,
      category_confidence: numOrNull(extracted.category_confidence),
      ingredients_list: extracted.ingredients_list || null,
      period_after_opening: extracted.period_after_opening || null,
      ai_confidence: numOrNull(extracted.ai_confidence),
      review_status: (Number(extracted.ai_confidence) >= 0.85) ? 'auto_accepted' : 'pending',
      ai_extraction_json: extracted
    };
    if (obsPayload.retail_price && obsPayload.compare_at_price && obsPayload.compare_at_price > obsPayload.retail_price) {
      obsPayload.markdown_pct = Math.round((1 - obsPayload.retail_price / obsPayload.compare_at_price) * 100);
    }

    // 7. Insert observation
    const insR = await sbFetch('/rest/v1/shop_out_observations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify(obsPayload)
    });
    if (!insR.ok) {
      const errText = await insR.text();
      throw new Error(`Observation insert failed (${insR.status}): ${errText}`);
    }
    const inserted = await insR.json();

    // 8. Mark the photos as processed
    await sbFetch(`/rest/v1/shop_out_photos?id=eq.${frontPhotoId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        photo_type: 'item_front',
        paired_with_photo_id: backPhotoId || null,
        ai_processed_at: new Date().toISOString()
      })
    });
    if (backPhotoId) {
      await sbFetch(`/rest/v1/shop_out_photos?id=eq.${backPhotoId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          photo_type: 'item_back',
          paired_with_photo_id: frontPhotoId,
          ai_processed_at: new Date().toISOString()
        })
      });
    }

    return res.status(200).json({ success: true, observation: inserted[0], extracted });

  } catch (err) {
    console.error('process-shop-out-pair error:', err);
    return res.status(500).json({ error: err.message || String(err) });
  }
}

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

async function fetchPhotoAsBase64(path) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/shop-out-photos/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  });
  if (!r.ok) throw new Error(`Storage fetch failed for ${path}: ${r.status}`);
  const buf = await r.arrayBuffer();
  return Buffer.from(buf).toString('base64');
}

function sbFetch(path, opts = {}) {
  opts.headers = opts.headers || {};
  opts.headers.apikey = SUPABASE_KEY;
  opts.headers.Authorization = `Bearer ${SUPABASE_KEY}`;
  return fetch(`${SUPABASE_URL}${path}`, opts);
}

function mediaTypeFromPath(path) {
  const p = (path || '').toLowerCase();
  if (p.endsWith('.png')) return 'image/png';
  if (p.endsWith('.webp')) return 'image/webp';
  if (p.endsWith('.gif')) return 'image/gif';
  return 'image/jpeg';
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function buildPrompt(retailerName, retailerCountry, hasBack) {
  return `You're analyzing photos from a competitive intelligence shop-out at ${retailerName || 'an unknown retailer'}${retailerCountry ? ` in ${retailerCountry}` : ''}. The retailer is typically an off-price chain (TJ Maxx, Marshalls, Burlington, Ross-style), so each item has a custom retailer-applied price sticker with structured fields (SEA, WK, MFG, STYLE, CLASS, COLOR, plus the price).

You'll see ${hasBack ? 'TWO images: the FRONT (image 1) and BACK or price-tag side (image 2)' : 'ONE image (front view only)'} of a single product, photographed by hand in a store. Extract structured data and return STRICTLY a single JSON object. No prose, no markdown fences, no explanation — just the JSON object.

Schema (use null where you cannot determine a value with reasonable confidence):

{
  "brand": "string — brand name as printed on packaging (front)",
  "product_name": "string — product name/title as printed",
  "sub_brand": "string or null — any sub-brand or product line",
  "pack_size": "number — numeric size (e.g., 60 for '60 wipes', 4 for '4 fl oz', 250 for '250 ml')",
  "pack_size_unit": "one of: count, fl_oz, ml, g, kg, lb, oz, pack",
  "retail_price": "number — price from the retailer's price sticker (no dollar sign, decimal)",
  "compare_at_price": "number or null — any 'compare at' / 'orig' / 'MSRP' price visible",
  "retailer_vendor_code": "string — MFG value from the retailer price sticker (typically 5 digits)",
  "retailer_style_code": "string — STYLE value",
  "retailer_class_code": "string — CLASS value",
  "retailer_season": "string — SEA value (e.g., 'H' for Holiday)",
  "retailer_week": "string — WK value",
  "retailer_color": "string — COLOR value from the sticker",
  "upc": "string — UPC barcode digits if visible (12 or 13 digits)",
  "country_of_origin": "string — country name as printed (e.g., 'China', 'United States', 'Made in Vietnam')",
  "country_confidence": "one of: stated, inferred, unknown",
  "ai_suggested_category": "string — best category path in format 'Beauty > Skincare > Body Scrubs' or 'Beauty > Wipes > Makeup Cleansing Wipes'",
  "category_confidence": "number 0.0–1.0 — confidence in the category classification",
  "ingredients_list": "string or null — full INCI ingredients list if visible on the back",
  "period_after_opening": "string or null — e.g., '6M', '12M', '24M' (the open-jar symbol)",
  "ai_confidence": "number 0.0–1.0 — overall confidence in this extraction"
}

CRITICAL: output a single JSON object only. No markdown fences. No prose before or after.`;
}
