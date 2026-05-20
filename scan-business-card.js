// ════════════════════════════════════════════════════════════════════
// /api/scan-business-card.js
//
// Three-pass business card extraction:
//   Pass 1 — TRANSCRIBE: read every piece of text on the card verbatim
//   Pass 2 — STRUCTURE: map the transcription to factory fields
//   Pass 3 — VERIFY: re-check structured output against the image,
//                    return per-field confidence 0-1
//
// POST body: { imageBase64: "..." }
// Returns: { cards: [{ ...fields, _confidence: { field: 0-1 }, _flagged: [field, ...] }] }
// ════════════════════════════════════════════════════════════════════

export const config = { runtime: 'nodejs' };
export const maxDuration = 60;

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL = 'claude-opus-4-20250514';

async function claudeMessage(messages, maxTokens = 4000) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: maxTokens, messages })
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${await r.text()}`);
  return r.json();
}

function extractJson(text) {
  let cleaned = text.trim().replace(/```json|```/g, '').trim();
  // Try array first
  let firstA = cleaned.indexOf('[');
  let firstO = cleaned.indexOf('{');
  let start;
  if (firstA === -1 && firstO === -1) throw new Error('No JSON found');
  if (firstA === -1) start = firstO;
  else if (firstO === -1) start = firstA;
  else start = Math.min(firstA, firstO);
  cleaned = cleaned.substring(start);
  let last = Math.max(cleaned.lastIndexOf(']'), cleaned.lastIndexOf('}'));
  if (last === -1) throw new Error('No closing brace');
  return JSON.parse(cleaned.substring(0, last + 1));
}

// ────────────────────────────────────────────────────────────────────
// PASS 1 — TRANSCRIBE
// ────────────────────────────────────────────────────────────────────
async function passTranscribe(imageBase64) {
  const prompt = `You are doing OCR-style transcription of a business card photo. Your only job in this pass is to READ what is visible — do not interpret, do not categorize, do not guess.

Look at the image carefully. Read every piece of visible text — Latin characters, Chinese/Japanese/Korean characters, numbers, symbols, URLs, email addresses, addresses, slogans, certifications listed on the card, anything printed or written.

If the image contains multiple separate business cards (different people, different companies, different designs), transcribe each one separately.
If the image is ONE card with multiple panels (folded/bilingual/same logo on both sides), treat as ONE.

Return ONLY valid JSON in this format — no prose, no markdown, no code fences:
{
  "card_count": <number of distinct cards detected>,
  "cards": [
    {
      "raw_text_lines": ["line 1 of text", "line 2", "..."],
      "languages_detected": ["English", "Chinese Simplified", "Korean", "..."],
      "card_quality_notes": "brief: e.g. 'clear and well-lit' or 'small text barely readable' or 'glossy reflection on right side'",
      "qr_codes_present": true | false,
      "logos_or_symbols": ["brief description of any logos/symbols seen"]
    }
  ]
}

If you cannot read something clearly, do NOT guess. Either omit it or note in card_quality_notes that part is unreadable.`;

  const resp = await claudeMessage([{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
      { type: 'text', text: prompt }
    ]
  }], 3000);
  return extractJson(resp.content[0].text);
}

// ────────────────────────────────────────────────────────────────────
// PASS 2 — STRUCTURE
// ────────────────────────────────────────────────────────────────────
async function passStructure(imageBase64, transcription) {
  const prompt = `You are mapping a business card to a structured factory record. You have already transcribed the visible text (provided below) — now map it to fields.

TRANSCRIPTION FROM PASS 1:
${JSON.stringify(transcription, null, 2)}

The image is also attached for reference — refer to it to disambiguate which text belongs to which field.

Return ONLY valid JSON — an ARRAY of card objects, one per distinct business card detected. Format:
[
  {
    "factory_name_english": "company name in Latin script — NOT the person's name",
    "factory_name_local": "company name in Chinese/Japanese/Korean characters, or empty",
    "founded_year": "year founded if mentioned on card (e.g. 'Est. 2005'), else empty",
    "factory_size": "any factory-size info on the card (e.g. '10,000 sqm', '500 employees', '3 production lines'), else empty",
    "listed_certifications": ["array of cert names printed on card — e.g. 'ISO 9001', 'BSCI', 'GMP'. Empty array if none."],
    "company_tagline_positioning": "any slogan, tagline, or positioning statement printed on card, else empty",
    "languages_on_card": ["English", "Chinese Simplified", "..."],
    "sales_contact_name": "the person's full name — use English version if both English and local appear",
    "contact_title": "job title (e.g. 'Sales Manager', 'Export Director')",
    "secondary_contacts": [
      {"name": "...", "title": "...", "email": "...", "phone": "..."}
    ],
    "sales_email": "primary email (closest to the person's name if multiple)",
    "sales_mobile": "mobile/cell number with country code if shown",
    "telephone": "landline (NOT fax)",
    "sales_wechat": "WeChat ID if printed in readable text — do NOT decode QR codes",
    "sales_whatsapp": "WhatsApp number if explicitly labeled as such",
    "website": "company website URL — NOT an email",
    "address": "full street address",
    "city": "city only",
    "state_province": "state or province if shown",
    "postal_code": "postal code if shown",
    "country": "country (infer from city if unambiguous — e.g. Shenzhen → China)",
    "product_categories": "what the company makes, in their own words from the card",
    "qr_codes_present": true | false,
    "card_quality_indicator": "professional / standard / minimal / poor — your read of how established the card looks",
    "notes": "anything else useful that doesn't fit other fields"
  }
]

