// /api/process-shop-out-v2.js
//
// Two-pass processing for a shop-out:
//   Pass 1: Send all photo URLs to Claude with a "group these by product" prompt.
//           Returns groupings + retailer/date detection + per-group department.
//   Pass 2: For each group, send the grouped photos with the existing per-product
//           extraction prompt. Returns structured observation data.
//
// Called from the frontend after all photos finish uploading.
//
// Body: { shop_out_id: uuid }
// Returns: { observations_created, groups_created, retailer_detected, date_detected, cost_usd }

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const MODEL = 'claude-sonnet-4-5-20250929';
const BUCKET = 'shop-out-photos';

// Approximate cost per Claude vision call (Sonnet 4.5, image+text)
const COST_PER_GROUPING_CALL_PER_PHOTO = 0.008;  // ~$0.008/photo in grouping pass
const COST_PER_EXTRACTION_CALL         = 0.04;   // ~$0.04 per group (1-6 photos)


// ─── MAIN HANDLER ───────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { shop_out_id } = req.body;
  if (!shop_out_id) return res.status(400).json({ error: 'shop_out_id required' });

  try {
    // 1. Mark processing started
    await supabase.from('shop_outs').update({
      processing_status: 'grouping',
      processing_started_at: new Date().toISOString(),
      processing_error: null
    }).eq('id', shop_out_id);

    // 2. Load photos
    const { data: photos, error: photoErr } = await supabase
      .from('shop_out_photos')
      .select('id, file_path, exif_timestamp, exif_lat, exif_lng')
      .eq('shop_out_id', shop_out_id)
      .eq('upload_status', 'uploaded')
      .order('created_at', { ascending: true });

    if (photoErr) throw new Error('Failed to load photos: ' + photoErr.message);
    if (!photos || photos.length === 0) throw new Error('No photos to process');

    // 3. Build signed URLs (1 hour expiry, plenty for processing)
    const photosWithUrls = await Promise.all(photos.map(async (p) => {
      const { data: signed } = await supabase.storage
        .from(BUCKET).createSignedUrl(p.file_path, 3600);
      return { ...p, signed_url: signed?.signedUrl };
    }));

    // 4. PASS 1 — Grouping + metadata detection
    const groupingResult = await runGroupingPass(photosWithUrls);

    // 5. Persist auto-detected shop-out metadata
    const updates = {};
    if (groupingResult.retailer_name) {
      // Try to resolve to customer_id
      const { data: matches } = await supabase
        .from('customers')
        .select('id, name')
        .ilike('name', `%${groupingResult.retailer_name}%`)
        .limit(1);
      if (matches && matches.length > 0) {
        updates.customer_id = matches[0].id;
        updates.retailer_detected_via = groupingResult.retailer_signal;
        updates.retailer_confidence = groupingResult.retailer_confidence;
      }
    }
    if (groupingResult.date) {
      updates.shop_date = groupingResult.date;
      updates.date_detected_via = 'ai_detected';
    }
    if (groupingResult.gps_lat && groupingResult.gps_lng) {
      updates.gps_lat = groupingResult.gps_lat;
      updates.gps_lng = groupingResult.gps_lng;
    }
    if (Object.keys(updates).length > 0) {
      await supabase.from('shop_outs').update(updates).eq('id', shop_out_id);
    }

    // 6. Persist groups + assign photos
    await supabase.from('shop_outs').update({ processing_status: 'extracting' }).eq('id', shop_out_id);

    const groupIdMap = {}; // grouping index → real uuid
    for (let i = 0; i < groupingResult.groups.length; i++) {
      const g = groupingResult.groups[i];
      const { data: groupRow, error: gErr } = await supabase
        .from('shop_out_photo_groups')
        .insert({
          shop_out_id,
          group_type: g.group_type || 'product',
          photo_count: g.photo_indices.length,
          grouping_confidence: g.confidence,
          needs_review: g.confidence < 0.7,
          review_reason: g.confidence < 0.7 ? 'Low grouping confidence' : null
        })
        .select('id').single();
      if (gErr) continue;
      groupIdMap[i] = groupRow.id;

      // Assign photos to this group
      const photoIds = g.photo_indices.map(idx => photosWithUrls[idx]?.id).filter(Boolean);
      if (photoIds.length > 0) {
        await supabase.from('shop_out_photos').update({
          photo_group_id: groupRow.id,
          group_role: g.hero_index !== undefined ? null : 'single'
        }).in('id', photoIds);

        // Tag the hero photo specifically
        if (g.hero_index !== undefined && photosWithUrls[g.hero_index]) {
          await supabase.from('shop_out_photos').update({
            group_role: 'hero'
          }).eq('id', photosWithUrls[g.hero_index].id);
        }
      }
    }

    // 7. PASS 2 — Per-group extraction
    let observationsCreated = 0;
    let extractionFailures = 0;

    for (let i = 0; i < groupingResult.groups.length; i++) {
      const g = groupingResult.groups[i];

      // Only extract from 'product' type groups
      if (g.group_type !== 'product') continue;

      const groupPhotos = g.photo_indices.map(idx => photosWithUrls[idx]).filter(Boolean);
      if (groupPhotos.length === 0) continue;

      try {
        const extraction = await runExtractionPass(groupPhotos, {
          retailer: groupingResult.retailer_name,
          department_hint: g.department
        });

        if (extraction && extraction.brand) {
          // Try to map category via TBG taxonomy
          let categoryId = null;
          if (extraction.category_path) {
            const { data: catMatch } = await supabase
              .from('categories')
              .select('id').ilike('name', extraction.category_path.split('>').pop().trim()).limit(1);
            if (catMatch && catMatch.length > 0) categoryId = catMatch[0].id;
          }

          const { data: obsRow } = await supabase
            .from('shop_out_observations')
            .insert({
              shop_out_id,
              photo_group_id: groupIdMap[i],
              brand: extraction.brand,
              product_name: extraction.product_name,
              department: extraction.department || g.department,
              category_id: categoryId,
              pack_size: extraction.pack_size,
              retail_price: extraction.retail_price,
              compare_at_price: extraction.compare_at_price,
              upc: extraction.upc,
              country_of_origin: extraction.country_of_origin,
              ingredients: extraction.ingredients,
              mfg_vendor_code: extraction.mfg_vendor_code,
              retailer_style_code: extraction.retailer_style_code,
              ai_confidence: extraction.confidence,
              source_photo_count: groupPhotos.length,
              status: extraction.confidence >= 0.85 ? 'auto_accepted' : 'pending'
            })
            .select('id').single();

          if (obsRow) {
            observationsCreated++;
            await supabase
              .from('shop_out_photo_groups')
              .update({ extracted_observation_id: obsRow.id })
              .eq('id', groupIdMap[i]);
          }
        }
      } catch (err) {
        extractionFailures++;
        console.error(`Group ${i} extraction failed:`, err.message);
      }
    }

    // 8. Estimate cost
    const groupingCost = photosWithUrls.length * COST_PER_GROUPING_CALL_PER_PHOTO;
    const extractionCost = groupingResult.groups.filter(g => g.group_type === 'product').length
                           * COST_PER_EXTRACTION_CALL;
    const totalCost = groupingCost + extractionCost;

    // 9. Finalize
    await supabase.from('shop_outs').update({
      processing_status: 'complete',
      processing_completed_at: new Date().toISOString(),
      total_photos: photosWithUrls.length,
      total_observations: observationsCreated,
      estimated_cost_usd: totalCost
    }).eq('id', shop_out_id);

    return res.json({
      success: true,
      observations_created: observationsCreated,
      groups_created: groupingResult.groups.length,
      extraction_failures: extractionFailures,
      retailer_detected: groupingResult.retailer_name,
      date_detected: groupingResult.date,
      cost_usd: totalCost.toFixed(2)
    });

  } catch (err) {
    console.error('Processing failed:', err);
    await supabase.from('shop_outs').update({
      processing_status: 'failed',
      processing_error: err.message
    }).eq('id', shop_out_id);
    return res.status(500).json({ error: err.message });
  }
}


