// ============================================================
// /api/score-quote.js — v2 RFQ scoring
//
// Compliance gate (binary) + 100-point composite across 5 dimensions:
//   1. Price-for-Quality       50 pts  (spec_match × price_competitiveness)
//   2. Factory track record    25 pts
//   3. MOQ fit                 10 pts
//   4. Lead time               10 pts
//   5. Submission completeness  5 pts
//
// Compliance gate is BINARY — blocked quotes cannot be promoted to PO,
// but they still get scored so admin sees what would have been.
//
// POST { quote_id: <uuid> }
//   → { success: true, score: {...} }
//
// Env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY
//   SCORING_MODEL (defaults to claude-opus-4-7)
// ============================================================

const _sdk = require('@anthropic-ai/sdk');
const Anthropic = _sdk.default || _sdk.Anthropic || _sdk;

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.SCORING_MODEL || 'claude-opus-4-7';

const W = { price_quality: 50, factory_track: 25, moq_fit: 10, lead_time: 10, completeness: 5 };
const TIER = { green: 85, yellow: 70 };

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

// ── PDF fetcher ──────────────────────────────────────────────
async function fetchPdfBase64(urlOrPath) {
  let url;
  if (/^https?:\/\//i.test(urlOrPath)) {
    url = urlOrPath;
  } else {
    const path = String(urlOrPath).replace(/^\/+/, '');
    url = `${SUPABASE_URL}/storage/v1/object/factory-files/${path}`;
  }
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
    }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`PDF fetch ${res.status} for ${url} — ${body.slice(0, 200)}`);
  }
  const buf = await res.arrayBuffer();
  return Buffer.from(buf).toString('base64');
}

// ── Per-unit price normalization ─────────────────────────────
function calcPricePerUnit(quote, rfq) {
  const fob = parseFloat(quote.fob_price_usd || quote.fob_price || 0);
  if (!fob || isNaN(fob)) return null;
  const volMl = parseFloat(quote.fill_volume_ml || rfq?.fill_volume_ml || 0);
  if (volMl > 0) return { value: fob / volMl, basis: 'per_ml' };
  const wtG = parseFloat(quote.fill_weight_g || rfq?.fill_weight_g || 0);
  if (wtG > 0) return { value: fob / wtG, basis: 'per_g' };
  const packQty = parseFloat(quote.pack_quantity || rfq?.pack_quantity || 0);
  if (packQty > 1) return { value: fob / packQty, basis: 'per_piece' };
  return { value: fob, basis: 'per_piece' };
}

async function fetchComparisonSet(quote_id, baseUrl) {
  const url = `${baseUrl}/api/find-similar-quotes`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quote_id })
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`find-similar-quotes failed (${r.status}): ${txt.slice(0, 200)}`);
  }
  return await r.json();
}

// ── COMPLIANCE GATE ──────────────────────────────────────────
async function runComplianceGate(quote, rfq, factory) {
  const reasons = [];
  const reqCerts = rfq.required_certifications || [];
  if (reqCerts.length) {
    const docs = await sb(
      `factory_documents?factory_id=eq.${quote.factory_id}` +
      `&select=cert_type,cert_status,expiry_date,scope,uploaded_at` +
      `&cert_status=eq.approved`
    );
    const factoryDocs = docs || [];
    const today = new Date().toISOString().slice(0, 10);
    for (const required of reqCerts) {
      const reqType = (required.cert_type || required).toLowerCase();
      const matching = factoryDocs.find(d => (d.cert_type || '').toLowerCase() === reqType);
      if (!matching) {
        reasons.push({
          code: 'missing_required_cert',
          label: `Required certification missing: ${required.cert_type || required}`,
          severity: 'blocker',
          detail: 'Factory has not uploaded this certification.'
        });
        continue;
      }
      if (matching.expiry_date && matching.expiry_date < today) {
        reasons.push({
          code: 'expired_required_cert',
          label: `${matching.cert_type} expired ${matching.expiry_date}`,
          severity: 'blocker',
          detail: 'Required certification has lapsed and must be renewed before order.'
        });
      }
      if (required.required_scope && matching.scope) {
        const scopeMatch = String(matching.scope).toLowerCase().includes(String(required.required_scope).toLowerCase());
        if (!scopeMatch) {
          reasons.push({
            code: 'scope_mismatch',
            label: `${matching.cert_type} scope does not cover ${required.required_scope}`,
            severity: 'blocker',
            detail: `Scope: "${matching.scope}", needed: "${required.required_scope}".`
          });
        }
      }
    }
  }
  if (factory && factory.compliance_status === 'non_compliant') {
    reasons.push({
      code: 'factory_non_compliant',
      label: 'Factory flagged non-compliant in master record',
      severity: 'blocker',
      detail: factory.compliance_notes || 'Resolve factory-level compliance issues before ordering.'
    });
  }
  return { status: reasons.length ? 'blocked' : 'pass', reasons };
}

