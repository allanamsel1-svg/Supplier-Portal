// /api/analyze-shopout-batch.js
//
// Browser-side video shop-out processing calls this once per batch of frames.
// No auth (called mid-processing from the shop-out pages); protected by a simple
// per-IP rate limit. Sends frames to Claude vision and returns extracted products.
//
//   POST { frames: [base64...], store_name, batch_index, total_batches }
//     → { products: [...] }

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-opus-4-5';
const MAX_TOKENS = 1500;

// Best-effort in-memory rate limiter: 100 calls/hour/IP. Serverless instances are
// ephemeral so this is not a hard guarantee, just abuse dampening per warm instance.
const RL = global.__shopoutBatchRL || (global.__shopoutBatchRL = new Map());
function rateLimited(ip) {
  const now = Date.now(), HOUR = 3600 * 1000;
  const hits = (RL.get(ip) || []).filter(t => now - t < HOUR);
  if (hits.length >= 100) { RL.set(ip, hits); return true; }
  hits.push(now); RL.set(ip, hits);
  return false;
}

const SYSTEM_PROMPT = 'You are a retail intelligence AI analyzing shelf footage from a store walkthrough. Extract every visible product with precision.';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'AI service is not configured.' });

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (rateLimited(ip)) return res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  const { frames, store_name, batch_index, total_batches } = body;
  if (!Array.isArray(frames) || !frames.length) return res.status(400).json({ error: 'No frames provided' });

  const store = store_name || 'Unknown Store';
  const userPrompt = `These are ${frames.length} consecutive frames from a retail shelf walkthrough at ${store}. For each clearly visible product extract: product_name, brand, category, price (read from shelf price signs — at Five Below prices are $1/$3/$5/$7/$10), price_confidence (high/medium/low), packaging, size, upc (if visible), quantity_on_shelf, notes. Associate each product with the nearest price sign. List each unique product ONCE even if visible in multiple frames. Respond ONLY with a JSON array.`;

  const content = [{ type: 'text', text: userPrompt }];
  for (const f of frames) {
    const data = typeof f === 'string' && f.indexOf(',') !== -1 ? f.split(',')[1] : f; // strip data: URL prefix if present
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } });
  }

  try {
    const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content }],
      }),
    });

    if (!aiResp.ok) {
      const txt = await aiResp.text().catch(() => '');
      return res.status(502).json({ error: `AI service error ${aiResp.status}`, details: txt.slice(0, 500) });
    }

    const aiData = await aiResp.json();
    const responseText = (aiData.content || []).map(c => c.text || '').join('\n');
    let products = [];
    try {
      const cleaned = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed = JSON.parse(cleaned);
      products = Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return res.status(200).json({ products: [], parse_error: true, batch_index, total_batches });
    }

    return res.status(200).json({ products, batch_index, total_batches });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
};