// ─── PASS 1: GROUPING + METADATA DETECTION ──────────────────────────
async function runGroupingPass(photos) {
  // For efficiency, batch in chunks of 30 photos per grouping call
  // (Claude can handle more but quality degrades and cost grows)
  const BATCH_SIZE = 30;
  const allGroups = [];
  let detectedRetailer = null;
  let detectedRetailerSignal = null;
  let detectedRetailerConfidence = 0;
  let detectedDate = null;
  let detectedGpsLat = null;
  let detectedGpsLng = null;

  // EXIF-based date detection (median timestamp)
  const exifDates = photos.map(p => p.exif_timestamp).filter(Boolean).sort();
  if (exifDates.length > 0) {
    detectedDate = exifDates[Math.floor(exifDates.length / 2)].substring(0, 10);
  }

  // EXIF-based GPS (use first photo with GPS)
  const withGps = photos.find(p => p.exif_lat && p.exif_lng);
  if (withGps) {
    detectedGpsLat = withGps.exif_lat;
    detectedGpsLng = withGps.exif_lng;
  }

  for (let batchStart = 0; batchStart < photos.length; batchStart += BATCH_SIZE) {
    const batch = photos.slice(batchStart, batchStart + BATCH_SIZE);

    const content = [
      {
        type: 'text',
        text: buildGroupingPrompt(batch.length, batchStart, batchStart === 0)
      },
      ...batch.map(p => ({
        type: 'image',
        source: { type: 'url', url: p.signed_url }
      }))
    ];

    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      messages: [{ role: 'user', content }]
    });

    const parsed = extractJson(response.content[0].text);
    if (!parsed) continue;

    // First batch: capture retailer detection
    if (batchStart === 0 && parsed.retailer_name) {
      detectedRetailer = parsed.retailer_name;
      detectedRetailerSignal = parsed.retailer_detected_via;
      detectedRetailerConfidence = parsed.retailer_confidence || 0.8;
    }

    // Translate batch-local indices to global indices
    if (parsed.groups) {
      for (const g of parsed.groups) {
        g.photo_indices = g.photo_indices.map(i => i + batchStart);
        if (g.hero_index !== undefined) g.hero_index += batchStart;
        allGroups.push(g);
      }
    }
  }

  return {
    groups: allGroups,
    retailer_name: detectedRetailer,
    retailer_signal: detectedRetailerSignal,
    retailer_confidence: detectedRetailerConfidence,
    date: detectedDate,
    gps_lat: detectedGpsLat,
    gps_lng: detectedGpsLng
  };
}


