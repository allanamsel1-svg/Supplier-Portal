// One-time backfill: auto-match existing shop-out observations to Projections SKUs.
//
//   node scripts/backfill-sku-match.mjs [shopOutId]
//
// Scores every observation on the shop-out that has no projection_sku_id yet
// against all active projection_skus (reusing the exact live-pipeline logic in
// lib/sku-match.mjs) and PATCHes the matches. Unmatched rows (score < 2) are
// left untouched. Prints a summary.

import { matchSku } from '../lib/sku-match.mjs';

const SB = 'https://mjkjubctswjwjihxjpnd.supabase.co';
const KEY = process.env.SUPABASE_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1qa2p1YmN0c3dqd2ppaHhqcG5kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczNjQxNjcsImV4cCI6MjA5Mjk0MDE2N30.cZrD_ymrDsRPyfX_g3hUui5_JXuW6BgE77QkIoGpqHo';
const SHOP_OUT = process.argv[2] || '5697924e-cff6-4065-a7c6-0fa9b97543af';

function h(path, opts = {}) {
  opts.headers = { ...(opts.headers || {}), apikey: KEY, Authorization: 'Bearer ' + KEY };
  return fetch(SB + path, opts);
}

const skuR = await h('/rest/v1/projection_skus?status=eq.active&select=id,item_description,size_unit,category,sub_category,sub_sub_category');
if (!skuR.ok) { console.error('Failed to fetch SKUs:', skuR.status, await skuR.text()); process.exit(1); }
const skus = await skuR.json();

const obsR = await h('/rest/v1/shop_out_observations?shop_out_id=eq.' + SHOP_OUT + '&projection_sku_id=is.null&select=id,brand,ai_suggested_category,normalized_unit,normalized_size');
if (!obsR.ok) { console.error('Failed to fetch observations:', obsR.status, await obsR.text()); process.exit(1); }
const obs = await obsR.json();

let matched = 0, low = 0, unmatched = 0, failed = 0;
for (const o of obs) {
  const patch = matchSku(o, skus);
  if (!patch.projection_sku_id) { unmatched++; continue; }       // score < 2 → leave null
  const r = await h('/rest/v1/shop_out_observations?id=eq.' + o.id, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch)
  });
  if (!r.ok) { failed++; console.error('PATCH failed', o.id, r.status, await r.text()); continue; }
  if (patch.sku_match_method === 'ai_suggested') matched++; else low++;
}

console.log(`\nBackfill complete on shop_out ${SHOP_OUT}`);
console.log(`  candidates (no prior match): ${obs.length}`);
console.log(`  matched (ai_suggested):      ${matched}`);
console.log(`  low_confidence:              ${low}`);
console.log(`  unmatched (score < 2):       ${unmatched}`);
if (failed) console.log(`  PATCH failures:              ${failed}`);
