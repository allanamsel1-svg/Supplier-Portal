// POLICY: Never reference "Claude" or "Anthropic" in any user-facing text, labels, messages, or UI elements.
// api/suggest-criteria.js
// Generates scoring_criteria JSON for a given category path using Claude.
// Called from setup.html via the "Suggest with AI" button.

const _sdk = require('@anthropic-ai/sdk');
const Anthropic = _sdk.default || _sdk.Anthropic || _sdk;

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'Invalid JSON body' }); }
  }
  body = body || {};

  const { category, sub_category, sub_sub_category, target_markets, is_cosmetic } = body;
  if (!category) return res.status(400).json({ error: 'category is required' });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'AI service is not configured.' });
  }

  const markets = Array.isArray(target_markets) && target_markets.length ? target_markets : ['US', 'CA'];
  const path = [category, sub_category, sub_sub_category].filter(Boolean).join(' › ');

  const prompt = `You are a regulatory compliance and product quality expert specializing in private-label sourcing for major US/CA retailers.

A buyer is configuring scoring criteria for the product category: "${path}"
Target markets: ${markets.join(', ')}
Cosmetic product flag: ${is_cosmetic === true ? 'YES (factory will need to provide INCI + formulation)' : is_cosmetic === false ? 'NO' : 'UNKNOWN — infer from category name'}

Generate a complete scoring_criteria JSON object that captures the regulatory + safety + quality requirements specific to this category and its target markets.

REQUIRED OUTPUT SCHEMA — return ONLY this JSON, no markdown fences, no preamble:

{
  "regulatory_profile": [<array of relevant regulatory framework keys>],
  "target_markets": ${JSON.stringify(markets)},
  "banned_ingredients_check": {
    "lists": [<which banned/restricted ingredient lists apply>],
    "weight": 10
  },
  "required_certifications": [
    {"key": "snake_case_id", "label": "Human-readable label", "tier": "critical|important|nice_to_have", "weight": 1-10}
  ],
  "numeric_specs": [
    {"key": "snake_case_id", "label": "What this measures", "unit": "ppm|%|cP|pH|CFU/g|etc", "min": optional_number, "max": optional_number, "weight": 1-10}
  ],
  "boolean_specs": [
    {"key": "snake_case_id", "label": "What must be true", "tier": "required|nice_to_have", "weight": 1-10}
  ],
  "ai_rubrics": [
    {"key": "snake_case_id", "label": "Internal scoring concept (not shown to factory)", "weight": 1-10}
  ],
  "cost_quality": {"weight": 6, "expected_fob_min": number_usd, "expected_fob_max": number_usd}
}

REGULATORY FRAMEWORK KEYS — pick from this list, only include those that ACTUALLY APPLY:
- "fda_cosmetic_mocra" (cosmetics sold in US — required since 2023 MoCRA Act)
- "fda_otc_drug_21_cfr_211" (sunscreen, anti-dandruff, fluoride toothpaste, antiperspirant)
- "fda_drug_facts_label" (any OTC drug requires standardized Drug Facts panel)
- "fda_dietary_supplement_21_cfr_111" (vitamins, supplements, ingestibles)
- "fda_food_safety_fsma" (food, edible items)
- "health_canada_cosmetic_hotlist" (cosmetics sold in Canada)
- "health_canada_natural_health_products" (NHPD/NPN for supplements/wellness in Canada)
- "prop65" (any product sold in California — chemical disclosure. Note: Prop 65 has TWO compliance paths — full conformance OR a standard warning label on packaging. The buyer chooses the strategy per RFQ; do not score conformance as critical here at the category level.)
- "fpla_us" (Fair Packaging & Labeling Act — most US consumer products)
- "cfia_canada" (Canadian Food Inspection Agency — food/edible)
- "cpsia" (Children's Product Safety — under-12 products, lead/phthalate)
- "fcc_part_15" (electronic devices with EM emissions)
- "ul_safety_listing" (electrical safety listing — UL/ETL/CSA)
- "doe_energy_efficiency" (Department of Energy — appliances)
- "rohs" (Restriction of Hazardous Substances — electronics)
- "reach" (EU chemical registration — only if EU market targeted)
- "ifra" (International Fragrance Association — fragrance products)
- "eu_cosmetic_regulation_1223_2009" (only if EU market targeted)

CERTIFICATION GUIDANCE:
- For COSMETICS: ISO 22716 GMP (critical, w9), FDA Facility Registration MoCRA (critical, w9 if US), Stability test (important, w7), Microbial USP 61/62 (important, w8), COA per batch (important, w7), SDS (important, w6), Heavy Metals report (important, w7), PET/Challenge test (important, w7), Packaging compatibility (nice-to-have, w4), COSMOS Organic (nice-to-have, w3), Leaping Bunny (nice-to-have, w3)
- For OTC DRUGS (sunscreen, anti-dandruff, fluoride toothpaste): also include FDA NDC Registration (critical, w10), Drug Facts Label compliance (critical, w9), drug GMP 21 CFR 211 audit (critical, w10), final-product efficacy testing (important, w8)
- For ELECTRICAL: UL/ETL/CSA listing (critical, w10), FCC Part 15 (critical, w9), DOE energy compliance (important, w7), RoHS (important, w7), CE (important if EU market, w7)
- For SUPPLEMENTS: FDA dietary supplement GMP 21 CFR 111 (critical, w10), third-party testing (NSF, USP, Informed Sport — important, w8), proprietary blend disclosure (important, w7), Certificate of Analysis per batch (critical, w9)
- For FRAGRANCE: IFRA conformity certificate (critical, w9), allergen disclosure (EU 26/81 — important, w8), photo-toxicity test if citrus (important, w7)
- For TEXTILES/APPAREL: OEKO-TEX 100 (important, w7), GOTS if organic (nice-to-have, w5), CPSIA lead/phthalate test for kids (critical, w10)

NUMERIC SPECS GUIDANCE — be specific and tight:
- For products that touch skin: heavy metals (Pb max 10 ppm, As max 3, Hg max 1, Cd max 5), microbial (TAC max 1000 CFU/g, yeast/mold max 100), pH per product class
- For sunscreen: SPF claim verification (in-vivo testing required), broad-spectrum critical wavelength ≥370nm, water-resistance minutes claim
- For toothpaste with fluoride: fluoride concentration 850-1500 ppm (US), 850-1450 ppm (CA)
- For aerosols: VOC max 55% (CARB), flammability rating
- For electrical: voltage tolerance, power consumption vs. label, leakage current

BOOLEAN SPECS — required claims that must hold true:
- inci_matches_label, no_pathogens, phthalate_free, formaldehyde_donor_disclosed
- Category-specific: tear_free for baby, ppd_warning_label for hair color, lead_acetate_free, voc_compliant_california, fluoride_warning_label_for_kids, etc.

AI RUBRICS — internal scoring concepts the AI evaluates from formulation/specs (factory does not see these):
- preservation_adequacy, formulation_coherence, ingredient_quality_origin
- Category-specific: surfactant_system_review for shampoo, oxidative_dye_safety for hair color, sunscreen_filter_combination for sunscreen, etc.

COST_QUALITY — realistic FOB price expectations for this category at private-label scale (USD per unit):
- Skin Care: $0.50-8.00, premium serums $1.80-12
- Hair Care basic: $0.50-6.00
- Hair color: $1.20-12
- Sunscreen: $0.80-6.00
- Toothpaste: $0.30-2.50
- Electrical hair tool: $4-25
- Fragrance: $0.80-15

QUALITY BAR:
- Aim for 8-12 certifications (mix of tiers)
- 4-8 numeric specs (concrete, measurable)
- 6-10 boolean specs (yes/no compliance items)
- 2-4 AI rubrics (internal scoring concepts)
- All "label" fields should be human-readable and informative
- All "key" fields are snake_case, no spaces
- Tier and weight should reflect real-world risk

Return only the JSON object. No explanation, no markdown.`;

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model: process.env.SCORING_MODEL || 'claude-sonnet-4-6',
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }]
    });

    const textBlock = message.content.find(b => b.type === 'text');
    if (!textBlock) return res.status(500).json({ error: 'AI returned no text content.' });
    const text = textBlock.text;

    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart < 0 || jsonEnd < 0) {
      return res.status(500).json({ error: 'AI response did not contain JSON.', raw: text });
    }

    let criteria;
    try {
      criteria = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
    } catch (e) {
      return res.status(500).json({ error: 'AI JSON parse failed: ' + e.message, raw: text });
    }

    return res.status(200).json({
      success: true,
      criteria,
      model: process.env.SCORING_MODEL || 'claude-sonnet-4-6',
      input_tokens: message.usage?.input_tokens,
      output_tokens: message.usage?.output_tokens
    });
  } catch (e) {
    console.error('suggest-criteria error:', e);
    return res.status(500).json({ error: e.message || String(e) });
  }
}

handler.config = { maxDuration: 60 };
module.exports = handler;
module.exports.default = handler;
