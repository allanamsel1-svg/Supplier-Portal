// api/tenant-search.js
// Tenant AI search — answers questions using the tenant's own portal data as context.
// POST { query }  (tenant_id is derived from the validated session, not trusted from the body)
// Auth: Authorization: Bearer <tenant session token>  (same scheme as tenant-auth.js)
export const config = { runtime: 'nodejs' };

const SB_URL = process.env.SUPABASE_URL || 'https://mjkjubctswjwjihxjpnd.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const H = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' };

async function sbGet(path) {
  try {
    const r = await fetch(SB_URL + '/rest/v1/' + path, { headers: H });
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}

async function readBody(req) {
  let b = req.body;
  if (b == null) {
    const chunks = [];
    await new Promise((resolve) => { req.on('data', c => chunks.push(typeof c === 'string' ? Buffer.from(c) : c)); req.on('end', resolve); req.on('error', resolve); });
    try { b = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { b = {}; }
  } else if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
  else if (Buffer.isBuffer(b)) { try { b = JSON.parse(b.toString('utf8')); } catch { b = {}; } }
  return b || {};
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── 1. Validate session ──
  const token = (req.headers.authorization || req.headers.Authorization || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  let session = null;
  try {
    const r = await fetch(SB_URL + '/rest/v1/tenant_sessions?select=tenant_id,expires_at&token=eq.' + encodeURIComponent(token) + '&limit=1', { headers: H });
    const arr = r.ok ? await r.json() : [];
    session = Array.isArray(arr) ? arr[0] : null;
  } catch { session = null; }
  if (!session || new Date(session.expires_at) < new Date()) return res.status(401).json({ error: 'Invalid session' });

  const tid = session.tenant_id;
  const body = await readBody(req);
  const query = (body.query || '').toString().trim();
  if (!query) return res.status(400).json({ error: 'Query required' });
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'Search is not configured (missing ANTHROPIC_API_KEY).' });

  const etid = encodeURIComponent(tid);

  // ── 2. Pull tenant context (parallel) ──
  const [tenantRows, factories, rfqs, skus, news, observations, brandRuns] = await Promise.all([
    sbGet('tenants?id=eq.' + etid + '&select=name&limit=1'),
    sbGet('factories?tenant_id=eq.' + etid + '&select=factory_name_english,product_categories,status&order=created_at.desc&limit=20'),
    sbGet('rfqs?tenant_id=eq.' + etid + '&select=project_number,item_description,status&order=created_at.desc&limit=20'),
    sbGet('skus?tenant_id=eq.' + etid + '&select=model_number,description,status&order=created_at.desc&limit=20'),
    sbGet('news_daily_summaries?tenant_id=eq.' + etid + '&select=summary_date,summary_text&order=summary_date.desc&limit=10'),
    sbGet('shop_out_observations?tenant_id=eq.' + etid + '&select=brand,product_name,retail_price&order=created_at.desc&limit=20'),
    sbGet('brand_watch_runs?tenant_id=eq.' + etid + '&select=started_at,status,products_discovered,brand_watch_brands(name)&order=started_at.desc&limit=10'),
  ]);

  const tenantName = (tenantRows[0] && tenantRows[0].name) || 'your company';

  const context = {
    factories: factories.map(f => ({ name: f.factory_name_english, categories: f.product_categories, status: f.status })),
    rfqs: rfqs.map(r => ({ project: r.project_number, item: r.item_description, status: r.status })),
    skus: skus.map(s => ({ code: s.model_number, name: s.description, status: s.status })),
    daily_news: news.map(n => ({ date: n.summary_date, summary: n.summary_text })),
    shop_out_observations: observations.map(o => ({ brand: o.brand, product: o.product_name, retail_price: o.retail_price })),
    brand_watch: brandRuns.map(b => ({ brand: b.brand_watch_brands && b.brand_watch_brands.name, products: b.products_discovered, status: b.status, run: b.started_at })),
  };

  const sources = [];
  if (factories.length) sources.push('factories');
  if (rfqs.length) sources.push('rfqs');
  if (skus.length) sources.push('skus');
  if (news.length) sources.push('daily_news');
  if (observations.length) sources.push('shop_out_observations');
  if (brandRuns.length) sources.push('brand_watch');

  // ── 3. System prompt ──
  const system = 'You are a sourcing intelligence assistant for ' + tenantName + '. ' +
    'Answer questions using the following portal data as context. Be concise and specific. ' +
    'If data is insufficient, say so.\n\nPORTAL DATA (JSON):\n' + JSON.stringify(context);

  // ── 4. Call Anthropic ──
  let answer = '', tokensIn = 0, tokensOut = 0;
  try {
    const ar = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system,
        messages: [{ role: 'user', content: query }],
      }),
    });
    const ad = await ar.json().catch(() => ({}));
    if (!ar.ok) {
      console.error('tenant-search: anthropic error', ar.status, ad);
      return res.status(502).json({ error: 'Search engine error. Please try again.' });
    }
    answer = (ad.content && ad.content[0] && ad.content[0].text) || '';
    tokensIn = (ad.usage && ad.usage.input_tokens) || 0;
    tokensOut = (ad.usage && ad.usage.output_tokens) || 0;
  } catch (e) {
    console.error('tenant-search: anthropic threw', e);
    return res.status(502).json({ error: 'Search engine error. Please try again.' });
  }

  // ── 6. Log cost (best-effort) ──
  const costUsd = (tokensIn / 1e6) * 3 + (tokensOut / 1e6) * 15;
  fetch(SB_URL + '/rest/v1/api_cost_log', {
    method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
    body: JSON.stringify({
      tenant_id: tid, service: 'anthropic', feature: 'tenant_search',
      model: 'claude-sonnet-4-6', tokens_in: tokensIn, tokens_out: tokensOut,
      cost_usd: costUsd, cost_usd_marked_up: costUsd * 1.5,
      prompt_summary: query.slice(0, 100),
    }),
  }).catch(() => {});

  // ── 5. Return ──
  return res.status(200).json({ answer, sources });
}
