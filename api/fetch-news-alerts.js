// ════════════════════════════════════════════════════════════════════
// /api/fetch-news-alerts.js  — v2
// Fix: properly strip HTML/URLs from RSS snippets before storing
// ════════════════════════════════════════════════════════════════════

export const config = { runtime: 'nodejs' };
export const maxDuration = 300;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';

const DEFAULT_QUERIES = [
  'beauty product launch',
  'cosmetics new launch',
  'celebrity beauty brand',
  'k-beauty brand launch',
  'fragrance launch',
  'skincare brand acquisition',
  'beauty industry merger',
  'Sephora new brand',
  'Sephora exclusive launch',
  'Ulta new brand',
  'Ulta exclusive launch',
  'clean beauty ingredient',
  'beauty industry M&A',
  'TikTok viral beauty product',
  'celebrity skincare line'
];

async function sb(path, opts = {}) {
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...(opts.headers || {})
  };
  const r = await fetch(`${SUPABASE_URL}${path}`, { ...opts, headers });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Supabase ${r.status} ${path}: ${body}`);
  }
  if (r.status === 204) return null;
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

async function claudeMessage(messages, maxTokens = 2000) {
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
  let cleaned = text.replace(/```json|```/g, '').trim();
  const fb = cleaned.indexOf('{') === -1 ? Infinity : cleaned.indexOf('{');
  const fbA = cleaned.indexOf('[') === -1 ? Infinity : cleaned.indexOf('[');
  const start = Math.min(fb, fbA);
  if (start === Infinity) throw new Error('No JSON');
  cleaned = cleaned.substring(start);
  const lb = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
  if (lb === -1) throw new Error('No closing brace');
  return JSON.parse(cleaned.substring(0, lb + 1));
}

// Normalize a headline for similarity comparison: lowercase, strip a trailing
// " - Source"/" | Source" suffix, remove punctuation, collapse whitespace.
function normalizeHeadline(title) {
  if (!title) return '';
  return title
    .replace(/\s*[-|–—]\s*[^-|–—]{1,40}$/, '')   // drop trailing " - Reuters" style source tag
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Rank a source for tie-breaking: known wire/trade outlets win over unknown blogs.
const PRIMARY_SOURCES = ['reuters','associated press','ap','bloomberg','wwd',"women's wear daily",'cnbc','the wall street journal','wsj','business of fashion','cosmetics business','happi','financial times','ft'];
function sourceRank(src) {
  const s = (src || '').toLowerCase();
  return PRIMARY_SOURCES.some(p => s.includes(p)) ? 1 : 0;  // 1 = primary, 0 = other
}

// Collapse articles that are the same story from different URLs by normalized
// headline. On a clash, keep the copy from the higher-ranked source.
function dedupeByTitle(articles) {
  const byTitle = new Map();
  for (const a of articles) {
    const key = normalizeHeadline(a.title);
    if (!key) { byTitle.set(Symbol(), a); continue; }  // no title — keep, can't compare
    const existing = byTitle.get(key);
    if (!existing) { byTitle.set(key, a); continue; }
    if (sourceRank(a.source) > sourceRank(existing.source)) byTitle.set(key, a);
  }
  return Array.from(byTitle.values());
}

async function sha256(text) {
  const enc = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── HTML/entity decoding (run twice for double-encoded) ──────────────
function decodeEntities(s) {
  if (!s) return s;
  for (let i = 0; i < 2; i++) {
    s = s.replace(/&amp;/g, '&')
         .replace(/&lt;/g, '<')
         .replace(/&gt;/g, '>')
         .replace(/&quot;/g, '"')
         .replace(/&#39;/g, "'")
         .replace(/&apos;/g, "'")
         .replace(/&nbsp;/g, ' ')
         .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
         .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
  }
  return s;
}

function stripHtml(s) {
  if (!s) return '';
  let cleaned = decodeEntities(s);
  cleaned = cleaned.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  cleaned = cleaned.replace(/<[^>]+>/g, ' ');
  cleaned = decodeEntities(cleaned);
  // Strip Google News tracking URLs that often leak through
  cleaned = cleaned.replace(/https?:\/\/news\.google\.com\/[^\s]+/g, '');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  return cleaned;
}

function parseRssXml(xml) {
  const items = [];
  const itemRegex = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item\s*>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    // raw = just the inner text with entities decoded; clean = full HTML/URL strip.
    const grab = (tag) => {
      const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}\\s*>`, 'i'));
      return m ? m[1] : null;
    };
    const title = grab('title') ? stripHtml(grab('title')) : null;
    // link must NOT go through stripHtml — it deletes news.google.com URLs.
    const rawLink = grab('link');
    const link = rawLink ? decodeEntities(rawLink).trim() : null;
    const pubDate = grab('pubDate') ? decodeEntities(grab('pubDate')).trim() : null;
    const description = grab('description') ? stripHtml(grab('description')) : null;
    const source = grab('source') ? stripHtml(grab('source')) : null;
    if (title && link) {
      items.push({ title, link, pubDate, description, source });
    }
  }
  return items;
}

