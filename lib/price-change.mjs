// Shared price-change logic for the shop-out pipeline.
// Imported by api/process-shop-out-pair.js (live) and
// scripts/backfill-price-history.mjs (backfill) so both flag changes identically.
//
// A change is flagged when |(new - prev) / prev| > 5%.

const THRESHOLD_PCT = 5;
const SIZE_TOLERANCE = 0.30;   // two sightings are the "same item" only if their
                               // normalized_size is within 30% of each other.
const REVIEW_PCT = 75;         // changes beyond ±75% are flagged needs_review
                               // rather than treated as a confirmed move.

export function median(nums) {
  const a = nums.map(Number).filter(n => isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// Collapse multiple sightings of the same item within a single shop-out (trip)
// into one representative using the MEDIAN retail_price — so a stray misread
// reading in one trip doesn't masquerade as a price change. Records are assumed
// to already share brand + product + normalized_unit; they are grouped by
// shop_out_id. Returns one record per trip.
export function dedupWithinTrip(records) {
  const byTrip = {};
  (records || []).forEach(r => { (byTrip[r.shop_out_id] = byTrip[r.shop_out_id] || []).push(r); });
  return Object.keys(byTrip).map(tripId => {
    const grp = byTrip[tripId];
    if (grp.length === 1) return grp[0];
    const medPrice = median(grp.map(r => r.retail_price));
    const medSize = median(grp.map(r => r.normalized_size));
    // Representative = the member whose price is closest to the median.
    const rep = grp.slice().sort((a, b) =>
      Math.abs(Number(a.retail_price) - medPrice) - Math.abs(Number(b.retail_price) - medPrice))[0];
    const size = medSize != null ? medSize : Number(rep.normalized_size);
    return {
      ...rep,
      retail_price: medPrice,
      normalized_size: size,
      unit_price: (isFinite(size) && size > 0) ? Math.round((medPrice / size) * 10000) / 10000 : (rep.unit_price ?? null)
    };
  });
}

// Same item for price comparison? Requires the same normalized_unit AND both
// normalized_size present and within 30%. Guards against comparing different
// pack sizes of the same product (e.g. a 1-pack vs a 6-pack) as a price change.
export function unitSizeComparable(prev, curr) {
  const pu = prev && prev.normalized_unit, cu = curr && curr.normalized_unit;
  if (!pu || !cu || pu !== cu) return false;
  const ps = Number(prev.normalized_size), cs = Number(curr.normalized_size);
  if (!isFinite(ps) || !isFinite(cs) || ps <= 0 || cs <= 0) return false;
  return Math.abs(ps - cs) / Math.max(ps, cs) <= SIZE_TOLERANCE;
}

// Retailer-match key: shop-outs with the same customer_id are treated as the
// same retailer chain. (Previously matched on free-text store_location_text,
// which never matched 'East Windsor, NJ' to 'New Jersey' and excluded the
// null-location trips entirely.)
export function retailerKey(shopOut) {
  return shopOut && shopOut.customer_id ? shopOut.customer_id : null;
}

export function priceChangePct(prevPrice, currPrice) {
  const o = Number(prevPrice), n = Number(currPrice);
  if (!isFinite(o) || !isFinite(n) || o === 0) return null;
  return ((n - o) / o) * 100;
}

// Build a shop_out_price_history insert row from a prior and current sighting,
// or return null if they are not the same item (unit/size), the prices are
// unusable, or the change is within ±5%.
//   prev: { retail_price, shop_date, observation_id, normalized_unit, normalized_size }
//   curr: { retail_price, unit_price, shop_date, observation_id, shop_out_id,
//           brand, product_name, retailer, store_location_text, pack_size,
//           pack_size_unit, normalized_unit, normalized_size }
export function buildPriceChangeRow(prev, curr) {
  if (!unitSizeComparable(prev, curr)) return null;   // different pack size → not the same item
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
    is_flagged: true,
    needs_review: Math.abs(pct) > REVIEW_PCT   // implausible jump → manual review, not a confirmed move
  };
}
