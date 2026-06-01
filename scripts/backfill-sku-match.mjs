// One-time backfill: unit-price normalization + auto-match to Projections SKUs.
//
//   node scripts/backfill-sku-match.mjs [shopOutId ...]
//
// For each shop-out, reusing the exact live-pipeline logic in lib/sku-match.mjs:
//   1. NORMALIZATION — for every observation with pack_size + pack_size_unit,
//      (re)compute normalized_unit / normalized_size / unit_price.
//   2. MATCH — for every observation with no projection_sku_id, score it against
//      all active projection_skus and set projection_sku_id / sku_match_method /
//      sku_match_confidence. Unmatched rows (score < 2) are left null.
// Both writes for an observation are coalesced into a single PATCH.
// Normalization is computed BEFORE matching so the match can use the fresh size.
// Prints a per-shop-out summary and a grand total.

import { computeNormalization, matchSku } from '../lib/sku-match.mjs';

const SB = 'https://mjkjubctswjwjihxjpnd.supabase.co';
const KEY = process.env.SUPABASE_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1qa2p1YmN0c3dqd2ppaHhqcG5kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczNjQxNjcsImV4cCI6MjA5Mjk0MDE2N30.cZrD_ymrDsRPyfX_g3hUui5_JXuW6BgE77QkIoGpqHo';

// Default work-list: the shop-outs that still need backfilling. Override by
// passing one or more shop-out IDs as CLI args.
const DEFAULT_SHOP_OUTS = [
  'a2c6f9f0-e101-418d-912e-c0571b573bcc',
  '94a0784b-9d41-4da1-8a2f-2c9a9a910e4a',
  'aec50d35-6ba7-4d87-8e36-4b3cda396557',
  '585e3c87-102a-467b-a979-f89b58ad01ed',
  '60069596-66b2-4584-bf9c-60666dd16e1f'
];
const SHOP_OUTS = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_SHOP_OUTS;

function h(path, opts = {}) {
  opts.headers = { ...(opts.headers || {}), apikey: KEY, Authorization: 'Bearer ' + KEY };
  return fetch(SB + path, opts);
}

// Active Projections SKUs (fetched once, reused for every shop-out).
const skuR = await h('/rest/v1/projection_skus?status=eq.active&select=id,item_description,size_unit,category,sub_category,sub_sub_category');
if (!skuR.ok) { console.error('Failed to fetch SKUs:', skuR.status, await skuR.text()); process.exit(1); }
const skus = await skuR.json();
console.log(`Loaded ${skus.length} active Projections SKUs.\n`);

const grand = { total: 0, matched: 0, low: 0, unmatched: 0, prices: 0, failed: 0 };

for (const shopOut of SHOP_OUTS) {
  const obsR = await h('/rest/v1/shop_out_observations?shop_out_id=eq.' + shopOut +
    '&select=id,brand,ai_suggested_category,pack_size,pack_size_unit,retail_price,projection_sku_id');
  if (!obsR.ok) { console.error(`Failed to fetch observations for ${shopOut}:`, obsR.status, await obsR.text()); continue; }
  const obs = await obsR.json();

  let matched = 0, low = 0, unmatched = 0, prices = 0, failed = 0;
  for (const o of obs) {
    const patch = {};

    // 1. Normalization (only when there's a size to normalize).
    let norm = { normalized_unit: null, normalized_size: null, unit_price: null };
    if (o.pack_size != null && o.pack_size_unit != null) {
      norm = computeNormalization(o.pack_size, o.pack_size_unit, o.retail_price);
      patch.normalized_unit = norm.normalized_unit;
      patch.normalized_size = norm.normalized_size;
      patch.unit_price = norm.unit_price;
      if (norm.unit_price != null) prices++;
    }

    // 2. Match (only when not already matched), using the freshly computed size.
    if (o.projection_sku_id == null) {
      const m = matchSku({ ...o, ...norm }, skus);
      patch.projection_sku_id = m.projection_sku_id;
      patch.sku_match_method = m.sku_match_method;
      patch.sku_match_confidence = m.sku_match_confidence;
      patch.is_category_gap = m.is_category_gap;
      if (m.sku_match_method === 'ai_suggested') matched++;
      else if (m.sku_match_method === 'ai_low_confidence') low++;
      else unmatched++;
    }

    if (!Object.keys(patch).length) continue;
    const r = await h('/rest/v1/shop_out_observations?id=eq.' + o.id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    });
    if (!r.ok) { failed++; console.error('PATCH failed', o.id, r.status, await r.text()); }
  }

  console.log(`shop_out ${shopOut}`);
  console.log(`  total observations:     ${obs.length}`);
  console.log(`  matched (ai_suggested): ${matched}`);
  console.log(`  low_confidence:         ${low}`);
  console.log(`  unmatched (score < 2):  ${unmatched}`);
  console.log(`  unit prices calculated: ${prices}`);
  if (failed) console.log(`  PATCH failures:         ${failed}`);
  console.log('');

  grand.total += obs.length; grand.matched += matched; grand.low += low;
  grand.unmatched += unmatched; grand.prices += prices; grand.failed += failed;
}

console.log('─'.repeat(40));
console.log(`GRAND TOTAL across ${SHOP_OUTS.length} shop-outs`);
console.log(`  total observations:     ${grand.total}`);
console.log(`  matched (ai_suggested): ${grand.matched}`);
console.log(`  low_confidence:         ${grand.low}`);
console.log(`  unmatched (score < 2):  ${grand.unmatched}`);
console.log(`  unit prices calculated: ${grand.prices}`);
if (grand.failed) console.log(`  PATCH failures:         ${grand.failed}`);
