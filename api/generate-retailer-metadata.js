// ════════════════════════════════════════════════════════════════════
// /api/generate-retailer-metadata.js
//
// Given a retailer name + ticker, asks Claude to generate:
//   - news_query_terms (4-6 retailer-specific Google News queries)
//   - ir_url (best-guess investor relations URL)
//   - primary_url (best-guess consumer site URL)
//
// POST body: { name, ticker?, tier?, hq_city?, hq_state? }
// ════════════════════════════════════════════════════════════════════

export const config = { runtime: 'nodejs' };
export const maxDuration = 30;

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL = 'claude-sonnet-4-6';

async function claudeMessage(messages, maxTokens = 800) {
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
  const fb = cleaned.indexOf('{') === -1 ? Infinity : cleaned.indexOf('{');
  const fbA = cleaned.indexOf('[') === -1 ? Infinity : cleaned.indexOf('[');
  const start = Math.min(fb, fbA);
  if (start === Infinity) throw new Error('No JSON');
  cleaned = cleaned.substring(start);
  const lb = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
  if (lb === -1) throw new Error('No closing brace');
  return JSON.parse(cleaned.substring(0, lb + 1));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const { name, ticker, tier, hq_city, hq_state } = body || {};
  if (!name) return res.status(400).json({ error: 'name required' });

  const tierContext = {
    1: 'off-price retailer (like TJX, Burlington, Ross)',
    2: 'mass or value retailer (like Walmart, Target, Dollar General)',
    3: 'drug or beauty specialty retailer (like CVS, Walgreens, Ulta)',
    4: 'club or department store (like Costco, Kohls, Macys)'
  };

  const prompt = `You are setting up monitoring for a US retailer in a sourcing intelligence platform.

RETAILER NAME: ${name}
${ticker ? `TICKER: ${ticker}` : ''}
${tier ? `TIER: ${tier} — ${tierContext[tier] || ''}` : ''}
${hq_city ? `HQ: ${hq_city}${hq_state ? ', ' + hq_state : ''}` : ''}

The platform pulls Google News articles using query terms tailored to each retailer. We're focused on signals useful to a beauty/HBC/general-merchandise sourcing company that sells INTO this retailer.

Generate retailer-specific metadata. Return ONLY valid JSON in this exact format:

{
  "news_query_terms": [
    "4 to 6 Google News search queries, retailer-specific",
    "each should be 2-5 words, no quotes needed inside",
    "first should always be '<retailer name> earnings'",
    "include relevant subsidiaries / banner brands if applicable",
    "include topic-specific queries: new stores, store closings, private label, beauty/HBC moves, exec changes, partnerships, exclusive launches",
    "avoid generic queries — they should be retailer-specific"
  ],
  "ir_url": "best-guess investor relations URL (e.g. https://investor.companyname.com or https://investors.companyname.com or https://ir.companyname.com)",
  "primary_url": "best-guess main consumer website URL (e.g. https://companyname.com)",
  "slug": "lowercase URL-friendly slug from the name (e.g. 'foot-locker' for Foot Locker)",
  "notes": "1 sentence about what this retailer means for sourcing intel — what to watch for"
}

EXAMPLES of good query term sets:

For "Foot Locker":
["Foot Locker earnings", "Foot Locker new stores", "Foot Locker store closings", "Champs Sports", "Kids Foot Locker", "Foot Locker private label"]

For "Sephora":
["Sephora earnings", "Sephora new brand launch", "Sephora exclusive", "Sephora Kohls", "Sephora private label", "Sephora store openings"]

For "Tractor Supply":
["Tractor Supply earnings", "Tractor Supply new stores", "Tractor Supply private label", "Tractor Supply Petsense", "Tractor Supply pet"]

Return ONLY the JSON object. No preamble.`;

  try {
    const resp = await claudeMessage([{ role: 'user', content: prompt }], 1000);
    const parsed = extractJson(resp.content[0].text);

    // Defensive: ensure required fields exist with sensible fallbacks
    if (!Array.isArray(parsed.news_query_terms) || parsed.news_query_terms.length === 0) {
      parsed.news_query_terms = [`${name} earnings`, `${name} new stores`, `${name} private label`];
    }
    if (!parsed.slug) {
      parsed.slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    }
    if (!parsed.primary_url) {
      const domain = name.toLowerCase().replace(/[^a-z0-9]+/g, '');
      parsed.primary_url = `https://${domain}.com`;
    }

    return res.status(200).json({ success: true, ...parsed });

  } catch (err) {
    console.error('generate-retailer-metadata error:', err);
    return res.status(500).json({ error: err.message });
  }
}
