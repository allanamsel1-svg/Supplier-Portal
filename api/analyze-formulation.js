// ============================================================
// /api/analyze-formulation.js
//
// Generates an INTERNAL formulation analysis for a quote.
// Output is admin-only by default — the factory never sees this
// unless admin explicitly curates and sends feedback.
//
// POST { quote_id: <uuid> }
//   → { success: true, analysis: {...}, category: 'cosmetics-skincare', model: 'claude-opus-4-7' }
//
// Behavior:
//   - Looks up the quote, its RFQ, the factory, and attached INCI / formulation PDFs
//   - Routes to a category-specific prompt under /prompts/formulation/<slug>.md
//   - Falls back to /prompts/formulation/default.md if no specific prompt exists
//   - Returns structured JSON with regulatory_us / regulatory_canada / claims /
//     missing_specs / improvement_suggestions / red_flags
//   - Persists to rfq_quotes.formulation_analysis (admin-only — RLS protected later)
//
// Env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY
//   ANALYSIS_MODEL (defaults to claude-opus-4-7)
// ============================================================

const _sdk = require('@anthropic-ai/sdk');
const Anthropic = _sdk.default || _sdk.Anthropic || _sdk;
const fs = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANALYSIS_MODEL || 'claude-opus-4-7';

// ── Supabase helper ──────────────────────────────────────────
async function sb(p, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, {
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

// ── PDF fetcher (reads from Supabase storage and returns base64) ──
async function fetchPdfBase64(urlOrPath) {
  let url;
  if (/^https?:\/\//i.test(urlOrPath)) {
    url = urlOrPath;
  } else {
    const p = String(urlOrPath).replace(/^\/+/, '');
    url = `${SUPABASE_URL}/storage/v1/object/factory-files/${p}`;
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

// ── Category → prompt-file slug ──────────────────────────────
// Returns the most specific matching prompt file. Falls back to 'default'.
function resolveCategorySlug(category, subCategory) {
  const cat = (category || '').toLowerCase().trim();
  const sub = (subCategory || '').toLowerCase().trim();
  // Skincare bucket — broad, since most skincare items use the same regulatory framework
  if (cat.includes('skin') || cat.includes('cosmetic') || cat.includes('beauty') ||
      cat.includes('serum') || cat.includes('cream') || cat.includes('lotion') ||
      sub.includes('skin') || sub.includes('face') || sub.includes('body')) {
    return 'cosmetics-skincare';
  }
  // Future: add hair, color, fragrance, otc-drug, packaged-food, etc.
  // For now everything else falls through to default.
  return 'default';
}

function loadPromptFile(slug) {
  // Prompts live at /prompts/formulation/<slug>.md (relative to repo root)
  // In Vercel functions, files in the repo are available relative to the function's CWD.
  const candidates = [
    path.join(process.cwd(), 'prompts', 'formulation', `${slug}.md`),
    path.join(process.cwd(), '..', 'prompts', 'formulation', `${slug}.md`),
    path.join(__dirname, '..', 'prompts', 'formulation', `${slug}.md`),
    path.join(__dirname, '..', '..', 'prompts', 'formulation', `${slug}.md`)
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return fs.readFileSync(candidate, 'utf-8');
      }
    } catch (_) { /* keep trying */ }
  }
  return null;
}

// ── Robust JSON extraction ──
// Handles common quirks in LLM JSON output: markdown fences, trailing commas,
// leading explanation text, smart quotes, etc.
function extractAndParseJSON(text) {
  if (!text) throw new Error('Empty response from model.');

  // 1. Strip markdown code fences (```json ... ``` or ``` ... ```)
  let cleaned = text.replace(/```(?:json)?\s*\n?/gi, '').replace(/```\s*$/g, '');

  // 2. Find the outermost JSON object — first { to its matching final }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error('No JSON object found in response.');
  }
  cleaned = cleaned.slice(start, end + 1);

  // 3. Try parsing as-is
  try { return JSON.parse(cleaned); } catch (e1) {
    // 4. Try fixing common issues:
    //    a) Trailing commas before } or ] (most common LLM mistake)
    //    b) Smart quotes / curly quotes
    //    c) Stray BOM
    let repaired = cleaned
      .replace(/,(\s*[}\]])/g, '$1')           // trailing commas
      .replace(/[\u201C\u201D]/g, '"')         // smart double quotes → straight
      .replace(/[\u2018\u2019]/g, "'")         // smart single quotes → straight
      .replace(/^\uFEFF/, '');                  // BOM
    try { return JSON.parse(repaired); } catch (e2) {
      // 5. Last resort: report the parse error with context around the failure point
      const m = e2.message.match(/position (\d+)/);
      const pos = m ? parseInt(m[1], 10) : 0;
      const ctxStart = Math.max(0, pos - 80);
      const ctxEnd = Math.min(repaired.length, pos + 80);
      const ctx = repaired.slice(ctxStart, ctxEnd).replace(/\n/g, '\\n');
      throw new Error(`${e2.message} — near: ...${ctx}...`);
    }
  }
}

