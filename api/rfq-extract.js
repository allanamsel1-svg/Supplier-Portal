// api/rfq-extract.js
// Extract draft-RFQ fields from a product image via Claude vision.
//   POST { image: <base64 string, no data: prefix>, mediaType: 'image/jpeg' }
//   Auth: Bearer <tenant session token | admin session token>
//   → { product_name, category, short_description, estimated_retail_price_usd,
//       packaging_type, tenant_id }  | { error: true, message }
// Cost is logged to api_cost_log (1.5x markup) the same way api/tenant-search.js does.
export const config = { runtime: 'nodejs' };

import { createHmac, timingSafeEqual } from 'crypto';

const SB_URL = process.env.SUPABASE_URL || 'https://mjkjubctswjwjihxjpnd.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const H = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' };
const MODEL = 'claude-sonnet-4-6';

// A valid admin session token (same HMAC scheme as api/admin-auth.js) resolves to Byline Brands.
const ADMIN_TENANT_ID = 'f64c18ac-c0b4-4bba-a3e6-b64ef0fd3bf4';
function verifyAdminToken(token) {
  const key = String(process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASSWORD || '').trim();
  if (!key || !token || typeof token !== 'string' || token.indexOf('.') === -1) return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  const expected = createHmac('sha256', key).update(payload).digest('base64url');
  if (sig.length !== expected.length) return false;
  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return !obj.exp || Date.now() < obj.exp;
  } catch { return false; }
}

// Resolve the caller's tenant_id: admin token → Byline Brands; otherwise a valid tenant session.
async function resolveTenantId(token) {
  if (!token) return null;
  if (verifyAdminToken(token)) return ADMIN_TENANT_ID;
  try {
    const r = await fetch(SB_URL + '/rest/v1/tenant_sessions?select=tenant_id,expires_at&token=eq.' + encodeURIComponent(token) + '&limit=1', { headers: H });
    const arr = r.ok ? await r.json() : [];
    const s = Array.isArray(arr) ? arr[0] : null;
    if (s && new Date(s.expires_at) >= new Date()) return s.tenant_id;
  } catch { /* fall through */ }
  return null;
}

// Mirror api/tenant-search.js logCost: sonnet $3/$15 per 1M, logged with a 1.5x markup.
function logCost(tid, feature, model, usage) {
  const tin = (usage && usage.input_tokens) || 0, tout = (usage && usage.output_tokens) || 0;
  const haiku = /haiku/i.test(model);
  const costUsd = haiku ? (tin / 1e6) * 0.8 + (tout / 1e6) * 4 : (tin / 1e6) * 3 + (tout / 1e6) * 15;
  fetch(SB_URL + '/rest/v1/api_cost_log', { method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
    body: JSON.stringify({ tenant_id: tid, service: 'anthropic', feature, model, tokens_in: tin, tokens_out: tout, cost_usd: costUsd, cost_usd_marked_up: costUsd * 1.5, prompt_summary: feature }) }).catch(() => {});
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

// Parse model output into an array of product objects. It may return a JSON array, a single
// object, or either wrapped in code fences — normalize all of those to an array.
function parseItems(text) {
  const t = (text || '').trim().replace(/```json|```/g, '').trim();
  let v = null;
  try { v = JSON.parse(t); } catch { /* try to locate a JSON array/object substring */ }
  if (v == null) { const a = t.indexOf('['), b = t.lastIndexOf(']'); if (a !== -1 && b !== -1) { try { v = JSON.parse(t.substring(a, b + 1)); } catch {} } }
  if (v == null) { const o = t.indexOf('{'), c = t.lastIndexOf('}'); if (o !== -1 && c !== -1) { try { v = JSON.parse(t.substring(o, c + 1)); } catch {} } }
  if (v == null) return null;
  if (Array.isArray(v)) return v.filter(x => x && typeof x === 'object');
  if (typeof v === 'object') return [v];
  return null;
}

const URL_SYSTEM = "You are a product analyst. Given this product information scraped from a webpage, extract and return ONLY valid JSON with these fields: product_name (string), category (pick from: Personal Care, Hair Care, Skin Care, Home Care, Consumer Electronics, Pet, Baby, Food & Beverage, Other), short_description (1-2 sentences), estimated_retail_price_usd (number only, null if unknown), packaging_type (e.g. bottle, jar, tube, box, pouch, null if unknown), recommended_factory_type (1 sentence on what factory type should make this). No markdown, no backticks.";

const SCRAPE_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ');
}
// Pull a <meta property|name="<prop>" content="..."> value (attributes in any order).
function metaContent(html, prop) {
  const p = prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = html.match(new RegExp('<meta[^>]+(?:property|name)=["\']' + p + '["\'][^>]*content=["\']([^"\']*)["\']', 'i'))
        || html.match(new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]*(?:property|name)=["\']' + p + '["\']', 'i'));
  return m ? decodeEntities(m[1]).trim() : '';
}
// Scrape product fields from raw HTML (best-effort).
function scrapeProduct(html) {
  const out = { image_url: null, product_name: null, short_description: null, estimated_retail_price_usd: null };
  // image_url: og:image, else first http(s) <img src>
  out.image_url = metaContent(html, 'og:image') || null;
  if (!out.image_url) { const m = html.match(/<img[^>]+src=["'](https?:\/\/[^"']+)["']/i); if (m) out.image_url = m[1]; }
  // product_name: og:title, else <title> (strip " | site" / " - site")
  let name = metaContent(html, 'og:title');
  if (!name) { const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i); if (t) name = decodeEntities(t[1]).trim(); }
  if (name) name = name.split(/\s+[|\-–—]\s+/)[0].trim();
  out.product_name = name || null;
  // short_description: og:description, else first <p> with >50 chars
  let desc = metaContent(html, 'og:description');
  if (!desc) {
    const ps = html.match(/<p[^>]*>([\s\S]*?)<\/p>/gi) || [];
    for (let i = 0; i < ps.length; i++) { const txt = decodeEntities(ps[i].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim(); if (txt.length > 50) { desc = txt; break; } }
  }
  out.short_description = desc || null;
  // estimated_retail_price_usd: first $XX.XX or $X,XXX.XX
  const pm = html.match(/\$\s?(\d{1,3}(?:,\d{3})+\.\d{2}|\d+\.\d{2})/);
  if (pm) { const n = parseFloat(pm[1].replace(/,/g, '')); if (!isNaN(n)) out.estimated_retail_price_usd = n; }
  return out;
}
// Fetch a URL's HTML with a browser UA and a 10s timeout.
async function fetchUrlHtml(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': SCRAPE_UA, 'Accept': 'text/html,application/xhtml+xml' }, redirect: 'follow', signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.text();
  } catch (e) { return null; }
  finally { clearTimeout(timer); }
}

