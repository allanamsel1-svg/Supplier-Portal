// POLICY: Never reference "Claude" or "Anthropic" in any user-facing text, labels, messages, or UI elements.
// ============================================================
// /api/draft-quote-email.js
//
// Drafts a professional sourcing email (as Sarah Lindburg, TBG Sourcing)
// for a quote-response action, so the admin can review/edit before sending.
//
// POST { quote_id, rfq_id, factory_id, action }
//   action ∈ 'approved' | 'rejected' | 'more_info' | 'followup' | 'document_request'
//   approved/rejected/more_info/followup → signed Sarah Lindburg (Sourcing)
//   document_request → signed Tyler Durden (Compliance), Sarah CC'd
//   quote_id may be null (e.g. for 'followup' before any quote exists)
//   → { subject, body }
//
// Env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY (falls back to SUPABASE_SERVICE_ROLE_KEY),
//   ANTHROPIC_API_KEY, DRAFT_EMAIL_MODEL (defaults to claude-sonnet-4-20250514)
// ============================================================

const _sdk = require('@anthropic-ai/sdk');
const Anthropic = _sdk.default || _sdk.Anthropic || _sdk;

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.DRAFT_EMAIL_MODEL || 'claude-sonnet-4-20250514';

const SOURCING_SYSTEM_PROMPT =
  'You are Sarah Lindburg, Sourcing Manager at TBG Sourcing. Write professional, ' +
  'concise sourcing emails. Never mention AI or scoring. Always use subject format: ' +
  '[PRJ-XXXX] Product Description';

const COMPLIANCE_SYSTEM_PROMPT =
  'You are Tyler Durden, Compliance Manager at TBG Sourcing. Write professional, ' +
  'concise compliance and document-request emails. Never mention AI or scoring. ' +
  'Always use subject format: [PRJ-XXXX] Product Description. ' +
  'Sarah Lindburg (Sourcing) is copied on this email.';

function systemPromptFor(action) {
  return action === 'document_request' ? COMPLIANCE_SYSTEM_PROMPT : SOURCING_SYSTEM_PROMPT;
}

// ── Supabase REST helper (service key) ──────────────────────
async function sb(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json'
    }
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Supabase ${res.status} on ${path}: ${txt.slice(0, 300)}`);
  }
  return await res.json();
}

// Pull the weakest dimensions out of the v2 score breakdown so a
// "more_info" email can name concrete gaps without exposing the score.
function extractWeaknesses(breakdown) {
  if (!breakdown || !Array.isArray(breakdown.dimensions)) return [];
  return breakdown.dimensions
    .map(d => ({
      label: d.label,
      ratio: d.weight ? (Number(d.score) || 0) / d.weight : 1,
      detail: d.detail || ''
    }))
    .filter(d => d.ratio < 0.7)
    .sort((a, b) => a.ratio - b.ratio)
    .slice(0, 3)
    .map(d => `${d.label}: ${d.detail}`.trim());
}

function buildUserPrompt(action, ctx) {
  const { rfq, factory, quote, weaknesses } = ctx;
  const projectNumber = rfq.project_number || 'PRJ-XXXX';
  const productDescription = rfq.product_description || 'the quoted product';
  const factoryName = factory.name || 'the factory';

  const lines = [];
  lines.push('Write a sourcing email for the following situation. Return ONLY a JSON object: {"subject": "...", "body": "..."} — no markdown, no preamble.');
  lines.push('');
  lines.push(`Subject MUST be exactly in the format: [${projectNumber}] ${productDescription}`);
  lines.push('');
  lines.push('# Context');
  lines.push(`Factory: ${factoryName}`);
  lines.push(`Project number: ${projectNumber}`);
  lines.push(`Product: ${productDescription}`);
  if (rfq.category_path) lines.push(`Category: ${rfq.category_path}`);
  if (quote && quote.factory_description) lines.push(`Factory's quoted item: ${quote.factory_description}`);
  lines.push('');

  if (action === 'approved') {
    lines.push('# Action: APPROVED');
    lines.push('Warmly congratulate the factory that their quote has been approved. Confirm the next steps are to provide samples and confirm the production timeline. Keep it warm but direct.');
  } else if (action === 'rejected') {
    lines.push('# Action: REJECTED');
    lines.push('Politely decline this quote. Do not give harsh or overly specific reasons. Thank them and keep the door open for future opportunities.');
  } else if (action === 'more_info') {
    lines.push('# Action: REQUEST MORE INFORMATION');
    lines.push('Politely request the additional information needed to complete the evaluation. Specify the concrete gaps below in plain business language (do NOT mention scores, scoring, or internal evaluation systems).');
    if (weaknesses && weaknesses.length) {
      lines.push('Gaps to address:');
      weaknesses.forEach(w => lines.push(`- ${w}`));
    }
    if (quote && Array.isArray(quote.compliance_flags) && quote.compliance_flags.length) {
      lines.push('Compliance items to clarify:');
      quote.compliance_flags.forEach(f => {
        const label = (f && (f.label || f.message || f.code)) || (typeof f === 'string' ? f : JSON.stringify(f));
        lines.push(`- ${label}`);
      });
    } else if (quote && quote.compliance_flags && typeof quote.compliance_flags === 'object' && !Array.isArray(quote.compliance_flags)) {
      lines.push(`Compliance items to clarify: ${JSON.stringify(quote.compliance_flags)}`);
    }
  } else if (action === 'followup') {
    lines.push('# Action: FOLLOW UP');
    lines.push('Send a friendly, short reminder that we are still awaiting their quote on this RFQ. Reference the project number. Keep it brief and encouraging.');
  } else if (action === 'document_request') {
    lines.push('# Action: DOCUMENT REQUEST (Compliance)');
    lines.push('Request the outstanding compliance documents and certifications needed for this product. List the specific items below in plain business language (do NOT mention scores or internal evaluation systems). Note politely that Sarah Lindburg (Sourcing) is copied on this email.');
    if (quote && Array.isArray(quote.compliance_flags) && quote.compliance_flags.length) {
      lines.push('Documents / compliance items needed:');
      quote.compliance_flags.forEach(f => {
        const label = (f && (f.label || f.message || f.code)) || (typeof f === 'string' ? f : JSON.stringify(f));
        lines.push(`- ${label}`);
      });
    } else if (quote && quote.compliance_flags && typeof quote.compliance_flags === 'object' && !Array.isArray(quote.compliance_flags)) {
      lines.push(`Documents / compliance items needed: ${JSON.stringify(quote.compliance_flags)}`);
    } else {
      lines.push('Documents / compliance items needed: the required product compliance documentation, certifications, and test reports for this category.');
    }
  } else {
    throw new Error(`Unknown action: ${action}`);
  }

  lines.push('');
  if (action === 'document_request') {
    lines.push('Sign as: Tyler Durden, Compliance Manager, TBG Sourcing, compliance@tbgsourcing.net (Sarah Lindburg, Sourcing, is copied).');
  } else {
    lines.push('Sign as: Sarah Lindburg, Sourcing Manager, TBG Sourcing, sourcing@tbgsourcing.net');
  }
  return lines.join('\n');
}

function parseModelJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Model did not return JSON');
  return JSON.parse(text.slice(start, end + 1));
}

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'AI service is not configured.' });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_KEY env vars not set.' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const { quote_id, rfq_id, factory_id, action } = body;
  if (!rfq_id || !factory_id || !action) {
    return res.status(400).json({ error: 'Missing rfq_id, factory_id, or action.' });
  }
  if (['approved', 'rejected', 'more_info', 'followup', 'document_request'].indexOf(action) < 0) {
    return res.status(400).json({ error: `Invalid action: ${action}` });
  }

  try {
    // RFQ — spec field names mapped to the live schema:
    //   product_description → item_description, category_path → category
    const rfqRows = await sb(`rfqs?id=eq.${rfq_id}&select=project_number,item_description,category&limit=1`);
    if (!rfqRows.length) return res.status(404).json({ error: 'RFQ not found.' });
    const rfqRow = rfqRows[0];
    const rfq = {
      project_number: rfqRow.project_number,
      product_description: rfqRow.item_description,
      category_path: rfqRow.category
    };

    // Factory — name → factory_name_english, wechat → sales_wechat, whatsapp → sales_whatsapp
    const factRows = await sb(`factories?id=eq.${factory_id}&select=factory_name_english,sales_email,sales_wechat,sales_whatsapp&limit=1`);
    if (!factRows.length) return res.status(404).json({ error: 'Factory not found.' });
    const factRow = factRows[0];
    const factory = {
      name: factRow.factory_name_english,
      sales_email: factRow.sales_email,
      wechat: factRow.sales_wechat,
      whatsapp: factRow.sales_whatsapp
    };

    // Quote (optional — null for follow-ups before a quote exists)
    let quote = null;
    if (quote_id) {
      const qRows = await sb(`rfq_quotes?id=eq.${quote_id}&select=factory_description,score_overall_v2,score_breakdown_v2,compliance_flags&limit=1`);
      if (qRows.length) quote = qRows[0];
    }

    const weaknesses = quote ? extractWeaknesses(quote.score_breakdown_v2) : [];
    const userPrompt = buildUserPrompt(action, { rfq, factory, quote, weaknesses });

    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 500,
      system: systemPromptFor(action),
      messages: [{ role: 'user', content: userPrompt }]
    });

    const text = (msg.content && msg.content[0] && msg.content[0].text) || '';
    let parsed;
    try {
      parsed = parseModelJson(text);
    } catch (e) {
      console.error('draft-quote-email parse error:', e.message, '| raw:', text.slice(0, 500));
      // Fall back to a deterministic subject + the raw text as the body.
      parsed = { subject: `[${rfq.project_number || 'PRJ-XXXX'}] ${rfq.product_description || ''}`.trim(), body: text.trim() };
    }

    const subject = (parsed.subject && String(parsed.subject).trim()) ||
      `[${rfq.project_number || 'PRJ-XXXX'}] ${rfq.product_description || ''}`.trim();
    const draftBody = (parsed.body && String(parsed.body).trim()) || '';
    if (!draftBody) return res.status(502).json({ error: 'AI returned an empty draft.' });

    return res.status(200).json({ subject, body: draftBody });
  } catch (err) {
    console.error('draft-quote-email error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}

module.exports = handler;
module.exports.default = handler;
