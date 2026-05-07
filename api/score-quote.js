// ============================================================
// /api/score-quote.js
// Vercel serverless endpoint that uses Claude to extract values
// from formulation/INCI/cert PDFs and score a quote against the
// merged category criteria + RFQ override.
//
// POST { quote_id: <uuid> }
// → 200 { success: true, scorecard: {...} }
// → 4xx/5xx { error: "..." }
//
// Requires env vars in Vercel:
//   ANTHROPIC_API_KEY            — your Anthropic key
//   SUPABASE_URL                  — same URL used in admin.html (the SB var)
//   SUPABASE_SERVICE_ROLE_KEY     — service role (NOT the anon key) for backend writes
//   SCORING_MODEL                 — optional, defaults to claude-sonnet-4-6
// ============================================================

const _sdk = require('@anthropic-ai/sdk');
const Anthropic = _sdk.default || _sdk.Anthropic || _sdk;

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.SCORING_MODEL || 'claude-sonnet-4-6';

// ── Supabase REST helper ─────────────────────────────────────
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

// ── PDF fetcher (Supabase storage URLs are public for signed buckets) ──
async function fetchPdfBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`PDF fetch ${res.status} ${url}`);
  const buf = await res.arrayBuffer();
  return Buffer.from(buf).toString('base64');
}

// ── Criteria inheritance merge (mirrors setup.html mergeCriteria) ──
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
  const cats = await sb(
    `categories?category=eq.${encodeURIComponent(rfq.category || '')}&select=*`
  );
  const top = cats.find(c => !c.sub_category && !c.sub_sub_category);
  const sub = rfq.sub_category
    ? cats.find(c => c.sub_category === rfq.sub_category && !c.sub_sub_category)
    : null;
  const leaf = rfq.sub_sub_category
    ? cats.find(
        c =>
          c.sub_category === rfq.sub_category &&
          c.sub_sub_category === rfq.sub_sub_category
      )
    : null;
  let merged = {};
  if (top?.scoring_criteria) merged = mergeCriteria(merged, top.scoring_criteria);
  if (sub?.scoring_criteria) merged = mergeCriteria(merged, sub.scoring_criteria);
  if (leaf?.scoring_criteria) merged = mergeCriteria(merged, leaf.scoring_criteria);
  if (
    rfq.scoring_criteria_override &&
    typeof rfq.scoring_criteria_override === 'object' &&
    Object.keys(rfq.scoring_criteria_override).length
  ) {
    merged = mergeCriteria(merged, rfq.scoring_criteria_override);
  }
  return merged;
}

// ── Build the scoring prompt ─────────────────────────────────
function buildPrompt(rfq, quote, criteria) {
  const factoryData = {
    factory_specifications: quote.factory_specifications || null,
    certifications_typed: quote.certifications_confirmed || [],
    certifications_uploaded: (quote.certification_documents || []).map(c => ({
      name: c.name,
      type: c.type || null
    })),
    unit_fob_price: quote.unit_fob_price ?? null,
    packaging_price_per_unit: quote.packaging_price_per_unit ?? null,
    moq: quote.moq ?? null,
    production_lead_time_days: quote.production_lead_time_days ?? null,
    sample_lead_time_days: quote.sample_lead_time_days ?? null,
    country_of_manufacture: quote.country_of_manufacture ?? null
  };
  const path = [rfq.category, rfq.sub_category, rfq.sub_sub_category]
    .filter(Boolean)
    .join(' › ');
  return `You are a senior cosmetic chemistry & regulatory expert evaluating a factory quote against a scoring rubric.

# RFQ Context
Product description: ${rfq.item_description || 'N/A'}
Category path: ${path}
Project number: ${rfq.project_number || 'N/A'}
Is cosmetic: ${rfq.is_cosmetic ? 'yes' : 'no'}

# Factory Quote Data (typed by factory)
${JSON.stringify(factoryData, null, 2)}

# Scoring Criteria (merged from category hierarchy + RFQ override)
${JSON.stringify(criteria, null, 2)}

# Your Task
You have been provided with the factory's PDF documents (INCI, formulation, certifications) attached to this message. For EACH criterion in the rubric:

1. EXTRACT the relevant value from the PDFs (or use the factory-typed data where applicable)
2. EVALUATE whether it meets the target (numeric range, required cert presence, boolean answer, rubric prompt)
3. SCORE the criterion 0-100 (100 = perfect, 0 = total miss)
4. EXPLAIN your reasoning in one short sentence

Special handling:
- If the criterion is a "banned_ingredients_check" and you detect ANY ingredient on the listed banned lists in the formulation, set "auto_fail_triggered": true and cap the overall_score at 30.
- If a "critical" tier certification is missing, the criterion scores 0.
- If you cannot determine a value (PDF doesn't cover it, no factory data), use score: 50 with source: "missing" and reasoning explaining what's needed.
- For "ai_rubrics" criteria, use the prompt field to guide your evaluation.

The OVERALL score is a weighted average: sum(score × weight) / sum(weight). Round to integer.

Letter grade thresholds:
- A+: 95-100, A: 90-94, A-: 85-89
- B+: 80-84, B: 75-79, B-: 70-74
- C+: 65-69, C: 60-64, C-: 55-59
- D: 40-54, F: 0-39

Bonus findings: surface noteworthy items the factory provided that are NOT in the rubric (extra certs, premium ingredients, unique credentials). These don't affect the score but inform decision-making.

# Output Format
Return ONLY a JSON object. No markdown, no preamble, no postamble. Exactly this shape:

{
  "overall_score": <integer 0-100>,
  "letter_grade": "<one of A+,A,A-,B+,B,B-,C+,C,C-,D,F>",
  "auto_fail_triggered": <boolean>,
  "auto_fail_reason": <string or null>,
  "scorecard": [
    {
      "criterion_key": "<string>",
      "criterion_label": "<string>",
      "criterion_type": "regulatory|banned|certification|numeric|boolean|rubric|cost_quality|markets",
      "tier": "<critical|required|important|nice_to_have or null>",
      "weight": <integer 1-10>,
      "extracted_value": <any>,
      "passed": <boolean>,
      "score": <integer 0-100>,
      "reasoning": "<1-sentence explanation>",
      "source": "ai_extracted|factory_typed|uploaded_cert|missing"
    }
  ],
  "extracted_data": {
    "<key>": <value>
  },
  "bonus_findings": [
    { "label": "<short title>", "reasoning": "<1-sentence why this matters>" }
  ],
  "ai_notes": "<2-3 sentence overall summary of the quote's strengths and weaknesses>"
}`;
}

