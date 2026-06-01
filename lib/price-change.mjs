// Shared price-change logic for the shop-out pipeline.
// Imported by api/process-shop-out-pair.js (live) and
// scripts/backfill-price-history.mjs (backfill) so both flag changes identically.
//
// A change is flagged when |(new - prev) / prev| > 5%.

const THRESHOLD_PCT = 5;

export function priceChangePct(prevPrice, currPrice) {
  const o = Number(prevPrice), n = Number(currPrice);
  if (!isFinite(o) || !isFinite(n) || o === 0) return null;
  return ((n - o) / o) * 100;
}

// Build a shop_out_price_history insert row from a prior and current sighting,
// or return null if the prices are unusable or the change is within ±5%.
//   prev: { retail_price, shop_date, observation_id }
//   curr: { retail_price, unit_price, shop_date, observation_id, shop_out_id,
//           brand, product_name, retailer, store_location_text, pack_size, pack_size_unit }
export function buildPriceChangeRow(prev, curr) {
  const pct = priceChangePct(prev.retail_price, curr.retail_price);
  if (pct === null || Math.abs(pct) <= THRESHOLD_PCT) return null;
  const o = Number(prev.retail_price), n = Number(curr.retail_price);
  return {
    brand: curr.brand ?? null,
    product_name: curr.product_name ?? null,
    retailer: curr.retailer ?? null,
    store_location_text: curr.store_location_text ?? null,
    pack_size: curr.pack_size ?? null,
    pack_size_unit: curr.pack_size_unit ?? null,
    unit_price: curr.unit_price ?? null,
    retail_price: n,
    shop_out_id: curr.shop_out_id,
    observation_id: curr.observation_id,
    shop_date: curr.shop_date,
    price_change_pct: Math.round(pct * 100) / 100,
    price_change_direction: n > o ? 'up' : 'down',
    previous_price: o,
    previous_shop_date: prev.shop_date,
    previous_observation_id: prev.observation_id,
    is_flagged: true
  };
}
