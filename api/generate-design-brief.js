// POLICY: Never reference "Claude" or "Anthropic" in any user-facing text, labels, messages, or UI elements.
// ============================================================
// /api/generate-design-brief.js
//
// Generates a packaging design brief (addressed to the graphics team) for a SKU,
// so it can be reviewed/edited before being sent to the designer queue.
//
// POST { sku_description, category, packaging_selections, reference_image_url }
//   packaging_selections: array of checked packaging types (strings)
//   → { brief }
//
// Env vars: ANTHROPIC_API_KEY, DESIGN_BRIEF_MODEL (defaults to claude-sonnet-4-20250514)
// ============================================================

const _sdk = require('@anthropic-ai/sdk');
const Anthropic = _sdk.default || _sdk.Anthropic || _sdk;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.DESIGN_BRIEF_MODEL || 'claude-sonnet-4-20250514';

const SYSTEM_PROMPT =
  'You are a packaging project manager creating design briefs for graphic designers. ' +
  'Be specific, professional, and concise.';

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'AI service is not configured.' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const skuDescription = (body.sku_description || '').toString().trim();
  const category = (body.category || '').toString().trim();
  const packaging = Array.isArray(body.packaging_selections)
    ? body.packaging_selections.filter(Boolean)
    : (body.packaging_selections ? [String(body.packaging_selections)] : []);
  const referenceImageUrl = (body.reference_image_url || '').toString().trim();
  const unitUpc = (body.unit_upc || '').toString().trim();
  const innerUpc = (body.inner_upc || '').toString().trim();
  const masterUpc = (body.master_upc || '').toString().trim();
  const palletUpc = (body.pallet_upc || '').toString().trim();

  if (!skuDescription) return res.status(400).json({ error: 'sku_description is required.' });

  const packagingList = packaging.length ? packaging.join(', ') : 'standard retail packaging';

  let userPrompt =
    'Create a design brief for: ' + skuDescription + ', category: ' + (category || 'general') + '. ' +
    'Packaging required: ' + packagingList + '. ' +
    'Include: project overview, deliverables list, technical specs to confirm with factory, ' +
    'brand guidelines reminder (TBD — designer to confirm with brand manager), ' +
    'and any special notes based on the product type.';
  if (referenceImageUrl) {
    userPrompt += '\n\nReference image provided — see attached for packaging style direction.';
  }
  if (unitUpc || innerUpc || masterUpc || palletUpc) {
    userPrompt += '\n\nInclude at the end of the brief: BARCODE SPECIFICATIONS: Unit UPC-A: ' + (unitUpc || 'N/A') +
      ' | Inner ITF-14: ' + (innerUpc || 'N/A') + ' | Master ITF-14: ' + (masterUpc || 'N/A') +
      ' | Pallet ITF-14: ' + (palletUpc || 'N/A') + '. The graphics team must use these exact barcodes on the artwork.';
  }

  try {
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 800,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }]
    });
    const brief = (msg.content && msg.content[0] && msg.content[0].text || '').trim();
    if (!brief) return res.status(502).json({ error: 'AI returned an empty brief.' });
    return res.status(200).json({ brief });
  } catch (err) {
    console.error('generate-design-brief error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}

module.exports = handler;
module.exports.default = handler;
