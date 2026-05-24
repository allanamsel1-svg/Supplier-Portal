// ════════════════════════════════════════════════════════════════════
// /api/generate-cross-source-summary.js
//
// Runs daily via Vercel cron. Pulls activity from all intelligence
// modules, sends to Claude, writes one paragraph to
// cross_source_summaries for today.
// ════════════════════════════════════════════════════════════════════

export const config = { runtime: 'nodejs' };
export const maxDuration = 60;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
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

export default async function handler(req, res) {
  if (!SUPABASE_URL || !SUPABASE_KEY || !ANTHROPIC_KEY) {
    return res.status(500).json({ error: 'Missing env vars' });
  }

  try {
    const since24 = new Date(Date.now() - 86400 * 1000).toISOString();
    const today = new Date().toISOString().substring(0, 10);

    const [news, brandProducts, runs] = await Promise.all([
      sb(`/rest/v1/news_articles?ingested_at=gte.${since24}&is_fluff=eq.false&select=headline,ai_highlight,signal_types,mentioned_brands&order=ingested_at.desc&limit=40`),
      sb(`/rest/v1/brand_watch_products?observed_at=gte.${since24}&select=product_title,brand_id&limit=100`),
      sb(`/rest/v1/brand_watch_runs?started_at=gte.${since24}&status=eq.success&select=brand_id,products_discovered,new_skus&limit=50`)
    ]);

    const counts = {
      news_signal_articles: (news || []).length,
      brand_products_observed: (brandProducts || []).length,
      brand_crawls_today: (runs || []).length
    };

    const hasAnyData = counts.news_signal_articles > 0 || counts.brand_products_observed > 0;
    if (!hasAnyData) {
      const fallback = `No new intelligence activity in the last 24 hours. Trigger a news refresh or run brand crawls to populate today's briefing.`;
      await upsertSummary(today, fallback, counts);
      return res.status(200).json({ success: true, summary: fallback, counts });
    }

    const prompt = `You are writing the daily Cross-Source Briefing for TBG's Retail Intelligence platform.

Activity in the last 24 hours:

NEWS & EDITORIAL (${counts.news_signal_articles} signal articles):
${(news || []).slice(0, 25).map(a => `- ${a.headline}${a.ai_highlight ? ' — ' + a.ai_highlight : ''}`).join('\n')}

BRAND WATCH (${counts.brand_crawls_today} brand crawls, ${counts.brand_products_observed} products):
${(runs || []).slice(0, 10).map(r => `- Brand ${r.brand_id}: ${r.products_discovered} products`).join('\n')}

Write ONE paragraph (3-5 sentences, max 600 chars) summarizing what's notable across the data. Focus on patterns and convergence — does the same brand or ingredient appear in multiple modules? Any launches that match brands on the watchlist? Be specific. Return ONLY the paragraph text.`;

    const resp = await claudeMessage([{ role: 'user', content: prompt }], 800);
    const summaryText = resp.content[0].text.trim();

    await upsertSummary(today, summaryText, counts);

    return res.status(200).json({ success: true, summary: summaryText, counts });

  } catch (err) {
    console.error('generate-cross-source-summary error:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function upsertSummary(date, text, counts) {
  const existing = await sb(`/rest/v1/cross_source_summaries?summary_date=eq.${date}&select=id`);
  if (existing && existing.length) {
    await sb(`/rest/v1/cross_source_summaries?id=eq.${existing[0].id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        summary_text: text,
        module_counts: counts,
        generated_at: new Date().toISOString()
      })
    });
  } else {
    await sb('/rest/v1/cross_source_summaries', {
      method: 'POST',
      body: JSON.stringify({
        summary_date: date,
        summary_text: text,
        module_counts: counts
      })
    });
  }
}