// ── DIMENSIONS ──────────────────────────────────────────────
function scorePriceCompetitiveness(quote, comparisonStats, calcPpu) {
  if (!calcPpu || !comparisonStats || !comparisonStats.count) {
    return { competitiveness: 0.6, detail: 'No comparison set — neutral baseline.', context: null };
  }
  const myPpu = calcPpu.value;
  const { min, median, count } = comparisonStats;
  let competitiveness;
  if (myPpu <= min) competitiveness = 1.0;
  else if (myPpu <= median) {
    competitiveness = 1.0 - 0.4 * ((myPpu - min) / Math.max(median - min, 0.0001));
  } else {
    const threshold = median * 1.5;
    if (myPpu >= threshold) competitiveness = 0.0;
    else competitiveness = 0.6 - 0.6 * ((myPpu - median) / Math.max(threshold - median, 0.0001));
  }
  competitiveness = Math.max(0, Math.min(1, competitiveness));
  const pctVsMedian = median > 0 ? ((myPpu - median) / median) * 100 : 0;
  const pctVsBest = min > 0 ? ((myPpu - min) / min) * 100 : 0;
  return {
    competitiveness,
    detail: `Per ${calcPpu.basis.replace('per_', '')}: $${myPpu.toFixed(4)}. ` +
            `Set median: $${median.toFixed(4)} (${pctVsMedian >= 0 ? '+' : ''}${pctVsMedian.toFixed(1)}%). ` +
            `Set best: $${min.toFixed(4)} (${pctVsBest >= 0 ? '+' : ''}${pctVsBest.toFixed(1)}%). ` +
            `Comparison size: ${count}.`,
    context: { my_per_unit: myPpu, basis: calcPpu.basis, set_stats: comparisonStats, pct_vs_median: pctVsMedian, pct_vs_best: pctVsBest }
  };
}

