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
//   ANTHROPIC_API_KEY, DRAFT_EMAIL_MODEL (defaults to claude-sonnet-4-5)
// ============================================================

const _sdk = require('@anthropic-ai/sdk');
const Anthropic = _sdk.default || _sdk.Anthropic || _sdk;

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.DRAFT_EMAIL_MODEL || 'claude-sonnet-4-5';

// Pre-written per-action fallback templates used when the AI draft fails / is empty.
function fallbackTemplate(action, factoryName, product) {
  const sign = '\n\nBest regards,\nSarah Lindburg\nSourcing Manager, TBG Sourcing';
  const t = {
    followup:  'Dear ' + factoryName + ', I wanted to follow up on the RFQ we sent for ' + product + '. We have not yet received your quotation. Could you please provide your pricing and specifications at your earliest convenience? We look forward to your response.' + sign,
    approved:  'Dear ' + factoryName + ', we are pleased to inform you that your quotation for ' + product + ' has been approved. Please proceed with sample preparation per the agreed specifications.' + sign,
    rejected:  'Dear ' + factoryName + ', thank you for your quotation for ' + product + '. After careful review we will not be moving forward at this time. We appreciate your participation and hope to work together in the future.' + sign,
    more_info: 'Dear ' + factoryName + ', thank you for your quotation for ' + product + '. We require additional information before proceeding. Please provide further details on your submission.' + sign
  };
  return t[action] || t.followup;
}

const SOURCING_SYSTEM_PROMPT =
  'You are Sarah Lindburg, Sourcing Manager at TBG Sourcing. Write professional, ' +
  'concise sourcing emails. Never mention AI or scoring. Always use subject format: ' +
  '[PRJ-XXXX] Product Description';

const COMPLIANCE_SYSTEM_PROMPT =
  'You are Tyler Durden, Compliance Manager at TBG Sourcing. Write professional, ' +
  'concise compliance and document-request emails. Never mention AI or scoring. ' +
  'Always use subject format: [PRJ-XXXX] Product Description. ' +
  'Sarah Lindburg (Sourcing) is copied on this email.';

const APPROVED_SYSTEM_PROMPT =
  'You are Sarah Lindburg, Sourcing Manager at TBG Sourcing. Write a professional, warm approval email. ' +
  'Never mention AI or scoring. Always use subject format: [PRJ-XXXX] Product Description.\n\n' +
  'Based on the specific packaging requirements below, generate a precise numbered list of every physical and ' +
  'digital asset the factory must provide so the graphics team can create complete artwork. Be specific and technical — examples:\n' +
  '- Glass dropper bottle → request: STEP/3D CAD file of bottle, mold drawing with dimensions, neck finish spec\n' +
  '- Printed paper label → request: label dieline (AI/PDF), label dimensions confirmed, label substrate spec\n' +
  '- Folding carton gift box → request: structural dieline (AI/PDF), all panel dimensions confirmed\n' +
  '- Soft touch lamination + spot UV → request: finishing specification sheet, UV spot area callout file\n' +
  '- Direct print on bottle → request: bottle surface template/unwrap file\n' +
  'Do NOT use a generic asset list. Generate assets specific to exactly what this product requires.';

