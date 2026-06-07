// POLICY: Never reference "Claude" or "Anthropic" in any user-facing text, labels, messages, or UI elements.
// ============================================================
// /api/draft-sample-feedback.js
// AI-drafts feedback text for a sample revise/reject decision.
// Admin can use the draft as-is, edit it, or write from scratch.
//
// POST {
//   product_development_id: <uuid>,
//   sample_submission_id:   <uuid>,
//   decision: 'revise' | 'reject',
//   issue_categories: ['color', 'texture', 'smell', 'packaging', ...],
//   admin_notes: '<optional admin context>'
// }
//   → { success: true, draft: '<feedback text>' }
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

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'AI service is not configured.' });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars not set.' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const { product_development_id, sample_submission_id, decision, issue_categories, admin_notes } = body;
  if (!product_development_id || !decision) {
    return res.status(400).json({ error: 'Missing product_development_id or decision.' });
  }
  if (decision !== 'revise' && decision !== 'reject') {
    return res.status(400).json({ error: 'decision must be "revise" or "reject".' });
  }

  try {
    // Pull context: PD item, accepted quote, RFQ, factory, the specific sample submission
    const pdRows = await sb(
      `product_development_items?id=eq.${product_development_id}` +
      `&select=*,rfqs(item_description,category,target_markets,packaging),rfq_quotes!product_development_items_accepted_quote_id_fkey(*),factories(factory_name_english,sales_contact_name,country)`
    );
    if (!pdRows || !pdRows.length) return res.status(404).json({ error: 'PD item not found.' });
    const pd = pdRows[0];
    const rfq = pd.rfqs || {};
    const quote = pd.rfq_quotes || {};
    const factory = pd.factories || {};

    let sampleSubmission = null;
    if (sample_submission_id) {
      const ssRows = await sb(`sample_submissions?id=eq.${sample_submission_id}&select=*`);
      sampleSubmission = ssRows && ssRows[0] ? ssRows[0] : null;
    }

    const contactName = (factory.sales_contact_name || 'Team').split(/\s+/)[0];
    const issueList = Array.isArray(issue_categories) ? issue_categories.join(', ') : '';

    const prompt =
`You are drafting a sample-evaluation message from a US-based product sourcing company (TBG Sourcing) to a Chinese factory. The factory submitted a product sample and we are sending them ${decision === 'revise' ? 'a revision request' : 'a rejection'}.

# Context
- Factory: ${factory.factory_name_english || ''} (${factory.country || ''})
- Contact: ${contactName}
- Product: ${rfq.item_description || ''}
- Category: ${rfq.category || ''}
- Sample version: ${sampleSubmission?.version_number || pd.current_version || '?'}
- Sample shipped: ${sampleSubmission?.ship_date || 'unknown'}

# Issues the buyer has identified
${issueList ? `Categories: ${issueList}` : '(no specific categories selected)'}
${admin_notes ? `\nAdditional context from buyer:\n${admin_notes}` : ''}

# Your task
Draft a professional, courteous email body explaining ${decision === 'revise' ? 'what needs to change for the next sample version' : 'why we are not moving forward with this product'}. The tone should be:
- Professional, warm, and clear — never harsh
- Specific about issues without being mean-spirited
- For "revise" decisions: encouraging — the factory has a path forward
- For "reject" decisions: respectful — acknowledge their effort, leave the door open for future opportunities

# Constraints
- Address the contact by first name
- Keep it to 3-4 short paragraphs
- Do NOT include a subject line
- Do NOT include a signature (it's added separately)
- Do NOT use placeholders like [Your Name] or [Insert Detail]
- Reference the specific issues from the categories provided, but use your judgment to phrase them naturally
- If decision is "revise", end by asking the factory to submit a revised sample
- If decision is "reject", end by thanking them for their effort and noting future opportunities

# Output
Return ONLY the email body text. No prose explaining your draft. No markdown formatting.`;

    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }]
    });
    const draft = (msg.content[0]?.text || '').trim();

    return res.status(200).json({ success: true, draft });
  } catch (err) {
    console.error('draft-sample-feedback error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}

module.exports = handler;
module.exports.default = handler;