const SYSTEM = "You are a product analyst. Look at this image carefully. It may contain one or multiple distinct products. For EACH product you can identify, extract: product_name, category (pick from: Personal Care, Hair Care, Skin Care, Home Care, Consumer Electronics, Pet, Baby, Food & Beverage, Other), short_description (1-2 sentences), estimated_retail_price_usd (number only, null if unknown), packaging_type (e.g. bottle, jar, tube, box, pouch, null if unknown), recommended_factory_type (1 sentence describing what kind of factory should make this — e.g. 'Food-grade snack manufacturer specializing in dried/freeze-dried products'). Return ONLY a valid JSON array of objects, even if there is only one product. No markdown, no backticks, no explanation.";

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: true, message: 'Method not allowed' });

  try {
    const token = (req.headers.authorization || req.headers.Authorization || '').replace('Bearer ', '').trim();
    const tid = await resolveTenantId(token);
    if (!tid) return res.status(401).json({ error: true, message: 'Unauthorized' });
    if (!ANTHROPIC_KEY) return res.status(200).json({ error: true, message: 'AI service temporarily unavailable.' });

    const body = await readBody(req);
    const url = (body.url || '').toString().trim();

    // ── URL path: scrape the page, then normalize the fields via Claude ──
    if (url && !body.image) {
      const html = await fetchUrlHtml(url);
      if (!html) return res.status(200).json({ error: true, message: 'Could not fetch URL' });
      const scraped = scrapeProduct(html);
      const promptText =
        'Product page URL: ' + url + '\n' +
        'Title: ' + (scraped.product_name || '(none found)') + '\n' +
        'Description: ' + (scraped.short_description || '(none found)') + '\n' +
        'Price seen on page: ' + (scraped.estimated_retail_price_usd != null ? '$' + scraped.estimated_retail_price_usd : '(none found)');
      let ur, ud;
      try {
        ur = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: MODEL, max_tokens: 600, system: URL_SYSTEM, messages: [{ role: 'user', content: promptText }] }),
        });
        ud = await ur.json().catch(() => ({}));
      } catch (e) { return res.status(200).json({ error: true, message: 'Could not fetch URL' }); }
      if (!ur.ok) return res.status(200).json({ error: true, message: (ud && ud.error && ud.error.message) || ('AI error ' + ur.status) });
      logCost(tid, 'rfq_extract_url', MODEL, ud.usage);
      const parsed = parseItems((ud.content && ud.content[0] && ud.content[0].text) || '');
      const fields = (parsed && parsed[0]) ? parsed[0] : {};
      // Merge the scrape's image_url (Claude doesn't return it).
      const item = Object.assign({}, fields, { image_url: scraped.image_url || null });
      return res.status(200).json({ items: [item], tenant_id: tid });
    }

    const image = body.image || '';
    const mediaType = body.mediaType || 'image/jpeg';
    if (!image) return res.status(400).json({ error: true, message: 'No image provided' });

    let r, d;
    try {
      r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL, max_tokens: 1200, system: SYSTEM,
          messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
            { type: 'text', text: 'List every distinct product in this image as a JSON array of objects.' },
          ] }],
        }),
      });
      d = await r.json().catch(() => ({}));
    } catch (e) { return res.status(200).json({ error: true, message: 'AI request failed' }); }

    if (!r.ok) return res.status(200).json({ error: true, message: (d && d.error && d.error.message) || ('AI error ' + r.status) });

    logCost(tid, 'rfq_extract', MODEL, d.usage);

    const items = parseItems((d.content && d.content[0] && d.content[0].text) || '');
    if (!items || !items.length) return res.status(200).json({ error: true, message: 'Could not parse AI response' });

    // Primary response shape: { items: [...] }. For backward compatibility with the older
    // single-object consumer (scanner.html), also spread the first item's fields at top level.
    const first = items[0] || {};
    return res.status(200).json(Object.assign({}, first, { items: items, tenant_id: tid }));
  } catch (e) {
    return res.status(200).json({ error: true, message: 'Extraction failed' });
  }
}
