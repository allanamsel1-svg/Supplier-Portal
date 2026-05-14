// ============================================================
// /api/find-similar-quotes.js
// Builds the comparison universe for a quote — the set of
// historical quotes it gets benchmarked against in scoring v2.
//
// POST { quote_id: <uuid> }
//   → { success: true, comparison_set: {...}, quotes: [...] }
//
// Matching hierarchy:
//   1. Exact SKU match (if RFQ ties to existing SKU)
//   2. Category + sub_category match
//   3. AI semantic match on item_description (fallback)
//   4. Manual pins overlay
//
// Result is category-aware: a serum compares to other serums,
// not to lip glosses. Returns up to 50 quotes, newest first.
//
// Requires env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   ANTHROPIC_API_KEY     (optional — only used for semantic match)
//   SCORING_MODEL          (optional — defaults to claude-sonnet-4-6)
// ============================================================

const _sdk = require('@anthropic-ai/sdk');
const Anthropic = _sdk.default || _sdk.Anthropic || _sdk;

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.SCORING_MODEL || 'claude-sonnet-4-6';

const COMPARISON_SET_CAP = 50;

// ── Supabase helper ──────────────────────────────────────────
async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Supabase ${res.status}: ${txt}`);
  }
  return res.status === 204 ? null : await res.json();
}

// ── Per-unit price normalization ─────────────────────────────
// Returns { value, basis } or null if can't normalize.
// Looks at fields like fill_volume, pack_quantity, fob_price, etc.
function calcPricePerUnit(quote, rfq) {
  const fob = parseFloat(quote.fob_price_usd || quote.fob_price || 0);
  if (!fob || isNaN(fob)) return null;

  // Try fill_volume_ml first (most common for cosmetics)
  const volMl = parseFloat(quote.fill_volume_ml || rfq?.fill_volume_ml || 0);
  if (volMl > 0) return { value: fob / volMl, basis: 'per_ml' };

  // Try fill weight in grams
  const wtG = parseFloat(quote.fill_weight_g || rfq?.fill_weight_g || 0);
  if (wtG > 0) return { value: fob / wtG, basis: 'per_g' };

  // Try pack quantity (e.g. 5-pack of single items)
  const packQty = parseFloat(quote.pack_quantity || rfq?.pack_quantity || 0);
  if (packQty > 1) return { value: fob / packQty, basis: 'per_piece' };

  // Fallback: treat FOB as per-piece for single-unit items
  return { value: fob, basis: 'per_piece' };
}

// ── Matcher 1: Exact SKU match ───────────────────────────────
async function findBySkuMatch(quote, rfq) {
  if (!rfq?.sku_id) return [];
  const rows = await sb(
    `rfq_quotes?select=id,rfq_id,factory_id,fob_price_usd,fob_price,fill_volume_ml,fill_weight_g,pack_quantity,moq,lead_time_days,created_at,rfqs!inner(sku_id,category,sub_category,item_description)` +
    `&rfqs.sku_id=eq.${rfq.sku_id}` +
    `&id=neq.${quote.id}` +
    `&order=created_at.desc` +
    `&limit=${COMPARISON_SET_CAP}`
  );
  return rows || [];
}

// ── Matcher 2: Category + sub_category match ─────────────────
async function findByCategoryMatch(quote, rfq) {
  if (!rfq?.category) return [];
  const subFilter = rfq.sub_category ? `&rfqs.sub_category=eq.${encodeURIComponent(rfq.sub_category)}` : '';
  const rows = await sb(
    `rfq_quotes?select=id,rfq_id,factory_id,fob_price_usd,fob_price,fill_volume_ml,fill_weight_g,pack_quantity,moq,lead_time_days,created_at,rfqs!inner(sku_id,category,sub_category,item_description)` +
    `&rfqs.category=eq.${encodeURIComponent(rfq.category)}` +
    subFilter +
    `&id=neq.${quote.id}` +
    `&order=created_at.desc` +
    `&limit=${COMPARISON_SET_CAP}`
  );
  return rows || [];
}

// ── Matcher 3: AI semantic match (fallback when category is thin) ──
async function findBySemanticMatch(quote, rfq, alreadyFound) {
  if (!ANTHROPIC_API_KEY || !rfq?.item_description) return [];

  // Fetch a recent pool of quotes to consider — last 6 months across all categories
  const sixMonthsAgo = new Date(Date.now() - 180 * 86400 * 1000).toISOString();
  const pool = await sb(
    `rfq_quotes?select=id,rfqs(item_description,category)` +
    `&created_at=gte.${sixMonthsAgo}` +
    `&id=neq.${quote.id}` +
    `&order=created_at.desc` +
    `&limit=200`
  );
  if (!pool || !pool.length) return [];

  // Exclude ones we already matched
  const alreadyIds = new Set(alreadyFound.map(q => q.id));
  const candidates = pool
    .filter(q => !alreadyIds.has(q.id) && q.rfqs?.item_description)
    .slice(0, 100);
  if (!candidates.length) return [];

  // Ask Claude to pick semantically similar items
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const candidateList = candidates
    .map((q, i) => `${i + 1}. ${q.rfqs.item_description}`)
    .join('\n');

  const prompt = `Target product description: "${rfq.item_description}"