async function fetchGoogleNewsRss(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'application/rss+xml,application/xml,text/xml,*/*',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });
  if (!r.ok) throw new Error(`Google News ${r.status} for "${query}"`);
  return parseRssXml(await r.text());
}

// Ensure stream weights are always the four known keys, each a number 0-1.
function normalizeStreamWeights(w) {
  const clamp = (n) => {
    const v = typeof n === 'number' ? n : parseFloat(n);
    if (isNaN(v)) return 0;
    return Math.max(0, Math.min(1, v));
  };
  w = w || {};
  return {
    trade: clamp(w.trade),
    consumer: clamp(w.consumer),
    celebrity: clamp(w.celebrity),
    lifestyle: clamp(w.lifestyle)
  };
}

async function classifyArticle(article) {
  const prompt = `You are classifying a beauty/HBA industry news article for a sourcing platform.

Article headline: ${article.title}
Article snippet: ${article.description || '(none)'}
Source: ${article.source || '(unknown)'}

Return ONLY valid JSON in this exact format:
{
  "is_fluff": true or false,
  "fluff_reason": "if fluff, brief reason; else null",
  "highlight": "1-2 sentence summary in YOUR OWN WORDS, max 240 chars. Do NOT echo raw URLs or HTML.",
  "signal_types": ["one or more of: brand_launch, product_launch, acquisition, executive_move, retail_partnership, category_trend, ingredient_trend, controversy, earnings, funding"],
  "mentioned_brands": ["brand names mentioned"],
  "mentioned_products": ["specific product names mentioned"],
  "mentioned_ingredients": ["ingredients mentioned"],
  "mentioned_celebrities": ["celebrity names mentioned"],
  "mentioned_retailers": ["retailer names mentioned"],
  "stream_weights": {
    "trade": 0.0 to 1.0,
    "consumer": 0.0 to 1.0,
    "celebrity": 0.0 to 1.0,
    "lifestyle": 0.0 to 1.0
  }
}

STREAM WEIGHTS — score how strongly this article belongs in each of the four streams, independently (an article can score high in several). Use the full 0-1 range; most articles are strong in one or two streams and near zero in the rest.
- trade: business-of-beauty — M&A, mergers, acquisitions, funding, earnings, executive moves, retailer expansion/partnerships, supply-chain, manufacturing, packaging, distribution. The sourcing-relevant stream.
- consumer: actual new products reaching shoppers — product launches, "now available", new lines hitting shelves/retail.
- celebrity: celebrity- or influencer-attached brands and launches (this stream feeds Brand Watch). Score high when a named celebrity/influencer is tied to a product or brand.
- lifestyle: softer editorial — trend roundups, "products to watch", seasonal edits, ranking listicles, routine/how-to content.
Example: a Selena Gomez Rare Beauty launch at Sephora might be celebrity 0.9, consumer 0.7, trade 0.4, lifestyle 0.1. A Puig/ELC merger might be trade 0.95, consumer 0.1, celebrity 0.0, lifestyle 0.0. A "20 best lipsticks of May" listicle might be lifestyle 0.9, consumer 0.4, the rest 0.0.

Fluff = generic listicles ("10 best lipsticks"), pure ad copy, "how to shop X sale", celebrity gossip without product attachment, broad seasonal roundups.
Signal = launches, M&A, ingredient trends, products selling out, celebrity-product attachments, category shifts, retail partnerships.
Use empty arrays [] when nothing to extract. Do not invent.`;

  try {
    const resp = await claudeMessage([{ role: 'user', content: prompt }], 1000);
    const parsed = extractJson(resp.content[0].text);
    // Defensive: drop highlight if it contains URL fragments
    if (parsed.highlight && /href=|https?:\/\/news\.google/i.test(parsed.highlight)) {
      parsed.highlight = null;
    }
    return parsed;
  } catch (err) {
    console.warn(`Classify failed for "${article.title}": ${err.message}`);
    return {
      is_fluff: false, fluff_reason: null, highlight: null,
      signal_types: [], mentioned_brands: [], mentioned_products: [],
      mentioned_ingredients: [], mentioned_celebrities: [], mentioned_retailers: [],
      stream_weights: { trade: 0, consumer: 0, celebrity: 0, lifestyle: 0 }
    };
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!SUPABASE_URL || !SUPABASE_KEY || !ANTHROPIC_KEY) return res.status(500).json({ error: 'Missing env vars' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const queries = (body && body.queries) || DEFAULT_QUERIES;

  try {
    const allArticles = [];
    for (const q of queries) {
      try {
        const items = await fetchGoogleNewsRss(q);
        items.slice(0, 10).forEach(item => allArticles.push({ ...item, query_used: q }));
      } catch (e) {
        console.warn(`Query "${q}" failed: ${e.message}`);
      }
    }

    const seenHashes = new Set();
    const dedup = [];
    for (const a of allArticles) {
      const h = await sha256(a.link);
      if (!seenHashes.has(h)) {
        seenHashes.add(h);
        a.url_hash = h;
        dedup.push(a);
      }
    }

    // Second pass: collapse syndicated copies of the same story (same headline,
    // different URLs) so we don't store or classify the same article repeatedly.
    const titleDeduped = dedupeByTitle(dedup);

    const hashes = titleDeduped.map(a => a.url_hash);
    let existingHashes = new Set();
    if (hashes.length) {
      const inList = hashes.map(h => `"${h}"`).join(',');
      const existing = await sb(`/rest/v1/news_articles?url_hash=in.(${inList})&select=url_hash`);
      existingHashes = new Set((existing || []).map(r => r.url_hash));
    }
    const fresh = titleDeduped.filter(a => !existingHashes.has(a.url_hash));

    const toInsert = [];
    const concurrency = 5;
    for (let i = 0; i < fresh.length; i += concurrency) {
      const batch = fresh.slice(i, i + concurrency);
      const classified = await Promise.all(batch.map(a => classifyArticle(a)));
      batch.forEach((a, idx) => {
        const c = classified[idx];
        const cleanSnippet = a.description ? stripHtml(a.description).substring(0, 1000) : null;
        toInsert.push({
          external_url: a.link,
          url_hash: a.url_hash,
          source_name: a.source || null,
          headline: a.title,
          snippet: cleanSnippet,
          ai_highlight: c.highlight,
          published_at: a.pubDate ? new Date(a.pubDate).toISOString() : null,
          query_used: a.query_used,
          is_fluff: !!c.is_fluff,
          fluff_reason: c.fluff_reason || null,
          signal_types: c.signal_types || [],
          mentioned_brands: c.mentioned_brands || [],
          mentioned_products: c.mentioned_products || [],
          mentioned_ingredients: c.mentioned_ingredients || [],
          mentioned_celebrities: c.mentioned_celebrities || [],
          mentioned_retailers: c.mentioned_retailers || [],
          stream_weights: normalizeStreamWeights(c.stream_weights)
        });
      });
    }

    if (toInsert.length) {
      const chunk = 50;
      for (let i = 0; i < toInsert.length; i += chunk) {
        await sb('/rest/v1/news_articles', {
          method: 'POST',
          body: JSON.stringify(toInsert.slice(i, i + chunk))
        });
      }
    }

    try { await regenerateDailySummary(); } catch (e) { console.warn(`Summary regen failed: ${e.message}`); }

    return res.status(200).json({
      success: true,
      queries_run: queries.length,
      articles_seen: dedup.length,
      title_duplicates_collapsed: dedup.length - titleDeduped.length,
      duplicates: titleDeduped.length - fresh.length,
      new_articles: toInsert.length,
      signal_count: toInsert.filter(a => !a.is_fluff).length,
      fluff_count: toInsert.filter(a => a.is_fluff).length
    });

  } catch (err) {
    console.error('fetch-news-alerts fatal:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function regenerateDailySummary() {
  const today = new Date().toISOString().substring(0, 10);
  const startOfDay = today + 'T00:00:00.000Z';
  const articles = await sb(`/rest/v1/news_articles?ingested_at=gte.${startOfDay}&is_fluff=eq.false&select=headline,ai_highlight,signal_types,mentioned_brands&order=ingested_at.desc&limit=80`);

  if (!articles || articles.length === 0) return;

  const condensed = articles.map(a => ({ h: a.headline, s: a.ai_highlight, t: a.signal_types, b: a.mentioned_brands }));

  const prompt = `You are writing a daily trend summary for a beauty/HBA sourcing platform.

Below are ${articles.length} signal articles ingested today. Write ONE paragraph (3-5 sentences, max 600 chars) summarizing what the beauty industry was talking about today. Focus on patterns: which brands appear most, which categories are heating up, any notable M&A or launches. Do not list articles individually.

Articles:
${JSON.stringify(condensed, null, 1)}

Return ONLY the paragraph text, no preamble, no JSON.`;

  const resp = await claudeMessage([{ role: 'user', content: prompt }], 800);
  const summaryText = resp.content[0].text.trim();

  const existing = await sb(`/rest/v1/news_daily_summaries?summary_date=eq.${today}&select=id`);
  if (existing && existing.length) {
    await sb(`/rest/v1/news_daily_summaries?id=eq.${existing[0].id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        summary_text: summaryText,
        article_count: articles.length,
        signal_article_count: articles.length,
        generated_at: new Date().toISOString()
      })
    });
  } else {
    await sb('/rest/v1/news_daily_summaries', {
      method: 'POST',
      body: JSON.stringify({
        summary_date: today,
        summary_text: summaryText,
        article_count: articles.length,
        signal_article_count: articles.length
      })
    });
  }
}
