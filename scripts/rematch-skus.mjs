// RULE 5 — clear every observation's projection_sku_id and re-run SKU matching
// with the corrected category-blocked rules in lib/sku-match.mjs.
//
//   node scripts/rematch-skus.mjs
//
// Overwrites projection_sku_id / sku_match_method / sku_match_confidence /
// is_category_gap on every observation (so stale matches are cleared), and logs
// valid matches, category-gap flags, and previously-wrong matches now nulled.

import { matchSku } from '../lib/sku-match.mjs';

const SB = 'https://mjkjubctswjwjihxjpnd.supabase.co';
const KEY = process.env.SUPABASE_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1qa2p1YmN0c3dqd2ppaHhqcG5kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczNjQxNjcsImV4cCI6MjA5Mjk0MDE2N30.cZrD_ymrDsRPyfX_g3hUui5_JXuW6BgE77QkIoGpqHo';

function h(path, opts = {}) {
  opts.headers = { ...(opts.headers || {}), apikey: KEY, Authorization: 'Bearer ' + KEY };
  return fetch(SB + path, opts);
}

const skus = await (await h('/rest/v1/projection_skus?status=eq.active&select=id,item_description,size_unit,category,sub_category,sub_sub_category')).json();
const obs = await (await h('/rest/v1/shop_out_observations?select=id,brand,product_name,ai_suggested_category,normalized_unit,normalized_size,projection_sku_id&limit=10000')).json();

let validMatches = 0, gapFlags = 0, nowNulled = 0, hadMatch = 0, byMethod = { ai_suggested: 0, ai_low_confidence: 0 }, failed = 0;
for (const o of obs) {
  const had = !!o.projection_sku_id;
  if (had) hadMatch++;
  const m = matchSku(o, skus);
  const patch = {
    projection_sku_id: m.projection_sku_id,
    sku_match_method: m.sku_match_method,
    sku_match_confidence: m.sku_match_confidence,
    is_category_gap: m.is_category_gap
  };
  const r = await h('/rest/v1/shop_out_observations?id=eq.' + o.id, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch)
  });
  if (!r.ok) { failed++; console.error('PATCH failed', o.id, r.status, await r.text()); continue; }
  if (m.projection_sku_id) { validMatches++; byMethod[m.sku_match_method] = (byMethod[m.sku_match_method] || 0) + 1; }
  if (m.is_category_gap) gapFlags++;
  if (had && !m.projection_sku_id) nowNulled++;   // previously matched, now correctly cleared
}

console.log('\nSKU re-match (category-blocked rules)');
console.log(`  observations scanned:            ${obs.length}`);
console.log(`  previously had a match:          ${hadMatch}`);
console.log(`  valid matches now:               ${validMatches}  (ai_suggested ${byMethod.ai_suggested || 0}, ai_low_confidence ${byMethod.ai_low_confidence || 0})`);
console.log(`  category-gap flags:              ${gapFlags}`);
console.log(`  previously-wrong matches nulled: ${nowNulled}`);
if (failed) console.log(`  PATCH failures:                  ${failed}`);
