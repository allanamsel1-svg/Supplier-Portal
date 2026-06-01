// Shared unit-normalization + Projections-SKU auto-match logic.
//
// Imported by both api/process-shop-out-pair.js (the live processing pipeline)
// and scripts/backfill-sku-match.mjs (one-time backfill) so the two paths use
// byte-identical logic. The same token lists are mirrored client-side in
// shop_outs.html for the TBG unit-price calculation (kept in sync by hand).

export function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Categorize a unit string into a canonical unit + multiply factor.
// 'fl oz'/'floz' → volume_oz (liquid); bare 'oz' → weight_oz (solid).
export function unitCategory(unitRaw) {
  if (unitRaw == null) return { unit: null, factor: 1 };
  const u = String(unitRaw).toLowerCase().replace(/\./g, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  if (['ml'].includes(u)) return { unit: 'volume_ml', factor: 1 };
  if (['l', 'liter', 'litre'].includes(u)) return { unit: 'volume_ml', factor: 1000 };
  if (['fl oz', 'floz', 'fluid ounce', 'fluid ounces'].includes(u)) return { unit: 'volume_oz', factor: 1 };
  if (['g', 'gr', 'gram', 'grams'].includes(u)) return { unit: 'weight_g', factor: 1 };
  if (['kg', 'kilogram', 'kilograms'].includes(u)) return { unit: 'weight_g', factor: 1000 };
  if (['oz', 'ounce', 'ounces'].includes(u)) return { unit: 'weight_oz', factor: 1 };
  if (['lb', 'lbs', 'pound', 'pounds'].includes(u)) return { unit: 'weight_oz', factor: 16 };
  if (['ct', 'count', 'pc', 'pcs', 'pair', 'pairs', 'pack', 'pk', 'piece', 'pieces'].includes(u)) return { unit: 'count', factor: 1 };
  return { unit: null, factor: 1 };
}

// { normalized_unit, normalized_size, unit_price } for an observation.
// unit_price = retail_price / normalized_size, rounded to 4 dp; null if size 0/null.
export function computeNormalization(packSizeRaw, unitRaw, retailPriceRaw) {
  const { unit, factor } = unitCategory(unitRaw);
  if (!unit) return { normalized_unit: null, normalized_size: null, unit_price: null };
  const size = numOrNull(packSizeRaw);
  const normSize = size != null ? size * factor : null;
  const rp = numOrNull(retailPriceRaw);
  let unitPrice = null;
  if (normSize != null && normSize !== 0 && rp != null) {
    unitPrice = Math.round((rp / normSize) * 10000) / 10000;
  }
  return { normalized_unit: unit, normalized_size: normSize, unit_price: unitPrice };
}

// Parse a free-text size string (e.g. '50ml', '33.8 fl oz', '100 ct', '3 pk',
// '8.1oz+100g+120ml') into { unit, size } using the FIRST number+unit token.
// Returns { unit: null, size: null } when no recognizable size is present
// (e.g. 'N/S', 'kit', 'single', '2.95x197in').
export function parseSizeUnit(text) {
  if (text == null) return { unit: null, size: null };
  const s = String(text).toLowerCase().replace(/_/g, ' ');
  // longest / multi-word tokens first so 'fl oz' beats 'oz', 'ml' beats 'l', etc.
  const m = s.match(/(\d+(?:\.\d+)?)\s*(fl\s*oz|floz|fluid\s*ounces?|kg|ml|lb|gr|grams?|ounces?|oz|ct|count|pcs|pc|pairs|pair|packs|pack|pk|pieces|piece|g|l)\b/);
  if (!m) return { unit: null, size: null };
  const { unit, factor } = unitCategory(m[2]);
  if (!unit) return { unit: null, size: null };
  const n = Number(m[1]);
  return { unit, size: Number.isFinite(n) ? n * factor : null };
}

// Normalize a label for fuzzy equality (case- and punctuation-insensitive) so
// 'Skincare' === 'Skin Care' and 'Face Masks' === 'face-masks'.
function normKey(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Score one Projections SKU against an observation. Higher = better match.
export function scoreSkuMatch(obs, sku) {
  let score = 0;

  // category: best-of tier (sub_sub +3 > sub +2 > category +1), matched against
  // any segment of the observation's ai_suggested_category path.
  const segSet = new Set(
    (obs && obs.ai_suggested_category ? String(obs.ai_suggested_category).split('>') : [])
      .map(normKey).filter(Boolean)
  );
  const cat = normKey(sku.category), sub = normKey(sku.sub_category), ss = normKey(sku.sub_sub_category);
  if (ss && segSet.has(ss)) score += 3;
  else if (sub && segSet.has(sub)) score += 2;
  else if (cat && segSet.has(cat)) score += 1;

  // normalized unit match
  const skuParsed = parseSizeUnit(sku.size_unit);
  const oUnit = obs ? obs.normalized_unit : null;
  const unitsMatch = !!(oUnit && skuParsed.unit && oUnit === skuParsed.unit);
  if (unitsMatch) score += 2;

  // size proximity — only meaningful within the same unit
  const oSize = numOrNull(obs ? obs.normalized_size : null);
  if (unitsMatch && oSize != null && oSize > 0 && skuParsed.size != null && skuParsed.size > 0) {
    const diff = Math.abs(oSize - skuParsed.size) / Math.max(oSize, skuParsed.size);
    if (diff <= 0.10) score += 2;
    else if (diff <= 0.30) score += 1;
    else if (diff > 0.50) score -= 1;
  }

  // brand appears in the SKU item_description
  const brand = normKey(obs ? obs.brand : null);
  if (brand && brand.length >= 2 && normKey(sku.item_description).includes(brand)) score += 3;

  return score;
}

// Pick the best SKU and map the score to the persisted match fields.
//   score >= 4 → ai_suggested
//   score 2-3  → ai_low_confidence
//   score < 2  → no match (projection_sku_id null)
export function matchSku(obs, skus) {
  let best = null, bestScore = -Infinity;
  for (const sku of (skus || [])) {
    const s = scoreSkuMatch(obs, sku);
    if (s > bestScore) { bestScore = s; best = sku; }
  }
  if (!best || bestScore < 2) {
    return { projection_sku_id: null, sku_match_method: null, sku_match_confidence: null };
  }
  const method = bestScore >= 4 ? 'ai_suggested' : 'ai_low_confidence';
  const confidence = Math.min(bestScore / 10, 1.0);
  return {
    projection_sku_id: best.id,
    sku_match_method: method,
    sku_match_confidence: Math.round(confidence * 100) / 100
  };
}