// ── Main handler ─────────────────────────────────────────────
async function handler(req, res) {
  // CORS — allow same-origin from Vercel deployment
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST with { quote_id }.' });
  }
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY env var is not set in Vercel.' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars not set in Vercel.' });
  }

  // Parse body — Vercel auto-parses JSON when Content-Type is application/json
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const quote_id = body.quote_id;
  if (!quote_id) return res.status(400).json({ error: 'Missing quote_id in body.' });

  try {
    // 1. Fetch quote + RFQ
    const quotes = await sb(`rfq_quotes?id=eq.${quote_id}&select=*,rfqs(*)`);
    if (!quotes || !quotes.length) {
      return res.status(404).json({ error: 'Quote not found.' });
    }
    const quote = quotes[0];
    const rfq = quote.rfqs;
    if (!rfq) return res.status(404).json({ error: 'RFQ for quote not found.' });

    // 2. Walk category hierarchy → effective criteria
    const criteria = await getEffectiveCriteria(rfq);
    const totalCriteria =
      (criteria.required_certifications?.length || 0) +
      (criteria.numeric_specs?.length || 0) +
      (criteria.boolean_specs?.length || 0) +
      (criteria.ai_rubrics?.length || 0);
    if (totalCriteria === 0) {
      return res.status(400).json({
        error: `No scoring criteria defined for category "${rfq.category}". Set them up in setup.html first.`
      });
    }

    // 3. Collect PDFs
    const pdfRefs = [];
    if (quote.inci_document_url) pdfRefs.push({ url: quote.inci_document_url, label: 'INCI document' });
    if (quote.formulation_document_url)
      pdfRefs.push({ url: quote.formulation_document_url, label: 'Formulation document' });
    if (Array.isArray(quote.certification_documents)) {
      for (const c of quote.certification_documents) {
        if (c?.url) pdfRefs.push({ url: c.url, label: 'Certification: ' + (c.name || 'unnamed') });
      }
    }
    if (!pdfRefs.length) {
      return res.status(400).json({
        error: 'No INCI, formulation, or certification PDFs found on this quote. Factory needs to upload at least one.'
      });
    }

    // 4. Download PDFs as base64 (parallel)
    const pdfDocs = await Promise.all(
      pdfRefs.map(async p => ({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: await fetchPdfBase64(p.url) },
        title: p.label
      }))
    );

    // 5. Call Claude
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const prompt = buildPrompt(rfq, quote, criteria);
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 8000,
      messages: [
        {
          role: 'user',
          content: [...pdfDocs, { type: 'text', text: prompt }]
        }
      ]
    });

    // 6. Parse response (extract JSON even if wrapped in markdown)
    const textBlock = message.content.find(b => b.type === 'text');
    if (!textBlock) return res.status(500).json({ error: 'AI returned no text content.' });
    const responseText = textBlock.text;
    const jsonStart = responseText.indexOf('{');
    const jsonEnd = responseText.lastIndexOf('}');
    if (jsonStart < 0 || jsonEnd < 0) {
      return res.status(500).json({ error: 'AI response did not contain JSON.', raw: responseText });
    }
    let scorecard;
    try {
      scorecard = JSON.parse(responseText.slice(jsonStart, jsonEnd + 1));
    } catch (e) {
      return res
        .status(500)
        .json({ error: 'AI JSON parse failed: ' + e.message, raw: responseText });
    }

    // 7. Add metadata
    scorecard.scored_at = new Date().toISOString();
    scorecard.model = MODEL;
    scorecard.criteria_count = (scorecard.scorecard || []).length;
    scorecard.pdf_count = pdfRefs.length;
    scorecard.pdfs_analyzed = pdfRefs.map(p => p.label);
    scorecard.input_tokens = message.usage?.input_tokens || null;
    scorecard.output_tokens = message.usage?.output_tokens || null;

    // 8. Persist to rfq_quotes
    await sb(`rfq_quotes?id=eq.${quote_id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        formulation_score: scorecard.overall_score,
        formulation_scorecard: scorecard
      })
    });

    return res.status(200).json({ success: true, scorecard });
  } catch (e) {
    console.error('score-quote error:', e);
    return res.status(500).json({ error: e.message || String(e) });
  }
}

// Attach Vercel function config to the handler, then export
handler.config = { maxDuration: 60 };
module.exports = handler;
module.exports.default = handler;
