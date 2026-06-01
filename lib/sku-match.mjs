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

// ─── Category gating ─────────────────────────────────────────────────
// Map any category text (an observation's ai_suggested_category path, or a
// SKU's category fields) to one canonical top-level group. A wrong-category
// match is worse than no match, so matching is HARD-BLOCKED across groups.
export function categoryGroup(text) {
  const s = String(text == null ? '' : text).toLowerCase();
  if (/intimate|nipple|\bbra\b|shapewear|breast|pasties|bodysuit/.test(s)) return 'intimate';
  if (/fashion tape|fashion accessor|body tape|contour tape/.test(s)) return 'fashion';
  if (/lip care|lip treatment|lip balm|lip mask|lip oil/.test(s)) return 'lip_care';
  if (/cosmetic|makeup|make-up|mascara|eyeliner|eye ?shadow|eye makeup|\blash|lip gloss|lipstick|foundation|concealer|\bblush\b|setting spray|applicator|sponge|nail/.test(s)) return 'cosmetics';
  if (/hair care|haircare|shampoo|conditioner|hair styling|hair color|hair colour|hair treatment|hair mask|edge control|hair oil|scalp|dry shampoo/.test(s)) return 'hair_care';
  if (/fragrance|perfume|cologne|body spray|body mist|eau de/.test(s)) return 'fragrance';
  if (/skin care|skincare|serum|moistur|cleanser|toner|face mask|facial|essence|\bcream\b|lotion|sunscreen|body scrub|body butter|foot mask|acne|blemish|eye cream|exfoliant|face oil/.test(s)) return 'skin_care';
  if (/personal care|deodorant|shaving|hair removal|wax strip|\boral\b|toothpaste|floss|feminine|bath/.test(s)) return 'personal_care';
  return null;
}
export function obsGroup(obs) {
  return categoryGroup(obs && obs.ai_suggested_category);
}
export function skuGroup(sku) {
  return categoryGroup(sku && sku.sub_category) || categoryGroup(sku && sku.sub_sub_category) || categoryGroup(sku && sku.category);
}

// Fine product-type classifier for the RULE 3 same-category precision penalty.
// Order matters — more specific buckets first. Covers the named conflicts
// (face mask ≠ foot mask, serum ≠ cream, conditioner ≠ styling, eye makeup ≠
// makeup tools) and generalizes to other clearly-different sub-types.
function fineType(text) {
  const s = String(text == null ? '' : text).toLowerCase();
  // skin care
  if (/foot/.test(s) && /(mask|peel)/.test(s)) return 'foot_mask';
  if (/\bmask\b/.test(s) && !/foot/.test(s)) return 'face_mask';
  if (/serum|essence|ampoule|face oil|facial oil/.test(s)) return 'serum';
  if (/cream|moistur|lotion|butter/.test(s)) return 'cream';
  if (/cleanser|face wash|facial wash|cleansing/.test(s)) return 'cleanser';
  if (/toner|mist/.test(s)) return 'toner';
  if (/scrub|exfoliat/.test(s)) return 'scrub';
  // hair care
  if (/conditioner/.test(s)) return 'conditioner';
  if (/shampoo/.test(s)) return 'shampoo';
  if (/styling|edge control|pomade|\bwax\b|\bgel\b|mousse|hairspray|hair spray|hair color|hair colour|\btint\b/.test(s)) return 'styling';
  // cosmetics
  if (/lip gloss|lipstick|lip tint|lip stain|lip lacquer|lip plumper|lip liner/.test(s)) return 'lip_cosmetic';
  if (/mascara|eyeliner|eye ?shadow|\bbrow\b|\blash/.test(s)) return 'eye_makeup';
  if (/sponge|applicator|brush|puff|blender/.test(s)) return 'makeup_tools';
  if (/\bnail\b/.test(s)) return 'nail';
  if (/remover|makeup wipe|cleansing wipe/.test(s)) return 'makeup_remover';
  return null;
}

// Score a SAME-CATEGORY candidate. Baseline +3 (category confirmed), then
// reward sub-type alignment / penalize ANY clearly-different sub-type, plus
// unit/size. A different recognized sub-type is a -3 hit (RULE 3, generalized).
function scoreSameCategory(obs, sku) {
  const fo = fineType((obs.product_name || '') + ' ' + (obs.ai_suggested_category || ''));
  const fs = fineType((sku.item_description || '') + ' ' + (sku.sub_sub_category || ''));
  // Different recognized sub-types is a HARD disqualifier — unit/size can never
  // rescue a clear product-type mismatch (e.g. lip gloss vs makeup sponges).
  if (fo && fs && fo !== fs) return -100;
  let score = 3; // same top-level category (pre-filtered)
  if (fo && fs && fo === fs) score += 3;
  // sub-category / sub_sub_category literal alignment with the obs path
  const segs = new Set((obs.ai_suggested_category ? String(obs.ai_suggested_category).split('>') : []).map(normKey));
  const ss = normKey(sku.sub_sub_category), sub = normKey(sku.sub_category);
  if (ss && segs.has(ss)) score += 2;
  else if (sub && segs.has(sub)) score += 1;
  // unit + size proximity
  const sp = parseSizeUnit(sku.size_unit);
  const um = !!(obs.normalized_unit && sp.unit && obs.normalized_unit === sp.unit);
  if (um) {
    score += 2;
    const os = numOrNull(obs.normalized_size);
    if (os != null && os > 0 && sp.size != null && sp.size > 0) {
      const d = Math.abs(os - sp.size) / Math.max(os, sp.size);
      if (d <= 0.10) score += 2; else if (d <= 0.30) score += 1; else if (d > 0.50) score -= 1;
    }
  }
  // brand appears in description (rare for private label)
  const b = normKey(obs.brand);
  if (b && b.length >= 2 && normKey(sku.item_description).includes(b)) score += 3;
  return score;
}

// Match an observation to a SKU under hard category blocks.
//   - different top-level category → never matched (RULE 1 + 2)
//   - same category but no SKUs in it → is_category_gap = true (RULE 4)
//   - best same-category score >= 6 → ai_suggested, 4-5 → ai_low_confidence,
//     < 4 (category baseline alone, or a RULE 3 sub-type conflict) → no match.
//     Category alone (+3) is NOT enough — a real sub-type/unit signal is required.
export function matchSku(obs, skus) {
  const NONE = { projection_sku_id: null, sku_match_method: null, sku_match_confidence: null, is_category_gap: false };
  const og = obsGroup(obs);
  if (!og) return NONE;                                  // can't classify → silence, not a gap

  const eligible = (skus || []).filter(s => skuGroup(s) === og);
  if (!eligible.length) {
    return { projection_sku_id: null, sku_match_method: null, sku_match_confidence: null, is_category_gap: true };
  }

  let best = null, bestScore = -Infinity;
  for (const sku of eligible) {
    const s = scoreSameCategory(obs, sku);
    if (s > bestScore) { bestScore = s; best = sku; }
  }
  if (!best || bestScore < 4) return NONE;               // category-only / conflicting → silence

  const method = bestScore >= 6 ? 'ai_suggested' : 'ai_low_confidence';
  return {
    projection_sku_id: best.id,
    sku_match_method: method,
    sku_match_confidence: Math.round(Math.min(bestScore / 10, 1) * 100) / 100,
    is_category_gap: false
  };
}
