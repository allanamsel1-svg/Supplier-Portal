// One-time backfill: populate shop_out_price_history by comparing observations
// across shop-outs (reusing the live-pipeline logic in lib/price-change.mjs).
//
//   node scripts/backfill-price-history.mjs
//
// Groups priced observations by retailer (shop_outs.customer_id = same retailer
// chain) + brand + product_name + normalized_unit, sorts each group by
// shop_date, and pairs each sighting with its most recent prior whose
// normalized_size is within 30% (same item); flags a >5% change. Logs a summary.

import { buildPriceChangeRow, retailerKey, unitSizeComparable } from '../lib/price-change.mjs';

const SB = 'https://mjkjubctswjwjihxjpnd.supabase.co';
const KEY = process.env.SUPABASE_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1qa2p1YmN0c3dqd2ppaHhqcG5kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczNjQxNjcsImV4cCI6MjA5Mjk0MDE2N30.cZrD_ymrDsRPyfX_g3hUui5_JXuW6BgE77QkIoGpqHo';

function h(path, opts = {}) {
  opts.headers = { ...(opts.headers || {}), apikey: KEY, Authorization: 'Bearer ' + KEY };
  return fetch(SB + path, opts);
}

// Shop-out retailer + date map.
const shops = await (await h('/rest/v1/shop_outs?select=id,customer_id,shop_date,store_location_text')).json();
const shopById = {};
shops.forEach(s => { shopById[s.id] = s; });

// All priced observations.
const obs = await (await h('/rest/v1/shop_out_observations?select=id,brand,product_name,retail_price,unit_price,pack_size,pack_size_unit,normalized_unit,normalized_size,shop_out_id&retail_price=not.is.null&limit=10000')).json();

// Attach shop customer + date + location; keep only rows with a retailer
// (customer_id), date, brand, product, and a normalized_unit (required to
// establish "same item").
const recs = obs.map(o => {
  const s = shopById[o.shop_out_id] || {};
  return { ...o, customer_id: s.customer_id, shop_date: s.shop_date, store_location_text: s.store_location_text };
}).filter(r => retailerKey(r) && r.shop_date && r.brand && r.product_name && r.normalized_unit);

// Group by retailer chain (customer_id) + brand + product + normalized_unit.
const groups = {};
recs.forEach(r => {
  const k = retailerKey(r) + '|' + r.brand.toLowerCase().trim() + '|' + r.product_name.toLowerCase().trim() + '|' + r.normalized_unit;
  (groups[k] = groups[k] || []).push(r);
});

// Within each group, pair each sighting with its most recent prior (earlier
// date) whose normalized_size is within 30% — the same item, not a size variant.
const changes = [];
let multiSightingGroups = 0;
for (const k of Object.keys(groups)) {
  const arr = groups[k].slice().sort((a, b) => (a.shop_date < b.shop_date ? -1 : (a.shop_date > b.shop_date ? 1 : 0)));
  if (new Set(arr.map(r => r.shop_date)).size > 1) multiSightingGroups++;
  for (let i = 0; i < arr.length; i++) {
    const curr = arr[i];
    let prev = null;
    for (let j = i - 1; j >= 0; j--) {
      if (arr[j].shop_date < curr.shop_date && unitSizeComparable(arr[j], curr)) { prev = arr[j]; break; }
    }
    if (!prev) continue;
    const row = buildPriceChangeRow(
      { retail_price: prev.retail_price, shop_date: prev.shop_date, observation_id: prev.id, normalized_unit: prev.normalized_unit, normalized_size: prev.normalized_size },
      {
        retail_price: curr.retail_price, unit_price: curr.unit_price, shop_date: curr.shop_date,
        observation_id: curr.id, shop_out_id: curr.shop_out_id, brand: curr.brand, product_name: curr.product_name,
        retailer: curr.store_location_text, store_location_text: curr.store_location_text,
        pack_size: curr.pack_size, pack_size_unit: curr.pack_size_unit,
        normalized_unit: curr.normalized_unit, normalized_size: curr.normalized_size
      }
    );
    if (row) changes.push(row);
  }
}

let inserted = 0;
if (changes.length) {
  const r = await h('/rest/v1/shop_out_price_history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify(changes)
  });
  if (!r.ok) console.error('Insert failed:', r.status, await r.text());
  else inserted = changes.length;
}

const distinctRetailers = new Set(recs.map(r => retailerKey(r)));
console.log('\nPrice-history backfill');
console.log(`  priced observations considered: ${recs.length}`);
console.log(`  distinct retailers (customer_id): ${distinctRetailers.size}`);
console.log(`  brand×product×retailer groups: ${Object.keys(groups).length}`);
console.log(`  groups sighted on >1 date (comparable): ${multiSightingGroups}`);
console.log(`  price changes (>5%) detected & inserted: ${inserted}`);