Below is a numbered list of past RFQ item descriptions. Return the numbers of the items that are semantically similar to the target — meaning they could reasonably serve as price/spec benchmarks. Be strict: only return items that share the same product type, function, and rough form factor.

${candidateList}

Return ONLY a JSON array of numbers. Empty array if nothing matches. Example: [3, 7, 12]`;

  try {
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = msg.content[0]?.text || '[]';
    const numMatches = text.match(/\[[^\]]*\]/);
    const indices = numMatches ? JSON.parse(numMatches[0]) : [];
    if (!Array.isArray(indices)) return [];
    return indices
      .map(n => candidates[n - 1])
      .filter(Boolean)
      .slice(0, COMPARISON_SET_CAP);
  } catch (err) {
    console.log('Semantic match failed (non-fatal):', err.message);
    return [];
  }
}

// ── Apply manual pins (additions + removals stored on the quote) ──
async function applyManualPins(quote, matched) {
  const added = Array.isArray(quote.comparison_pins_added) ? quote.comparison_pins_added : [];
  const removed = new Set(Array.isArray(quote.comparison_pins_removed) ? quote.comparison_pins_removed : []);

  // Remove blocked pins
  let result = matched.filter(q => !removed.has(q.id));

  // Add manual pins that aren't already in the set
  if (added.length) {
    const existingIds = new Set(result.map(q => q.id));
    const toFetch = added.filter(id => !existingIds.has(id));
    if (toFetch.length) {
      const idList = toFetch.map(id => `"${id}"`).join(',');
      const pinned = await sb(
        `rfq_quotes?select=id,rfq_id,factory_id,fob_price_usd,fob_price,fill_volume_ml,fill_weight_g,pack_quantity,moq,lead_time_days,created_at,rfqs(sku_id,category,sub_category,item_description)` +
        `&id=in.(${idList.replace(/"/g, '')})`
      );
      result = result.concat(pinned || []);
    }
  }
  return result;
}

// ── Main handler ─────────────────────────────────────────────
async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars not set.' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const quote_id = body.quote_id;
  if (!quote_id) return res.status(400).json({ error: 'Missing quote_id in body.' });

  try {
    // Fetch the target quote + its RFQ
    const quotes = await sb(`rfq_quotes?id=eq.${quote_id}&select=*,rfqs(*)`);
    if (!quotes || !quotes.length) return res.status(404).json({ error: 'Quote not found.' });
    const quote = quotes[0];
    const rfq = quote.rfqs;

    // Run matchers in order. Stop early if we hit the cap.
    let matched = await findBySkuMatch(quote, rfq);
    let method = 'sku';

    if (matched.length < COMPARISON_SET_CAP) {
      const more = await findByCategoryMatch(quote, rfq);
      // Dedupe against existing
      const seen = new Set(matched.map(q => q.id));
      for (const m of more) {
        if (!seen.has(m.id)) {
          matched.push(m);
          seen.add(m.id);
        }
        if (matched.length >= COMPARISON_SET_CAP) break;
      }
      if (matched.length > 0) method = 'category';
    }

    // If still thin, try semantic match
    if (matched.length < 5) {
      const semantic = await findBySemanticMatch(quote, rfq, matched);
      const seen = new Set(matched.map(q => q.id));
      for (const m of semantic) {
        if (!seen.has(m.id)) {
          matched.push(m);
          seen.add(m.id);
        }
        if (matched.length >= COMPARISON_SET_CAP) break;
      }
      if (semantic.length > 0) method = 'semantic';
    }

    // Apply manual pins
    matched = await applyManualPins(quote, matched);

    // Compute per-unit price for each
    matched = matched.map(q => {
      const pu = calcPricePerUnit(q, q.rfqs);
      return { ...q, price_per_unit: pu?.value || null, price_per_unit_basis: pu?.basis || null };
    });

    // Cap at COMPARISON_SET_CAP
    matched = matched.slice(0, COMPARISON_SET_CAP);

    // Calculate aggregate stats for the set
    const unitPrices = matched
      .map(q => q.price_per_unit)
      .filter(p => p != null && !isNaN(p) && p > 0)
      .sort((a, b) => a - b);
    const stats = unitPrices.length ? {
      min: unitPrices[0],
      max: unitPrices[unitPrices.length - 1],
      median: unitPrices[Math.floor(unitPrices.length / 2)],
      mean: unitPrices.reduce((a, b) => a + b, 0) / unitPrices.length,
      count: unitPrices.length
    } : null;

    return res.status(200).json({
      success: true,
      comparison_set: {
        method,
        size: matched.length,
        ids: matched.map(q => q.id),
        price_stats: stats
      },
      quotes: matched
    });
  } catch (err) {
    console.error('find-similar-quotes error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}

module.exports = handler;
module.exports.default = handler;