function buildGroupingPrompt(batchSize, batchStart, isFirstBatch) {
  return `You're analyzing photos from a retail shop-out walk (a buyer photographing products on store shelves).

This batch contains ${batchSize} photos, indexed 0 to ${batchSize - 1} in the order presented.

TASK 1: GROUP PHOTOS BY WHAT THEY DEPICT.
Photos belong to the same group if they show the SAME PRODUCT (front, back, side, close-up of price tag, etc.).
Some photos may be storefront shots (store exterior, signage) — these are their own group_type='storefront'.
Some photos may be receipts or other context — group_type='receipt' or 'discarded'.
A single photo can be its own group if no other photos depict the same product.
Within each product group, identify the BEST hero shot (clearest front-of-package view).

${isFirstBatch ? `TASK 2: DETECT THE RETAILER.
Read price tag formatting, storefront signage, interior cues. Common off-price retailers and their signals:
- TJ Maxx / T.J. Maxx: white price tags with red barcode, MFG / STYLE / CLASS / SEASON / WEEK / COLOR codes
- Marshalls: similar to TJ Maxx, blue accents
- Ross Stores / Ross Dress for Less: yellow/orange price tags
- Burlington: red/yellow price tags
- HomeGoods: orange tags
- Winners (Canada): similar to TJ Maxx
Confidence: 0.9+ if storefront photo + price tag agree. 0.7-0.9 if one strong signal. <0.7 if guessing.
` : ''}

RESPOND WITH RAW JSON, NO MARKDOWN, NO PREAMBLE:
{
${isFirstBatch ? `  "retailer_name": "TJ Maxx",
  "retailer_detected_via": "storefront_photo" or "price_tag" or "multi_signal",
  "retailer_confidence": 0.0-1.0,
` : ''}  "groups": [
    {
      "photo_indices": [0, 1, 2],
      "group_type": "product",
      "hero_index": 0,
      "department": "Beauty",
      "confidence": 0.9
    },
    {
      "photo_indices": [3],
      "group_type": "storefront",
      "confidence": 1.0
    }
  ]
}

Photo indices are 0-based. Every photo must appear in exactly one group.
department options: "Beauty", "HBC", "Hair", "Personal Care", "Apparel", "Home Goods", "Toys", "Kitchen", "Pet", "Stationery", "Holiday", "Other"`;
}


// ─── PASS 2: PER-GROUP EXTRACTION ───────────────────────────────────
async function runExtractionPass(groupPhotos, ctx) {
  const content = [
    {
      type: 'text',
      text: buildExtractionPrompt(groupPhotos.length, ctx)
    },
    ...groupPhotos.map(p => ({
      type: 'image',
      source: { type: 'url', url: p.signed_url }
    }))
  ];

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2048,
    messages: [{ role: 'user', content }]
  });

  return extractJson(response.content[0].text);
}


function buildExtractionPrompt(photoCount, ctx) {
  return `These ${photoCount} photo(s) all depict the SAME product on a retail shelf at ${ctx.retailer || 'a store'}.
Department hint: ${ctx.department_hint || 'unknown'}.

Extract structured product data from these photos combined. Use information across all photos — the back might have ingredients the front doesn't show; a close-up price tag might have codes invisible elsewhere.

RESPOND WITH RAW JSON, NO MARKDOWN:
{
  "brand": "Brand Name",
  "product_name": "Product description",
  "department": "Beauty | HBC | Hair | Personal Care | Apparel | Home Goods | Toys | Kitchen | Pet | Stationery | Holiday | Other",
  "category_path": "Top > Sub > Specific category name",
  "pack_size": "8 oz" or "3-pack" etc,
  "retail_price": 4.99,
  "compare_at_price": 12.99 or null,
  "upc": "012345678905" or null,
  "country_of_origin": "China" or null,
  "ingredients": "full ingredients list" or null,
  "mfg_vendor_code": retailer-internal vendor ID from price tag or null,
  "retailer_style_code": retailer-internal style code or null,
  "confidence": 0.0-1.0
}

If any field is unreadable or absent, use null. Don't invent values.`;
}


// ─── HELPERS ────────────────────────────────────────────────────────
function extractJson(text) {
  if (!text) return null;
  // Strip code fences if present
  const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
  // Find the first { and last } for resilience
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(cleaned.substring(start, end + 1));
  } catch (e) {
    console.error('JSON parse failed:', e.message);
    return null;
  }
}
