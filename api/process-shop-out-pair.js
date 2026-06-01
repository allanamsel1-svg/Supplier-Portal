// /api/process-shop-out-pair.js
//
// Processes one (front, back) photo pair from a shop-out via Anthropic Vision,
// inserts a shop_out_observations row, marks photos as processed.
//
// IMAGES: Uses Supabase image transform to resize to 1568px max edge before
// fetching, which keeps all images well under Anthropic's 5MB cap regardless
// of original size (HEIC, large JPEG, etc.).

const SUPABASE_URL = 'https://mjkjubctswjwjihxjpnd.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
  || process.env.SUPABASE_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1qa2p1YmN0c3dqd2ppaHhqcG5kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczNjQxNjcsImV4cCI6MjA5Mjk0MDE2N30.cZrD_ymrDsRPyfX_g3hUui5_JXuW6BgE77QkIoGpqHo';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-6';

import { computeNormalization, matchSku } from '../lib/sku-match.mjs';
import { buildPriceChangeRow, retailerKey, unitSizeComparable } from '../lib/price-change.mjs';

const PLACEMENT_TYPES = ['main_floor', 'clearance', 'checkout_register', 'end_cap', 'display'];

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
    const {
      shopOutId, frontPhotoId, backPhotoId,
      frontPath, backPath,
      retailerName, retailerCountry
    } = body || {};

    if (!shopOutId || !frontPhotoId || !frontPath) {
      return res.status(400).json({ error: 'Missing required fields: shopOutId, frontPhotoId, frontPath' });
    }

    // 1. Fetch both photos (resized to 1568px max) as base64
    const frontB64 = await fetchPhotoResizedAsBase64(frontPath);
    const backB64  = backPath ? await fetchPhotoResizedAsBase64(backPath) : null;

    // 2. Build Anthropic request
    const content = [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: frontB64 } }
    ];
    if (backB64) {
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: backB64 } });
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

    // 4. Parse JSON
    let extracted = null;
    const fenceMatch = responseText.match(/```json\s*([\s\S]*?)\s*```/);
    const braceMatch = responseText.match(/(\{[\s\S]*\})/);
    const jsonText = fenceMatch ? fenceMatch[1] : (braceMatch ? braceMatch[1] : responseText);
    try { extracted = JSON.parse(jsonText); }
    catch (e) { throw new Error('AI returned unparseable JSON: ' + responseText.slice(0, 500)); }

    // Resolve which photo is actually the front based on the AI's assessment.
    let resolvedFrontId = frontPhotoId;
    let resolvedBackId = backPhotoId || null;
    if (backPhotoId && extracted.front_image_index === 2) {
      resolvedFrontId = backPhotoId;
      resolvedBackId = frontPhotoId;
    }

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

    // 6. Build observation
    const obsPayload = {
      shop_out_id: shopOutId,
      front_photo_id: resolvedFrontId,
      back_photo_id: resolvedBackId,
      brand: extracted.brand || null,
      product_name: extracted.product_name || null,
      sub_brand: extracted.sub_brand || null,
      pack_size: extracted.pack_size != null ? String(extracted.pack_size) : null,
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
      department: extracted.department || null,
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

    // 7b. Normalize unit + per-unit price, then auto-match to a Projections SKU,
    //     and PATCH both onto the new row in one call.
    const newId = inserted[0] && inserted[0].id;
    if (newId) {
      const norm = computeNormalization(obsPayload.pack_size, obsPayload.pack_size_unit, obsPayload.retail_price);

      // 7c. Score the observation against all active Projections SKUs.
      let match = { projection_sku_id: null, sku_match_method: null, sku_match_confidence: null };
      try {
        const skuR = await sbFetch('/rest/v1/projection_skus?status=eq.active&select=id,item_description,size_unit,category,sub_category,sub_sub_category');
        if (skuR.ok) {
          const skus = await skuR.json();
          match = matchSku({ ...obsPayload, ...norm }, skus);
        } else {
          console.warn(`Active SKU fetch failed (${skuR.status}); skipping auto-match`);
        }
      } catch (e) { console.warn('SKU auto-match failed:', e.message); }

      // 7d. Clearance + placement classification (extracted by the AI).
      const placement = {
        is_clearance: extracted.is_clearance === true,
        clearance_confidence: numOrNull(extracted.clearance_confidence),
        placement_type: PLACEMENT_TYPES.includes(extracted.placement_type) ? extracted.placement_type : 'main_floor'
      };

      const patch = { ...norm, ...match, ...placement };
      const normR = await sbFetch(`/rest/v1/shop_out_observations?id=eq.${newId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
      });
      if (normR.ok) Object.assign(inserted[0], patch);
      else console.warn(`Normalization/match PATCH failed (${normR.status}) for observation ${newId}`);

      // 7e. Price-change detection vs the most recent prior sighting at this retailer.
      try {
        await checkPriceChange(newId, obsPayload, norm, shopOutId);
      } catch (e) { console.warn('Price-change check failed:', e.message); }
    }

    // 8. Mark photos as processed
    await sbFetch(`/rest/v1/shop_out_photos?id=eq.${resolvedFrontId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        photo_type: 'item_front',
        paired_with_photo_id: resolvedBackId,
        ai_processed_at: new Date().toISOString()
      })
    });
    if (resolvedBackId) {
      await sbFetch(`/rest/v1/shop_out_photos?id=eq.${resolvedBackId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          photo_type: 'item_back',
          paired_with_photo_id: resolvedFrontId,
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

// ─── HELPERS ─────────────────────────────────────────────────────────

// Fetch a Supabase-resized version of the photo as base64.
// Uses the image transformation endpoint to bring images under 5MB
// regardless of original size or format. Works for JPEG, HEIC-converted, PNG.
async function fetchPhotoResizedAsBase64(path) {
  // Sign a transformed URL via the storage API (Pro plan feature)
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
    // Fallback: fetch original (will fail if >5MB but at least we tried)
    console.warn(`Sign with transform failed (${signR.status}), falling back to original`);
    imageUrl = `${SUPABASE_URL}/storage/v1/object/shop-out-photos/${path}`;
  }

  const r = await fetch(imageUrl, {
    headers: signR.ok ? {} : { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  });
  if (!r.ok) throw new Error(`Image fetch failed (${r.status}): ${path}`);
  const buf = await r.arrayBuffer();

  // Hard cap safety check
  if (buf.byteLength > 4.5 * 1024 * 1024) {
    throw new Error(`Image still too large after resize: ${buf.byteLength} bytes`);
  }
  return Buffer.from(buf).toString('base64');
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

// Quote a value for a PostgREST ilike filter (handles spaces/commas via quoting).
function ilikeQuoted(s) {
  return encodeURIComponent('"' + String(s == null ? '' : s).replace(/"/g, '').trim() + '"');
}

// Find the most recent prior sighting of the same brand+product at the same
// retailer (shop_outs.customer_id = same retailer chain) on an earlier
// shop_date; if the price moved >5%, insert a flagged shop_out_price_history row.
async function checkPriceChange(newId, obsPayload, norm, shopOutId) {
  const brand = obsPayload.brand, product = obsPayload.product_name, price = numOrNull(obsPayload.retail_price);
  if (!brand || !product || price == null) return;

  // Current shop-out's retailer (customer) + date.
  const soR = await sbFetch(`/rest/v1/shop_outs?id=eq.${shopOutId}&select=customer_id,shop_date,store_location_text`);
  if (!soR.ok) return;
  const so = (await soR.json())[0];
  const custKey = retailerKey(so);
  if (!so || !custKey || !so.shop_date) return;   // no retailer/timeline → cannot compare

  // Prior shop-outs for the same retailer chain, earlier date.
  const psR = await sbFetch(`/rest/v1/shop_outs?select=id,shop_date&customer_id=eq.${custKey}&shop_date=lt.${so.shop_date}`);
  if (!psR.ok) return;
  const priorShops = await psR.json();
  if (!priorShops.length) return;
  const dateById = {};
  priorShops.forEach(p => { dateById[p.id] = p.shop_date; });

  // Same brand+product observations within those prior shop-outs, restricted to
  // the same item (same normalized_unit + size within 30%).
  const obR = await sbFetch(`/rest/v1/shop_out_observations?select=id,product_name,retail_price,shop_out_id,normalized_unit,normalized_size&shop_out_id=in.(${priorShops.map(p => p.id).join(',')})&brand=ilike.${ilikeQuoted(brand)}&retail_price=not.is.null`);
  if (!obR.ok) return;
  const cands = (await obR.json()).filter(o =>
    (o.product_name || '').toLowerCase().trim() === product.toLowerCase().trim() &&
    unitSizeComparable({ normalized_unit: o.normalized_unit, normalized_size: o.normalized_size }, norm)
  );
  if (!cands.length) return;

  // Most recent comparable prior by shop_date.
  cands.sort((a, b) => (dateById[b.shop_out_id] < dateById[a.shop_out_id] ? -1 : 1));
  const prev = cands[0];

  const row = buildPriceChangeRow(
    { retail_price: prev.retail_price, shop_date: dateById[prev.shop_out_id], observation_id: prev.id, normalized_unit: prev.normalized_unit, normalized_size: prev.normalized_size },
    {
      retail_price: price, unit_price: norm.unit_price, shop_date: so.shop_date,
      observation_id: newId, shop_out_id: shopOutId, brand, product_name: product,
      retailer: so.store_location_text, store_location_text: so.store_location_text,
      pack_size: numOrNull(obsPayload.pack_size), pack_size_unit: obsPayload.pack_size_unit,
      normalized_unit: norm.normalized_unit, normalized_size: norm.normalized_size
    }
  );
  if (!row) return;
  const ins = await sbFetch('/rest/v1/shop_out_price_history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify(row)
  });
  if (!ins.ok) console.warn('price_history insert failed', ins.status, await ins.text());
}

function buildPrompt(retailerName, retailerCountry, hasBack) {
  return `You're analyzing photos from a competitive intelligence shop-out at ${retailerName || 'an unknown retailer'}${retailerCountry ? ` in ${retailerCountry}` : ''}. The retailer is typically an off-price chain (TJ Maxx, Marshalls, Burlington, Ross-style), so each item has a custom retailer-applied price sticker with structured fields (SEA, WK, MFG, STYLE, CLASS, COLOR, plus the price).

You'll see ${hasBack ? 'TWO images: the FRONT (image 1) and BACK or price-tag side (image 2)' : 'ONE image (front view only)'} of a single product, photographed by hand in a store. Extract structured data and return STRICTLY a single JSON object. No prose, no markdown fences.

Schema (use null where you cannot determine a value with reasonable confidence):

{
  "brand": "string — brand name as printed on packaging",
  "product_name": "string — product name as printed",
  "sub_brand": "string or null",
  "pack_size": "number — numeric quantity. For multi-pack items (face masks, wipes, capsules, pads, sheets) this MUST be the count of items. Examples: 60 for '60 wipes', 7 for '7 sheet masks', 30 for '30 capsules', 4 for '4 fl oz', 250 for '250 ml'. Look hard at the front of pack for any number indicating quantity, especially next to words like 'count', 'ct', 'pack', 'pieces', 'sheets', 'capsules', 'pads', 'tablets'.",
  "pack_size_unit": "one of: count, fl_oz, ml, g, kg, lb, oz, pack. Use 'count' for any item that's a quantity of discrete units (masks, wipes, capsules, sheets, pads).",
  "retail_price": "number — price from the retailer's price sticker (decimal, no $ sign)",
  "compare_at_price": "number or null — any 'compare at' / 'orig' / 'MSRP' price visible",
  "retailer_vendor_code": "string — MFG value from sticker (typically 5 digits)",
  "retailer_style_code": "string — STYLE value",
  "retailer_class_code": "string — CLASS value",
  "retailer_season": "string — SEA value",
  "retailer_week": "string — WK value",
  "retailer_color": "string — COLOR value",
  "upc": "string — UPC barcode digits if visible",
  "country_of_origin": "string — country name as printed",
  "country_confidence": "one of: stated, inferred, unknown",
  "department": "one of: Beauty, HBC, Apparel, Home, Food, Toys, Electronics, Other",
  "is_clearance": "boolean — true if clearance signage, a red clearance tag, a percentage-off sticker, or a clearance bin is visible for this item; otherwise false",
  "clearance_confidence": "number 0.0-1.0 — confidence in the is_clearance call",
  "placement_type": "one of: main_floor, clearance, checkout_register, end_cap, display. checkout_register = small-format impulse items at the POS / register lanes (candy, gum, travel/trial sizes adjacent to checkout). end_cap = product displayed at the end of an aisle. display = a standalone promotional display or stand. clearance = clearance bin / clearance section. main_floor = a normal in-line shelf (use this as the default when no special placement is evident).",
  "ai_suggested_category": "string — category path 'Beauty > Skincare > Body Scrubs'",
  "category_confidence": "number 0.0-1.0",
  "ingredients_list": "string or null — full INCI list if visible",
  "period_after_opening": "string or null — e.g., '6M', '12M'",
  "ai_confidence": "number 0.0-1.0",
  "front_image_index": ${hasBack ? '"number — which of the two images is the FRONT of the product (1 or 2). The front is the shopper-facing branded face: product name, hero imagery, marketing copy. The back/side typically shows ingredients, fine print, the retailer price sticker, or a barcode. Pick whichever image is the clearer marketing-facing shot. If a single image shows BOTH branded front AND a price tag affixed to its front, that image is still the front. Only default to 1 if truly indistinguishable."' : '"number — 1 (only one image provided)"'}
}

CRITICAL: output a single JSON object only. No markdown fences. No prose.`;
}