async function scoreFactoryTrack(factory) {
  let score = 0;
  const components = [];
  const past = await sb(
    `rfq_quotes?factory_id=eq.${factory.id}&select=id,status,created_at&order=created_at.desc&limit=50`
  );
  const pastQuotes = past || [];
  const wonCount = pastQuotes.filter(q => q.status === 'accepted').length;
  const totalQuotes = pastQuotes.length;
  const winRate = totalQuotes > 0 ? wonCount / totalQuotes : null;
  if (totalQuotes >= 3) {
    const respScore = Math.min(10, totalQuotes / 5);
    score += respScore;
    components.push({ label: 'RFQ engagement', score: respScore.toFixed(1), basis: `${totalQuotes} past quotes` });
    if (winRate !== null) {
      const wrScore = Math.min(10, winRate * 30);
      score += wrScore;
      components.push({ label: 'Win rate', score: wrScore.toFixed(1), basis: `${(winRate * 100).toFixed(0)}% (${wonCount}/${totalQuotes})` });
    }
  } else {
    score += 8;
    components.push({ label: 'Limited history', score: '8.0', basis: 'New supplier — baseline applied' });
  }
  const recentDocs = await sb(
    `factory_documents?factory_id=eq.${factory.id}&select=cert_status,expiry_date&order=uploaded_at.desc&limit=20`
  );
  const docs = recentDocs || [];
  const today = new Date().toISOString().slice(0, 10);
  const approvedCount = docs.filter(d => d.cert_status === 'approved' && (!d.expiry_date || d.expiry_date >= today)).length;
  const expiredCount = docs.filter(d => d.expiry_date && d.expiry_date < today).length;
  if (docs.length > 0) {
    const compScore = Math.max(0, 5 - expiredCount);
    score += compScore;
    components.push({ label: 'Compliance currency', score: compScore.toFixed(1), basis: `${approvedCount} current, ${expiredCount} expired` });
  }
  const profileFields = ['factory_name_english', 'address', 'sales_email', 'sales_mobile', 'product_categories'];
  const filled = profileFields.filter(f => factory[f] && String(factory[f]).trim()).length;
  const profScore = (filled / profileFields.length) * 5;
  score += profScore;
  components.push({ label: 'Profile completeness', score: profScore.toFixed(1), basis: `${filled}/${profileFields.length} key fields filled` });
  return {
    score: Math.min(W.factory_track, score),
    detail: 'Factory track record (proxies until Tier 1 scorecards land).',
    components
  };
}

function scoreMoq(quote, rfq) {
  const target = parseFloat(rfq.target_moq || rfq.moq || 0);
  const quoted = parseFloat(quote.moq || 0);
  if (!target || !quoted) return { score: W.moq_fit * 0.7, detail: 'MOQ target/quote not specified — neutral.' };
  if (quoted <= target) return { score: W.moq_fit, detail: `Quoted MOQ ${quoted} ≤ target ${target}. Full points.` };
  const pct = quoted / target;
  let score;
  if (pct <= 1.25) score = W.moq_fit * 0.8;
  else if (pct <= 1.5) score = W.moq_fit * 0.5;
  else if (pct <= 2.0) score = W.moq_fit * 0.2;
  else score = 0;
  return { score, detail: `Quoted MOQ ${quoted} is ${pct.toFixed(2)}× target of ${target}.` };
}

function scoreLeadTime(quote, rfq) {
  const target = parseInt(rfq.target_lead_time_days || rfq.lead_time_days || 0, 10);
  const quoted = parseInt(quote.lead_time_days || 0, 10);
  if (!target || !quoted) return { score: W.lead_time * 0.7, detail: 'Lead-time target/quote not specified — neutral.' };
  if (quoted <= target) return { score: W.lead_time, detail: `Quoted ${quoted}d ≤ target ${target}d. Full points.` };
  const slip = quoted - target;
  let score;
  if (slip <= 7) score = W.lead_time * 0.7;
  else if (slip <= 14) score = W.lead_time * 0.4;
  else if (slip <= 30) score = W.lead_time * 0.15;
  else score = 0;
  return { score, detail: `Quoted ${quoted}d vs target ${target}d. Slip: ${slip}d.` };
}

function scoreCompleteness(quote) {
  const fields = [
    'fob_price_usd', 'fob_price', 'moq', 'lead_time_days',
    'fill_volume_ml', 'fill_weight_g', 'pack_quantity',
    'inci_pdf_url', 'formulation_pdf_url', 'packaging_notes'
  ];
  const present = fields.filter(f => quote[f] != null && String(quote[f]).trim() !== '').length;
  const ratio = Math.min(1, present / 7);
  return { score: W.completeness * ratio, detail: `${present} of ${fields.length} key quote fields populated.` };
}

