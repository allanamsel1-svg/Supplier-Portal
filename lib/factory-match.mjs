// Factory-match scoring: rank factory_product_attributes against a shop-out
// observation. Shared by api/process-shop-out-pair.js (live) and
// scripts/backfill-factory-match.mjs.
//
// Scoring (per the spec):
//   category/sub_category overlap  +3
//   product_type match             +2
//   unit_type match                +2
//   keyword overlap                +1 each, capped at +3

function normKey(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, ''); }
function tokens(s) { return String(s == null ? '' : s).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3); }

// Map a free-text factory unit_type to the observation's normalized_unit space.
function attrUnitNorm(u) {
  if (u == null) return null;
  const s = String(u).toLowerCase();
  if (/fl\s*oz|fluid/.test(s)) return 'volume_oz';
  if (/\bml\b|milli|\bl\b|liter|litre/.test(s)) return 'volume_ml';
  if (/\bg\b|gram|\bkg\b|kilogram/.test(s)) return 'weight_g';
  if (/\boz\b|ounce/.test(s)) return 'weight_oz';
  if (/count|piece|\bpc\b|\bpcs\b|pair|pack|\bpk\b|sheet|wipe|set|kit|unit|bottle|tube|jar/.test(s)) return 'count';
  return null;
}

export function scoreFactoryMatch(obs, attr) {
  let score = 0;
  const segs = new Set((obs && obs.ai_suggested_category ? String(obs.ai_suggested_category).split('>') : []).map(normKey).filter(Boolean));

  // 1. category / sub_category overlap (+3)
  const ac = normKey(attr.category), asub = normKey(attr.sub_category);
  if ((ac && segs.has(ac)) || (asub && segs.has(asub))) score += 3;

  // 2. product_type match (+2) — the type word appears in the obs name/category path
  const pt = normKey(attr.product_type);
  if (pt && pt.length >= 3) {
    const hay = normKey((obs && obs.product_name || '') + ' ' + (obs && obs.ai_suggested_category || ''));
    if (hay.indexOf(pt) !== -1) score += 2;
  }

  // 3. unit_type match (+2)
  const au = attrUnitNorm(attr.unit_type);
  if (au && obs && obs.normalized_unit && au === obs.normalized_unit) score += 2;

  // 4. keyword overlap (+1 each, max +3)
  const kws = Array.isArray(attr.extracted_keywords) ? attr.extracted_keywords : [];
  const obsTok = new Set(tokens((obs && obs.product_name || '') + ' ' + (obs && obs.ai_suggested_category || '')));
  let hits = 0;
  const seenKw = {};
  kws.forEach(k => { const nk = normKey(k); if (nk && !seenKw[nk] && obsTok.has(nk)) { seenKw[nk] = 1; hits++; } });
  score += Math.min(hits, 3);

  return score;
}

// Top-N factory matches for an observation, richest first.
export function rankFactoryMatches(obs, attrs, factoriesById, limit = 5) {
  return (attrs || [])
    .map(a => ({ a, score: scoreFactoryMatch(obs, a) }))
    .filter(x => x.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit)
    .map(x => ({
      score: x.score,
      factory_id: x.a.factory_id,
      factory_name: (factoriesById && factoriesById[x.a.factory_id] || {}).factory_name_english || null,
      product_name: x.a.product_name || null,
      price_usd: x.a.price_usd != null ? Number(x.a.price_usd) : null,
      product_document_id: x.a.product_document_id || null
    }));
}

// Best match → fields to PATCH on the observation. factory_match_id is set only
// when the top score >= 3 (per the spec).
export function bestFactoryMatch(obs, attrs, factoriesById) {
  const ranked = rankFactoryMatches(obs, attrs, factoriesById, 1);
  const top = ranked[0];
  if (!top || top.score < 3) return { factory_match_id: null, factory_match_confidence: null };
  return {
    factory_match_id: top.factory_id,
    factory_match_confidence: Math.round(Math.min(top.score / 10, 1) * 100) / 100
  };
}