function systemPromptFor(action) {
  if (action === 'document_request') return COMPLIANCE_SYSTEM_PROMPT;
  if (action === 'approved') return APPROVED_SYSTEM_PROMPT;
  return SOURCING_SYSTEM_PROMPT;
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
    lines.push('Warmly congratulate the factory that their quotation has been approved (keep the warm Sarah voice).');
    lines.push('');
    lines.push('# Packaging & product details (use these to determine the EXACT assets required)');
    lines.push(`Product name: ${productDescription}`);
    lines.push(`Category: ${rfq.category_path || '—'}`);
    lines.push(`Cosmetic product: ${rfq.is_cosmetic ? 'yes' : 'no'}`);
    lines.push(`Primary packaging type: ${rfq.packaging_type || rfq.packaging_primary || '—'}`);
    if (rfq.packaging_primary) lines.push(`Primary container: ${rfq.packaging_primary}`);
    if (Array.isArray(rfq.packaging_secondary) && rfq.packaging_secondary.length) lines.push(`Secondary packaging / printing treatments: ${rfq.packaging_secondary.join(', ')}`);
    if (rfq.packaging_finish) lines.push(`Finish: ${rfq.packaging_finish}`);
    if (Array.isArray(rfq.packaging_decoration) && rfq.packaging_decoration.length) lines.push(`Decoration: ${rfq.packaging_decoration.join(', ')}`);
    if (rfq.detailed_specifications) lines.push(`Detailed specifications: ${rfq.detailed_specifications}`);
    lines.push('');
    lines.push('# The email body MUST contain, in this order:');
    lines.push('1. A warm congratulations paragraph.');
    lines.push('2. The exact sentence: "To proceed with artwork creation, please provide the following assets through the factory portal:"');
    lines.push('3. A numbered list of the specific assets required for THIS product (one per line, formatted "1. ...", "2. ...").');
    lines.push('4. The exact sentence: "Please upload all assets within 5 business days."');
    lines.push('5. The Sarah Lindburg signature.');
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

// Locate the artwork project's factory_link_token for the secure no-login upload link.
// Looks up by pd_item_id when provided, else walks quote_id → product_development_items → artwork_projects.
async function findFactoryLinkToken(quoteId, pdItemId) {
  try {
    if (pdItemId) {
      const r = await sb(`artwork_projects?pd_item_id=eq.${pdItemId}&select=factory_link_token&limit=1`);
      if (r.length && r[0].factory_link_token) return r[0].factory_link_token;
    }
    if (quoteId) {
      const pdi = await sb(`product_development_items?accepted_quote_id=eq.${quoteId}&select=id&limit=1`);
      if (pdi.length) {
        const ap = await sb(`artwork_projects?pd_item_id=eq.${pdi[0].id}&select=factory_link_token&limit=1`);
        if (ap.length && ap[0].factory_link_token) return ap[0].factory_link_token;
      }
    }
  } catch (e) {
    console.error('findFactoryLinkToken error:', e.message);
  }
  return null;
}

// Secure factory upload link block appended after the asset list in approval emails.
function factoryUploadLinkBlock(token) {
  return `\n\nPlease upload all required assets using this secure link: https://portal.tbgsourcing.net/factory-assets.html?token=${token}` +
    '\n\nThis link is unique to your order and does not require a login.';
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
  const { quote_id, rfq_id, factory_id, action, pd_item_id } = body;
  if (!rfq_id || !factory_id || !action) {
    return res.status(400).json({ error: 'Missing rfq_id, factory_id, or action.' });
  }
  if (['approved', 'rejected', 'more_info', 'followup', 'document_request'].indexOf(action) < 0) {
    return res.status(400).json({ error: `Invalid action: ${action}` });
  }

  try {
    // RFQ — spec field names mapped to the live schema:
    //   product_description → item_description, category_path → category
    const rfqRows = await sb(`rfqs?id=eq.${rfq_id}&select=project_number,item_description,category,packaging_type,packaging_secondary,is_cosmetic,detailed_specifications,packaging_primary,packaging_finish,packaging_decoration&limit=1`);
    if (!rfqRows.length) return res.status(404).json({ error: 'RFQ not found.' });
    const rfqRow = rfqRows[0];
    const rfq = {
      project_number: rfqRow.project_number,
      product_description: rfqRow.item_description,
      category_path: rfqRow.category,
      // Packaging details — drive the dynamic asset list on approval.
      packaging_type: rfqRow.packaging_type,
      packaging_secondary: rfqRow.packaging_secondary,
      is_cosmetic: rfqRow.is_cosmetic,
      detailed_specifications: rfqRow.detailed_specifications,
      packaging_primary: rfqRow.packaging_primary,
      packaging_finish: rfqRow.packaging_finish,
      packaging_decoration: rfqRow.packaging_decoration
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
      max_tokens: action === 'approved' ? 900 : 500,   // approval emails carry a full asset list
      system: systemPromptFor(action),
      messages: [{ role: 'user', content: userPrompt }]
    });

    const text = (msg.content && msg.content[0] && msg.content[0].text) || '';
    let parsed;
    try {
      parsed = parseModelJson(text);
    } catch (e) {
      console.error('draft-quote-email parse error:', e.message, '| raw:', text.slice(0, 500));
      // Fall back to a deterministic subject + a proper per-action template (never raw text).
      parsed = {
        subject: `[${rfq.project_number || 'PRJ-XXXX'}] ${rfq.product_description || ''}`.trim(),
        body: fallbackTemplate(action, factory.name || 'Factory', rfq.product_description || 'this item')
      };
    }

    const subject = (parsed.subject && String(parsed.subject).trim()) ||
      `[${rfq.project_number || 'PRJ-XXXX'}] ${rfq.product_description || ''}`.trim();
    let draftBody = (parsed.body && String(parsed.body).trim()) ||
      fallbackTemplate(action, factory.name || 'Factory', rfq.product_description || 'this item');

    // For approvals, append the secure no-login asset-upload link if the artwork project
    // (and its factory_link_token) already exists. In the normal flow the artwork record is
    // created at send time, so the client appends the link then; this covers re-drafts where
    // the record already exists and a pd_item_id/quote_id resolves a token.
    if (action === 'approved' && draftBody.indexOf('factory-assets.html?token=') < 0) {
      const token = await findFactoryLinkToken(quote_id, pd_item_id);
      if (token) draftBody += factoryUploadLinkBlock(token);
    }

    return res.status(200).json({ subject, body: draftBody });
  } catch (err) {
    console.error('draft-quote-email error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}

module.exports = handler;
module.exports.default = handler;