STRICT RULES:
- IGNORE fax numbers entirely. Never put fax in telephone.
- NEVER put a person's name in a company field.
- NEVER mix data between different cards.
- If uncertain about digits in a number, leave the field empty rather than guess.
- Empty string "" for missing single-value fields. Empty array [] for missing list fields.
- Return only the JSON array. No prose. No markdown.`;

  const resp = await claudeMessage([{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
      { type: 'text', text: prompt }
    ]
  }], 4000);
  const parsed = extractJson(resp.content[0].text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

// ────────────────────────────────────────────────────────────────────
// PASS 3 — VERIFY
// ────────────────────────────────────────────────────────────────────
async function passVerify(imageBase64, structuredCards) {
  const prompt = `You are verifying business card extractions. The structured output below was generated from this image. For EACH card and EACH field, look at the image and assess: does the extracted value match what's actually printed on the card?

EXTRACTED CARDS:
${JSON.stringify(structuredCards, null, 2)}

Return ONLY valid JSON — an array matching the input array order:
[
  {
    "confidence": {
      "factory_name_english": 0.95,
      "factory_name_local": 1.0,
      "sales_contact_name": 0.8,
      "contact_title": 0.6,
      "sales_email": 1.0,
      "sales_mobile": 0.9,
      "telephone": 0.9,
      "sales_wechat": 0.7,
      "sales_whatsapp": 0.5,
      "website": 1.0,
      "address": 0.85,
      "city": 1.0,
      "country": 1.0,
      "founded_year": 0.0,
      "factory_size": 0.0,
      "listed_certifications": 0.9,
      "company_tagline_positioning": 0.7,
      "product_categories": 0.8,
      "secondary_contacts": 1.0
    },
    "corrections": {
      "field_name": "corrected value (only include fields you'd actually change)"
    },
    "flagged_for_review": ["list of field names where confidence < 0.85"]
  }
]

CONFIDENCE SCALE:
- 1.0 = field is empty and the card has no such info (no risk), OR field value matches the card exactly
- 0.85+ = clearly correct, minor cosmetic doubt (e.g. preserved spacing)
- 0.60-0.84 = mostly correct but some uncertainty (e.g. one character ambiguous)
- 0.30-0.59 = significant doubt — value may be wrong
- 0.0-0.29 = likely wrong or field value not actually visible on card

If you would change a field's value, list it in "corrections" with the better value. If the extraction is correct as-is, do NOT include the field in corrections.

Return only the JSON array.`;

  const resp = await claudeMessage([{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
      { type: 'text', text: prompt }
    ]
  }], 3000);
  const parsed = extractJson(resp.content[0].text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

// ════════════════════════════════════════════════════════════════════
// HANDLER
// ════════════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const { imageBase64 } = body || {};
  if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });

  try {
    // PASS 1 — Transcribe
    const transcription = await passTranscribe(imageBase64);

    // PASS 2 — Structure
    const structured = await passStructure(imageBase64, transcription);

    if (!structured || structured.length === 0) {
      return res.status(200).json({ cards: [], passes_run: 2, error: 'No cards detected' });
    }

    // PASS 3 — Verify
    let verification = [];
    try {
      verification = await passVerify(imageBase64, structured);
    } catch (e) {
      console.warn('Verify pass failed, continuing without confidence scores:', e.message);
    }

    // Merge: apply corrections, attach confidence, attach flagged list
    const finalCards = structured.map((card, idx) => {
      const v = verification[idx] || {};
      const corrections = v.corrections || {};
      const confidence = v.confidence || {};
      const flagged = v.flagged_for_review || [];

      const corrected = { ...card };
      Object.keys(corrections).forEach(k => {
        if (corrections[k] !== undefined && corrections[k] !== null) {
          corrected[k] = corrections[k];
        }
      });

      corrected._confidence = confidence;
      corrected._flagged = flagged;
      return corrected;
    });

    return res.status(200).json({
      cards: finalCards,
      passes_run: 3,
      transcription_preview: transcription
    });

  } catch (err) {
    console.error('scan-business-card error:', err);
    return res.status(500).json({ error: err.message });
  }
}