async function scorePriceForQuality(quote, rfq, factory, criteria, pdfRefs, comparisonStats, calcPpu) {
  const priceResult = scorePriceCompetitiveness(quote, comparisonStats, calcPpu);
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const promptText = buildSpecMatchPrompt(quote, rfq, factory, criteria);
  const content = [...pdfRefs.map(p => p.block), { type: 'text', text: promptText }];
  let specMatch = 0.5;
  let specMatchDetail = 'Spec match scoring failed — used neutral baseline.';
  let specBreakdown = null;
  let regulatoryViolations = [];
  try {
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 3000,
      messages: [{ role: 'user', content }]
    });
    const text = msg.content[0]?.text || '';
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const parsed = JSON.parse(text.slice(start, end + 1));
      specMatch = Math.max(0, Math.min(1, parsed.spec_match || 0.5));
      specMatchDetail = parsed.summary || 'Spec match scored by AI rubric.';
      specBreakdown = parsed.breakdown || [];
      regulatoryViolations = parsed.regulatory_violations || [];
    }
  } catch (err) {
    console.log('Spec match AI call failed:', err.message);
  }
  const finalScore = W.price_quality * specMatch * priceResult.competitiveness;
  return {
    score: finalScore,
    detail: `Spec match ${(specMatch * 100).toFixed(0)}% × Price competitiveness ${(priceResult.competitiveness * 100).toFixed(0)}% = ${finalScore.toFixed(1)} / ${W.price_quality}.`,
    spec_match: specMatch,
    price_competitiveness: priceResult.competitiveness,
    spec_match_detail: specMatchDetail,
    spec_breakdown: specBreakdown,
    price_context: priceResult.context,
    regulatory_violations: regulatoryViolations
  };
}

function buildSpecMatchPrompt(quote, rfq, factory, criteria) {
  return `You are evaluating a factory quote against an RFQ for an off-price retail sourcing business. Your only task in this step is to assess how closely the quoted product matches the requested specifications — not the price.

# RFQ asked for
${JSON.stringify({
  item_description: rfq.item_description,
  category: rfq.category,
  sub_category: rfq.sub_category,
  target_markets: rfq.target_markets,
  inci_requirements: rfq.inci_requirements,
  packaging: rfq.packaging,
  fill_volume_ml: rfq.fill_volume_ml,
  fill_weight_g: rfq.fill_weight_g,
  claims: rfq.claims,
  notes: rfq.notes
}, null, 2)}

# Factory quoted
${JSON.stringify({
  fob_price_usd: quote.fob_price_usd || quote.fob_price,
  moq: quote.moq,
  lead_time_days: quote.lead_time_days,
  fill_volume_ml: quote.fill_volume_ml,
  fill_weight_g: quote.fill_weight_g,
  packaging_notes: quote.packaging_notes,
  formulation_notes: quote.formulation_notes,
  notes: quote.notes
}, null, 2)}

# Criteria
${JSON.stringify(criteria, null, 2)}

# Task
1. Read attached PDF documents (INCI, formulation, certifications, packaging) carefully.
2. Compare against what was requested.
3. Output spec_match 0.0-1.0:
   - 1.0 = INCI matches exactly, formulation exactly, packaging matches, claims supported
   - 0.8 = Very close — minor cosmetic differences only
   - 0.6 = Right product type but meaningful variances
   - 0.4 = Same category but different formulation or specs
   - 0.2 = Wrong product type but adjacent
   - 0.0 = Not what was asked for
4. Flag regulatory violations separately (banned ingredients for target markets).

# Output
Return ONLY a JSON object. No markdown, no preamble.

{
  "spec_match": <float 0.0 to 1.0>,
  "summary": "<one sentence>",
  "breakdown": [
    { "aspect": "INCI", "match": <float>, "note": "<one sentence>" },
    { "aspect": "Formulation", "match": <float>, "note": "..." },
    { "aspect": "Packaging", "match": <float>, "note": "..." },
    { "aspect": "Fill volume", "match": <float>, "note": "..." },
    { "aspect": "Claims support", "match": <float>, "note": "..." }
  ],
  "regulatory_violations": [
    { "ingredient": "<name>", "severity": "banned|restricted|warning", "market": "<EU|US|CA>", "detail": "<reason>" }
  ]
}`;
}

