// ════════════════════════════════════════════════════════════════════
// /api/cross-source-search.js
//
// Takes a natural language query, pulls recent context from each
// intelligence module, sends to Claude with module context, returns
// synthesized answer. Logs the query.
//
// POST body: { query: "..." }
// ════════════════════════════════════════════════════════════════════

export const config = { runtime: 'nodejs' };
export const maxDuration = 60;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';

async function sb(path) {
  const r = await fetch(`${SUPABASE_URL}${path}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json'
    }
  });
  if (!r.ok) return null;
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

async function sbWrite(path, body) {
  return fetch(`${SUPABASE_URL}${path}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
}

async function claudeMessage(messages, maxTokens = 1500) {
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

async function gatherContext() {
  const since30 = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
  const since7 = new Date(Date.now() - 7 * 86400 * 1000).toISOString();

  const [news, brands, brandProducts, shopOuts] = await Promise.all([
    sb(`/rest/v1/news_articles?is_fluff=eq.false&ingested_at=gte.${since7}&select=headline,ai_highlight,signal_types,mentioned_brands,mentioned_ingredients,mentioned_celebrities,mentioned_retailers,published_at&order=published_at.desc.nullslast&limit=60`),
    sb(`/rest/v1/brand_watch_brands?select=name,tier,domain&status=eq.active&order=tier.asc,name.asc`),
    sb(`/rest/v1/brand_watch_products?observed_at=gte.${since30}&select=product_title,price_current_cents,in_stock,brand_id&order=observed_at.desc&limit=200`),
    sb(`/rest/v1/shop_out_observations?select=brand,product_name,retail_price,department&limit=80&order=created_at.desc.nullslast`)
  ]);

  return {
    news: news || [],
    brands: brands || [],
    brandProducts: brandProducts || [],
    shopOuts: shopOuts || []
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!SUPABASE_URL || !SUPABASE_KEY || !ANTHROPIC_KEY) {
    return res.status(500).json({ error: 'Missing env vars' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const { query } = body || {};
  if (!query || !query.trim()) return res.status(400).json({ error: 'query required' });

  try {
    const ctx = await gatherContext();
    const modulesUsed = [];
    if (ctx.news.length) modulesUsed.push('news');
    if (ctx.brands.length) modulesUsed.push('brand_watch');
    if (ctx.brandProducts.length) modulesUsed.push('brand_products');
    if (ctx.shopOuts.length) modulesUsed.push('shop_outs');

    const prompt = `You are the AI search layer for TBG's Retail Intelligence platform. The user asked a question. You have data from multiple intelligence modules below. Answer concisely (3-5 sentences max). Be honest about what you found and didn't find. Cite which module a fact came from when relevant.

USER QUESTION: ${query}

DATA AVAILABLE:

== News & Editorial (last 7 days, signal articles only, ${ctx.news.length} articles) ==
${ctx.news.length ? JSON.stringify(ctx.news.slice(0, 40), null, 1) : '(none yet)'}

== Brand Watch (${ctx.brands.length} brands on watchlist) ==
${ctx.brands.length ? ctx.brands.map(b => `Tier ${b.tier}: ${b.name} (${b.domain})`).join('\n') : '(none)'}

== Brand Watch Products (last 30 days scraped catalog, ${ctx.brandProducts.length} products) ==
${ctx.brandProducts.length ? JSON.stringify(ctx.brandProducts.slice(0, 100), null, 1) : '(no products scraped yet)'}

== Shop Outs (recent retail observations, ${ctx.shopOuts.length} items) ==
${ctx.shopOuts.length ? JSON.stringify(ctx.shopOuts.slice(0, 40), null, 1) : '(none)'}

Answer the question using ONLY the data above. If the data doesn't cover the question, say so plainly. Do not invent.`;

    const resp = await claudeMessage([{ role: 'user', content: prompt }], 1200);
    const answer = resp.content[0].text.trim();

    await sbWrite('/rest/v1/cross_source_queries', {
      query_text: query,
      response_text: answer,
      modules_used: modulesUsed,
      result_count: ctx.news.length + ctx.brandProducts.length + ctx.shopOuts.length
    });

    return res.status(200).json({
      answer,
      modules_used: modulesUsed,
      context_size: {
        news: ctx.news.length,
        brands: ctx.brands.length,
        brand_products: ctx.brandProducts.length,
        shop_outs: ctx.shopOuts.length
      }
    });

  } catch (err) {
    console.error('cross-source-search error:', err);
    return res.status(500).json({ error: err.message });
  }
}
