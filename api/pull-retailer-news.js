// ════════════════════════════════════════════════════════════════════
// /api/pull-retailer-news.js
//
// Pulls Google News articles for each active retailer's query terms,
// classifies each with Claude (reusing the same logic as fetch-news-alerts),
// writes to news_articles + retailer_news join table.
//
// POST body: { retailer_id?: uuid }  // omit to run for all active retailers
// ════════════════════════════════════════════════════════════════════

export const config = { runtime: 'nodejs' };
export const maxDuration = 300;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL = 'claude-sonnet-4-6';

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

function normalizeHeadline(title) {
  if (!title) return '';
  return title
    .replace(/\s*[-|–—]\s*[^-|–—]{1,40}$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
const PRIMARY_SOURCES = ['reuters','associated press','ap','bloomberg','wwd',"women's wear daily",'cnbc','the wall street journal','wsj','business of fashion','cosmetics business','happi','financial times','ft'];
function sourceRank(src) {
  const s = (src || '').toLowerCase();
  return PRIMARY_SOURCES.some(p => s.includes(p)) ? 1 : 0;
}
function dedupeByTitle(articles) {
  const byTitle = new Map();
  for (const a of articles) {
    const key = normalizeHeadline(a.title);
    if (!key) { byTitle.set(Symbol(), a); continue; }
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

function decodeEntities(s) {
  if (!s) return s;
  for (let i = 0; i < 2; i++) {
    s = s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
         .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
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
  cleaned = cleaned.replace(/https?:\/\/news\.google\.com\/[^\s]+/g, '');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  return cleaned;
}

function parseRssXml(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const get = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      if (!m) return null;
      return stripHtml(m[1]);
    };
    const title = get('title');
    const link = get('link');
    const pubDate = get('pubDate');
    const description = get('description');
    const source = get('source');
    if (title && link) items.push({ title, link, pubDate, description, source });
  }
  return items;
}

async function fetchGoogleNewsRss(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TBGIntelBot/1.0)' } });
  if (!r.ok) throw new Error(`Google News ${r.status} for "${query}"`);
  return parseRssXml(await r.text());
}

async function classifyArticle(article, retailerName) {
  const prompt = `You are classifying a retailer news article for TBG's Retailer Intel module.

Article headline: ${article.title}
Article snippet: ${article.description || '(none)'}
Source: ${article.source || '(unknown)'}
Tracked retailer: ${retailerName}

Return ONLY valid JSON in this format:
{
  "is_fluff": true or false,
  "fluff_reason": "if fluff, brief reason; else null",
  "highlight": "1-2 sentence summary in YOUR OWN WORDS, max 240 chars. Focus on what's interesting for a sourcing-strategy reader. Do NOT echo URLs or HTML.",
  "signal_types": ["one or more of: earnings, store_openings, store_closings, exec_move, acquisition, private_label, category_expansion, supply_chain, partnership, controversy, guidance_change"],
  "mentioned_brands": ["brand names mentioned"],
  "mentioned_categories": ["product categories mentioned"],
  "mentioned_retailers": ["retailer names mentioned"],
  "relevance_to_retailer": "high | medium | low | unrelated — how relevant is this to ${retailerName} specifically?"
}

Fluff = generic listicles, deal roundups, broad market commentary without retailer-specific info.
Signal = anything with sourcing implications: earnings detail, category moves, exec changes, store moves, M&A, private-label plans, supply chain commentary.
Use empty arrays where nothing to extract. Do not invent.`;

  try {
    const resp = await claudeMessage([{ role: 'user', content: prompt }], 800);
    const parsed = extractJson(resp.content[0].text);
    if (parsed.highlight && /href=|https?:\/\/news\.google/i.test(parsed.highlight)) parsed.highlight = null;
    return parsed;
  } catch (err) {
    console.warn(`Classify failed for "${article.title}": ${err.message}`);
    return {
      is_fluff: false, fluff_reason: null, highlight: null,
      signal_types: [], mentioned_brands: [], mentioned_categories: [], mentioned_retailers: [],
      relevance_to_retailer: 'medium'
    };
  }
}

// ════════════════════════════════════════════════════════════════════

export default async function handler(req, res) {
  if (!SUPABASE_URL || !SUPABASE_KEY || !ANTHROPIC_KEY) {
    return res.status(500).json({ error: 'Missing env vars' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const filterRetailerId = body && body.retailer_id;

  try {
    let retailersQuery = '/rest/v1/retailers?status=eq.active';
    if (filterRetailerId) retailersQuery += `&id=eq.${filterRetailerId}`;
    const retailers = await sb(retailersQuery + '&select=id,name,news_query_terms');

    if (!retailers || retailers.length === 0) {
      return res.status(200).json({ success: true, retailers_checked: 0, new_articles: 0 });
    }

    let totalNew = 0;
    const perRetailer = [];

    for (const r of retailers) {
      const queries = (r.news_query_terms || []).filter(Boolean);
      if (queries.length === 0) {
        perRetailer.push({ retailer: r.name, new_articles: 0, note: 'no query terms configured' });
        continue;
      }

      const runRows = await sb('/rest/v1/retailer_runs', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          retailer_id: r.id,
          run_type: 'news_pull',
          status: 'running',
          trigger_type: filterRetailerId ? 'manual' : 'scheduled'
        })
      });
      const runId = runRows[0].id;
      let newCountForRetailer = 0;

      try {
        const allArticles = [];
        for (const q of queries) {
          try {
            const items = await fetchGoogleNewsRss(q);
            items.slice(0, 6).forEach(item => allArticles.push({ ...item, query_used: q }));
          } catch (e) {
            console.warn(`Query "${q}" failed for ${r.name}: ${e.message}`);
          }
        }

        // Dedupe by URL hash
        const seen = new Set();
        const urlDedup = [];
        for (const a of allArticles) {
          const h = await sha256(a.link);
          if (!seen.has(h)) { seen.add(h); a.url_hash = h; urlDedup.push(a); }
        }
        // Collapse syndicated copies (same headline, different URLs)
        const dedup = dedupeByTitle(urlDedup);

        // Find which are already in news_articles
        if (dedup.length === 0) {
          await sb(`/rest/v1/retailer_runs?id=eq.${runId}`, {
            method: 'PATCH',
            body: JSON.stringify({ status: 'success', completed_at: new Date().toISOString(), new_news_count: 0 })
          });
          perRetailer.push({ retailer: r.name, new_articles: 0 });
          continue;
        }

        const hashList = dedup.map(a => `"${a.url_hash}"`).join(',');
        const existing = await sb(`/rest/v1/news_articles?url_hash=in.(${hashList})&select=id,url_hash`);
        const existingByHash = new Map((existing || []).map(x => [x.url_hash, x.id]));

        // For articles already in news_articles, just link them via retailer_news (if not already linked)
        const alreadyLinkedIds = new Set();
        if (existingByHash.size) {
          const existingIdList = Array.from(existingByHash.values()).map(id => `"${id}"`).join(',');
          const existingLinks = await sb(`/rest/v1/retailer_news?retailer_id=eq.${r.id}&news_article_id=in.(${existingIdList})&select=news_article_id`);
          (existingLinks || []).forEach(x => alreadyLinkedIds.add(x.news_article_id));
        }

        const linkRowsForExisting = [];
        const freshToInsert = [];
        for (const a of dedup) {
          if (existingByHash.has(a.url_hash)) {
            const articleId = existingByHash.get(a.url_hash);
            if (!alreadyLinkedIds.has(articleId)) {
              linkRowsForExisting.push({ retailer_id: r.id, news_article_id: articleId });
            }
          } else {
            freshToInsert.push(a);
          }
        }

        // Classify and insert fresh articles
        const insertedArticles = [];
        const concurrency = 5;
        for (let i = 0; i < freshToInsert.length; i += concurrency) {
          const batch = freshToInsert.slice(i, i + concurrency);
          const classified = await Promise.all(batch.map(a => classifyArticle(a, r.name)));
          const rows = batch.map((a, idx) => {
            const c = classified[idx];
            const cleanSnippet = a.description ? stripHtml(a.description).substring(0, 1000) : null;
            return {
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
              mentioned_retailers: c.mentioned_retailers || []
            };
          });

          if (rows.length) {
            const inserted = await sb('/rest/v1/news_articles', {
              method: 'POST',
              headers: { Prefer: 'return=representation' },
              body: JSON.stringify(rows)
            });
            if (inserted) insertedArticles.push(...inserted);
          }
        }

        // Build retailer_news join rows for newly inserted
        const newLinkRows = insertedArticles.map(a => ({ retailer_id: r.id, news_article_id: a.id }));
        const allLinkRows = [...linkRowsForExisting, ...newLinkRows];
        if (allLinkRows.length) {
          await sb('/rest/v1/retailer_news', {
            method: 'POST',
            headers: { Prefer: 'resolution=ignore-duplicates' },
            body: JSON.stringify(allLinkRows)
          });
        }

        newCountForRetailer = insertedArticles.length;
        totalNew += newCountForRetailer;

        await sb(`/rest/v1/retailer_runs?id=eq.${runId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            status: 'success',
            completed_at: new Date().toISOString(),
            new_news_count: newCountForRetailer
          })
        });
        perRetailer.push({ retailer: r.name, new_articles: newCountForRetailer });

      } catch (err) {
        console.error(`News pull failed for ${r.name}:`, err);
        await sb(`/rest/v1/retailer_runs?id=eq.${runId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            status: 'failed',
            completed_at: new Date().toISOString(),
            error_message: err.message.substring(0, 500)
          })
        });
        perRetailer.push({ retailer: r.name, error: err.message });
      }
    }

    return res.status(200).json({
      success: true,
      retailers_checked: retailers.length,
      new_articles: totalNew,
      detail: perRetailer
    });

  } catch (err) {
    console.error('pull-retailer-news fatal:', err);
    return res.status(500).json({ error: err.message });
  }
}