function mergeCriteria(parent, child) {
  parent = parent || {};
  child = child || {};
  const result = {};
  for (const k of ['regulatory_profile', 'target_markets']) {
    const s = new Set([...(parent[k] || []), ...(child[k] || [])]);
    if (s.size) result[k] = [...s];
  }
  const pBan = parent.banned_ingredients_check?.lists || [];
  const cBan = child.banned_ingredients_check?.lists || [];
  const banSet = new Set([...pBan, ...cBan]);
  if (banSet.size) result.banned_ingredients_check = { lists: [...banSet], weight: 10 };
  for (const k of ['required_certifications', 'numeric_specs', 'boolean_specs', 'ai_rubrics']) {
    const byKey = new Map();
    for (const it of (parent[k] || [])) byKey.set((it.key || it.name || '').toLowerCase(), it);
    for (const it of (child[k] || [])) byKey.set((it.key || it.name || '').toLowerCase(), it);
    if (byKey.size) result[k] = [...byKey.values()];
  }
  if (child.cost_quality) result.cost_quality = child.cost_quality;
  else if (parent.cost_quality) result.cost_quality = parent.cost_quality;
  return result;
}

async function getEffectiveCriteria(rfq) {
  const cats = await sb(`categories?category=eq.${encodeURIComponent(rfq.category || '')}&select=*`);
  const top = cats.find(c => !c.sub_category && !c.sub_sub_category);
  const sub = rfq.sub_category ? cats.find(c => c.sub_category === rfq.sub_category && !c.sub_sub_category) : null;
  const subsub = rfq.sub_sub_category ? cats.find(c => c.sub_sub_category === rfq.sub_sub_category) : null;
  let merged = top?.scoring_criteria || {};
  if (sub?.scoring_criteria) merged = mergeCriteria(merged, sub.scoring_criteria);
  if (subsub?.scoring_criteria) merged = mergeCriteria(merged, subsub.scoring_criteria);
  if (rfq.scoring_criteria_override) merged = mergeCriteria(merged, rfq.scoring_criteria_override);
  return merged;
}

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set in Vercel.' });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars not set.' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const quote_id = body.quote_id;
  if (!quote_id) return res.status(400).json({ error: 'Missing quote_id in body.' });

  try {
    const quotes = await sb(`rfq_quotes?id=eq.${quote_id}&select=*,rfqs(*),factories(*)`);
    if (!quotes || !quotes.length) return res.status(404).json({ error: 'Quote not found.' });
    const quote = quotes[0];
    const rfq = quote.rfqs;
    const factory = quote.factories;
    if (!rfq) return res.status(404).json({ error: 'RFQ not found.' });
    if (!factory) return res.status(404).json({ error: 'Factory not found.' });

    const criteria = await getEffectiveCriteria(rfq);
    const pdfRefs = [];
    const pdfFields = [
      { field: 'inci_pdf_url', label: 'INCI' },
      { field: 'formulation_pdf_url', label: 'Formulation' },
      { field: 'packaging_spec_url', label: 'Packaging Spec' }
    ];
    for (const pf of pdfFields) {
      if (quote[pf.field]) {
        try {
          const b64 = await fetchPdfBase64(quote[pf.field]);
          pdfRefs.push({
            label: pf.label,
            block: { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
          });
        } catch (e) {
          console.log(`PDF ${pf.label} fetch failed:`, e.message);
        }
      }
    }

    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const baseUrl = `${proto}://${host}`;

    let comparisonData = null;
    try { comparisonData = await fetchComparisonSet(quote_id, baseUrl); }
    catch (e) { console.log('Comparison set fetch failed:', e.message); }
    const comparisonStats = comparisonData?.comparison_set?.price_stats || null;

    const calcPpu = calcPricePerUnit(quote, rfq);

    const gate = await runComplianceGate(quote, rfq, factory);

    const dPriceQuality = await scorePriceForQuality(quote, rfq, factory, criteria, pdfRefs, comparisonStats, calcPpu);
    const dFactoryTrack = await scoreFactoryTrack(factory);
    const dMoq = scoreMoq(quote, rfq);
    const dLeadTime = scoreLeadTime(quote, rfq);
    const dCompleteness = scoreCompleteness(quote);

    if (dPriceQuality.regulatory_violations && dPriceQuality.regulatory_violations.length) {
      for (const v of dPriceQuality.regulatory_violations) {
        if (v.severity === 'banned' || v.severity === 'prohibited') {
          gate.status = 'blocked';
          gate.reasons.push({
            code: 'banned_ingredient',
            label: `Banned ingredient: ${v.ingredient} (${v.market || 'target market'})`,
            severity: 'blocker',
            detail: v.detail
          });
        }
      }
    }

    const overall = Math.round(
      dPriceQuality.score + dFactoryTrack.score + dMoq.score + dLeadTime.score + dCompleteness.score
    );
    let tier;
    if (gate.status === 'blocked') tier = 'blocked';
    else if (overall >= TIER.green) tier = 'green';
    else if (overall >= TIER.yellow) tier = 'yellow';
    else tier = 'red';

    const breakdown = {
      compliance_gate: gate,
      dimensions: [
        {
          key: 'price_quality',
          label: 'Price-for-Quality',
          weight: W.price_quality,
          score: parseFloat(dPriceQuality.score.toFixed(1)),
          detail: dPriceQuality.detail,
          components: {
            spec_match: dPriceQuality.spec_match,
            spec_match_detail: dPriceQuality.spec_match_detail,
            spec_breakdown: dPriceQuality.spec_breakdown,
            price_competitiveness: dPriceQuality.price_competitiveness,
            price_context: dPriceQuality.price_context
          }
        },
        {
          key: 'factory_track',
          label: 'Factory track record',
          weight: W.factory_track,
          score: parseFloat(dFactoryTrack.score.toFixed(1)),
          detail: dFactoryTrack.detail,
          components: dFactoryTrack.components
        },
        { key: 'moq_fit', label: 'MOQ fit', weight: W.moq_fit, score: parseFloat(dMoq.score.toFixed(1)), detail: dMoq.detail },
        { key: 'lead_time', label: 'Lead time', weight: W.lead_time, score: parseFloat(dLeadTime.score.toFixed(1)), detail: dLeadTime.detail },
        { key: 'completeness', label: 'Submission completeness', weight: W.completeness, score: parseFloat(dCompleteness.score.toFixed(1)), detail: dCompleteness.detail }
      ],
      final: { overall_score: overall, tier, max_score: 100 },
      meta: {
        scored_at: new Date().toISOString(),
        model: MODEL,
        pdfs_analyzed: pdfRefs.map(p => p.label),
        comparison_set_method: comparisonData?.comparison_set?.method || null,
        comparison_set_size: comparisonData?.comparison_set?.size || 0,
        weights: W,
        tier_thresholds: TIER
      }
    };

    await sb(`rfq_quotes?id=eq.${quote_id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        score_overall_v2: overall,
        score_tier: tier,
        score_breakdown_v2: breakdown,
        compliance_gate_status: gate.status,
        compliance_gate_reasons: gate.reasons,
        price_per_unit_calculated: calcPpu?.value || null,
        price_per_unit_basis: calcPpu?.basis || null,
        comparison_set: comparisonData?.comparison_set || null,
        scored_v2_at: new Date().toISOString(),
        scored_v2_model: MODEL
      })
    });

    return res.status(200).json({ success: true, score: { overall, tier, breakdown } });
  } catch (err) {
    console.error('score-quote v2 error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}

module.exports = handler;
module.exports.default = handler;