// ── Main handler ─────────────────────────────────────────────
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
    // Fetch quote + RFQ + factory
    const quotes = await sb(`rfq_quotes?id=eq.${quote_id}&select=*,rfqs(*),factories(*)`);
    if (!quotes || !quotes.length) return res.status(404).json({ error: 'Quote not found.' });
    const quote = quotes[0];
    const rfq = quote.rfqs || {};
    const factory = quote.factories || {};

    // Resolve category-specific prompt
    const slug = resolveCategorySlug(rfq.category, rfq.sub_category);
    let promptText = loadPromptFile(slug);
    if (!promptText) {
      // Fall back to default
      promptText = loadPromptFile('default');
    }
    if (!promptText) {
      return res.status(500).json({ error: 'No formulation prompt files found. Check /prompts/formulation/ exists.' });
    }

    // Attach RFQ context inline so AI knows what was asked for
    const rfqContext = `\n\n# RFQ Context (what the buyer asked for)\n` +
      `Item: ${rfq.item_description || '(not specified)'}\n` +
      `Category: ${rfq.category || ''}${rfq.sub_category ? ' / ' + rfq.sub_category : ''}\n` +
      `Target markets: ${JSON.stringify(rfq.target_markets || [])}\n` +
      `Required certifications: ${JSON.stringify(rfq.required_certifications || [])}\n` +
      `Claims requested: ${rfq.claims || rfq.product_claims || '(none specified)'}\n` +
      `Specifications: ${rfq.specifications || rfq.notes || '(see attached PDFs)'}\n` +
      `Fill volume: ${rfq.fill_volume_ml ? rfq.fill_volume_ml + ' ml' : (rfq.fill_weight_g ? rfq.fill_weight_g + ' g' : '(not specified)')}\n` +
      `\n# Factory Submission\n` +
      `Factory: ${factory.factory_name_english || ''}\n` +
      `Quote details:\n` +
      `- Unit FOB: $${quote.unit_fob_price || '(not provided)'}\n` +
      `- MOQ: ${quote.moq || '(not provided)'}\n` +
      `- Production lead time: ${quote.production_lead_time_days || '(not provided)'} days\n` +
      `- Notes from factory: ${quote.factory_specifications || quote.notes || '(none)'}\n`;

    // Fetch attached PDFs
    const pdfBlocks = [];
    const pdfFields = [
      { field: 'inci_document_url', label: 'INCI Document' },
      { field: 'formulation_pdf_url', label: 'Formulation Document' },
      { field: 'packaging_spec_url', label: 'Packaging Spec' }
    ];
    for (const pf of pdfFields) {
      if (quote[pf.field]) {
        try {
          const b64 = await fetchPdfBase64(quote[pf.field]);
          pdfBlocks.push({
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: b64 }
          });
        } catch (e) {
          console.log(`PDF ${pf.label} fetch failed (continuing):`, e.message);
        }
      }
    }

    // Also pull approved/uploaded certification documents on the factory
    try {
      const certs = await sb(`factory_documents?factory_id=eq.${quote.factory_id}&cert_status=eq.approved&select=cert_type,document_url&limit=5`);
      for (const c of (certs || [])) {
        if (c.document_url) {
          try {
            const b64 = await fetchPdfBase64(c.document_url);
            pdfBlocks.push({
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: b64 }
            });
          } catch (_) { /* skip */ }
        }
      }
    } catch (_) { /* non-fatal */ }

    if (!pdfBlocks.length) {
      return res.status(400).json({
        error: 'No PDFs attached to this quote. Cannot perform formulation analysis without INCI and formulation documents.'
      });
    }

    // Call Claude
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const content = [
      ...pdfBlocks,
      { type: 'text', text: promptText + rfqContext }
    ];

    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 8000,
      messages: [{ role: 'user', content }]
    });

    const responseText = msg.content[0]?.text || '';
    let analysis;
    try {
      analysis = extractAndParseJSON(responseText);
    } catch (parseErr) {
      console.error('Failed to parse analysis JSON. Raw response (first 2000 chars):', responseText.slice(0, 2000));
      return res.status(500).json({
        error: 'AI response was not valid JSON: ' + parseErr.message,
        raw_response_preview: responseText.slice(0, 1500)
      });
    }

    // Stamp metadata onto the analysis
    analysis._meta = {
      analyzed_at: new Date().toISOString(),
      model: MODEL,
      category_slug: slug,
      pdfs_analyzed: pdfBlocks.length,
      input_tokens: msg.usage?.input_tokens || null,
      output_tokens: msg.usage?.output_tokens || null
    };

    // Persist to DB
    await sb(`rfq_quotes?id=eq.${quote_id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        formulation_analysis: analysis,
        formulation_analyzed_at: new Date().toISOString(),
        formulation_analyzed_model: MODEL,
        formulation_analysis_category: slug
      })
    });

    return res.status(200).json({
      success: true,
      analysis,
      category: slug,
      model: MODEL
    });
  } catch (err) {
    console.error('analyze-formulation error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}

module.exports = handler;
module.exports.default = handler;
