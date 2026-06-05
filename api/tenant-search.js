// api/tenant-search.js
// Tenant AI toolbar — full-portal intelligence engine.
//  Step 1: claude-haiku classifies intent + extracts params + picks the relevant data_sources.
//  Step 2: ACTION intents return a navigation payload (no answer call); QUERY/COMPARISON intents
//          fetch ONLY the selected sources, build a labeled context, and answer with claude-sonnet.
// Auth: Bearer tenant session token. Never throws a 500 — every path returns JSON.
export const config = { runtime: 'nodejs' };

import { createHmac, timingSafeEqual } from 'crypto';

const SB_URL = process.env.SUPABASE_URL || 'https://mjkjubctswjwjihxjpnd.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const H = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' };
const INTENT_MODEL = 'claude-haiku-4-5-20251001';
const ANSWER_MODEL = 'claude-sonnet-4-6';

// Admin cross-access: a valid admin session token (same HMAC scheme as api/admin-auth.js)
// resolves to the Byline Brands tenant, so admins can use this AI search from admin.html.
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

async function sbGet(path) {
  try { const r = await fetch(SB_URL + '/rest/v1/' + path, { headers: H }); if (!r.ok) return []; const d = await r.json(); return Array.isArray(d) ? d : []; }
  catch { return []; }
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
function extractJson(text) { let c = (text || '').trim().replace(/```json|```/g, '').trim(); const s = c.indexOf('{'), e = c.lastIndexOf('}'); if (s === -1 || e === -1) throw new Error('no json'); return JSON.parse(c.substring(s, e + 1)); }
async function claude(model, maxTokens, system, userMsg) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: userMsg }] }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('anthropic ' + r.status);
  return { text: (d.content && d.content[0] && d.content[0].text) || '', usage: d.usage || {} };
}
function logCost(tid, feature, model, usage) {
  const tin = (usage && usage.input_tokens) || 0, tout = (usage && usage.output_tokens) || 0;
  const haiku = /haiku/i.test(model);
  const costUsd = haiku ? (tin / 1e6) * 0.8 + (tout / 1e6) * 4 : (tin / 1e6) * 3 + (tout / 1e6) * 15;
  fetch(SB_URL + '/rest/v1/api_cost_log', { method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
    body: JSON.stringify({ tenant_id: tid, service: 'anthropic', feature, model, tokens_in: tin, tokens_out: tout, cost_usd: costUsd, cost_usd_marked_up: costUsd * 1.5, prompt_summary: feature }) }).catch(() => {});
}
function navUrl(dest) {
  const d = (dest || '').toLowerCase();
  const map = [
    [/dashboard|home|overview/, 'tenant-dashboard.html'], [/financ|invoice|payment/, 'tenant-financials.html'],
    [/inspection/, 'tenant-operations.html#inspections'], [/cert/, 'tenant-operations.html#certifications'],
    [/artwork|design|creative/, 'tenant-operations.html#artwork'], [/action|to.?do|task/, 'tenant-operations.html#actions'],
    [/credit/, 'tenant-operations.html#credit'], [/forecast/, 'tenant-operations.html#forecasting'],
    [/order|production|po\b/, 'tenant-operations.html#orders'], [/audit/, 'tenant-factories.html#audits'],
    [/factor/, 'tenant-factories.html'], [/rfq|quote/, 'tenant-rfq.html#rfq'],
    [/product.?dev|\bpd\b|sample/, 'tenant-rfq.html#pd'], [/sku|catalog|product/, 'tenant-rfq.html#skus'],
    [/comms|message|email|inbox/, 'tenant-communications.html'], [/intel|trend|news/, 'tenant-intel.html'],
  ];
  for (const [re, url] of map) if (re.test(d)) return url;
  return 'tenant-dashboard.html';
}

const PRICING_GUIDE = "When answering pricing questions: use RFQ Quote History if available (these are factory-submitted quotes). If only Purchase Order Price History is available, use those prices — they represent actual contracted FOB prices. If all POs are from the same factory, note that cross-factory comparison isn't possible and show the price range across product variants instead. Always state the source of the data (quoted price vs contracted PO price).";

async function buildPricingContext(etid, params) {
  const cat = (params.category || '').trim().toLowerCase(), prod = (params.product || '').trim().toLowerCase();
  let quotes = await sbGet('rfq_quotes?select=unit_fob_price,moq,production_lead_time_days,score_overall_v2,status,factories(factory_name_english),rfqs!inner(item_description,category,tenant_id)&rfqs.tenant_id=eq.' + etid + '&order=created_at.desc&limit=80');
  if (cat || prod) { const m = quotes.filter(q => { const it = ((q.rfqs && q.rfqs.item_description) || '').toLowerCase(), c = ((q.rfqs && q.rfqs.category) || '').toLowerCase(); return (prod && it.includes(prod)) || (cat && c.includes(cat)); }); if (m.length) quotes = m; }
  let pos = await sbGet('purchase_orders?tenant_id=eq.' + etid + '&select=po_number,description_snapshot,factory_name_snapshot,unit_fob_price,quantity,status&order=created_at.desc&limit=80');
  if (cat || prod) { const m = pos.filter(p => { const d = ((p.description_snapshot) || '').toLowerCase(); return (prod && d.includes(prod)) || (cat && d.includes(cat)); }); if (m.length) pos = m; }
  if (quotes.length) return { text: 'RFQ Quote History: ' + JSON.stringify(quotes.map(q => ({ factory: (q.factories && q.factories.factory_name_english) || '—', product: q.rfqs && q.rfqs.item_description, unit_fob_price: q.unit_fob_price, moq: q.moq, lead_time: q.production_lead_time_days, score: q.score_overall_v2 }))), sources: ['rfq_quotes'] };
  if (pos.length) return { text: 'Purchase Order Price History (no factory quotes on file — using issued PO prices): ' + JSON.stringify(pos.map(p => ({ po_number: p.po_number, description_snapshot: p.description_snapshot, factory_name_snapshot: p.factory_name_snapshot, unit_fob_price: p.unit_fob_price, quantity: p.quantity, status: p.status }))), sources: ['purchase_orders'] };
  return { text: 'No pricing data available for this tenant.', sources: [] };
}

// ── Intent classifier ──
const INTENT_SYSTEM = `You are an intent classifier for a B2B consumer-goods sourcing portal. Return ONLY valid JSON, nothing else.

INTENTS:
ACTION (user wants to DO something): create_rfq, create_po, new_artwork, navigate
QUERY (answer in text): ap_balance, ar_balance, open_orders, sku_status, action_items, inspection_status, compliance_alerts, hts_lookup, factory_intel, shop_out_intel, retailer_intel, brand_watch, fx_rates, artwork_status, pd_status, general_query
COMPARISON (AI analysis across records): quote_comparison, factory_comparison

Intent hints:
- hts_lookup: HTS codes, duty rates, tariff info ("what hts code", "what duty rate", "tariff for")
- factory_intel: factory details/certs/scores/audits ("which factories have BSCI", "factory scorecard", "best factory for")
- shop_out_intel: competitor shelf prices / what's on shelf ("what are competitors selling", "what's at walmart", "shelf price", "spotted at")
- retailer_intel: retailer news / SEC filings / strategy ("walmart filing", "target news", "retailer intel")
- brand_watch: competitor brand tracking ("brand watch", "competitor brand", "who makes", "competing products")
- fx_rates: exchange rates ("exchange rate", "usd cny", "rmb", "currency rate")
- artwork_status: artwork/design/packaging projects
- pd_status: product development / samples ("sample", "golden sample", "product development", "PD-")
- quote_comparison: compare quotes/prices OR any historical pricing question ("lowest price we paid for X", "what do our serums cost")

DATA SOURCE KEYS you may include in data_sources (pick only what's needed):
purchase_orders, po_milestones, rfqs, rfq_quotes, factories, factory_certs, factory_scores, factory_audits, inspections, skus, action_items, artwork_projects, product_development, shop_out_intel, retailer_news, retailer_filings, brand_watch, fx_rates, compliance_reqs

Return JSON only:
{
  "intent": "<one intent>",
  "params": { "product": "", "category": "", "quantity": null, "target_cost": null, "retailer": "", "factory": "", "destination": "" },
  "data_sources": ["<source keys>"]
}`;

const SOURCE_DEFAULTS = {
  hts_lookup: ['rfqs', 'rfq_quotes'],
  factory_intel: ['factories', 'factory_certs', 'factory_scores', 'factory_audits'],
  shop_out_intel: ['shop_out_intel'],
  retailer_intel: ['retailer_news', 'retailer_filings'],
  brand_watch: ['brand_watch'],
  fx_rates: ['fx_rates'],
  artwork_status: ['artwork_projects'],
  pd_status: ['product_development'],
  ap_balance: ['purchase_orders'],
  open_orders: ['purchase_orders', 'po_milestones'],
  sku_status: ['skus'],
  action_items: ['action_items'],
  inspection_status: ['inspections'],
  compliance_alerts: ['factory_certs'],
  quote_comparison: ['rfq_quotes', 'rfqs', 'purchase_orders', 'factory_scores'],
  factory_comparison: ['factories', 'factory_certs', 'factory_scores'],
  general_query: ['purchase_orders', 'skus', 'action_items', 'rfqs'],
};
const KNOWN_SOURCES = new Set(['purchase_orders', 'po_milestones', 'rfqs', 'rfq_quotes', 'factories', 'factory_certs', 'factory_scores', 'factory_audits', 'inspections', 'skus', 'action_items', 'artwork_projects', 'product_development', 'shop_out_intel', 'retailer_news', 'retailer_filings', 'brand_watch', 'fx_rates', 'compliance_reqs']);

// ── Data source registry → labeled context sections ──
async function fetchSources(srcSet, etid, params) {
  const want = k => srcSet.has(k);
  const sections = [], used = [];
  const m = v => v == null ? '—' : '$' + Number(v).toFixed(2);
  const d = v => v ? String(v).slice(0, 10) : '—';
  const arr = v => Array.isArray(v) ? v.join(', ') : (v || '');
  const add = (key, title, rows, fmt) => { if (rows && rows.length) { sections.push('=== ' + title + ' ===\n' + rows.map(fmt).join('\n')); used.push(key); } };

  let pos = null;
  if (want('purchase_orders') || want('po_milestones')) {
    pos = await sbGet('purchase_orders?tenant_id=eq.' + etid + '&status=not.in.(cancelled,closed)&select=id,po_number,status,unit_fob_price,quantity,description_snapshot,factory_name_snapshot,expected_ship_date&order=created_at.desc&limit=20');
    if (want('purchase_orders')) add('purchase_orders', 'PURCHASE ORDERS', pos, p => `${p.po_number || '—'} | ${p.status || '—'} | ${p.description_snapshot || '—'} | ${p.factory_name_snapshot || '—'} | FOB ${m(p.unit_fob_price)} | qty ${p.quantity != null ? p.quantity : '—'} | ship ${d(p.expected_ship_date)}`);
  }
  if (want('po_milestones') && pos && pos.length) {
    const ids = pos.map(p => p.id), poNum = {}; pos.forEach(p => poNum[p.id] = p.po_number);
    const ms = await sbGet('po_milestones?purchase_order_id=in.(' + ids.join(',') + ')&select=purchase_order_id,milestone_type,status,agreed_date,completed_at&order=display_order.asc');
    add('po_milestones', 'PO MILESTONES', ms, x => `${poNum[x.purchase_order_id] || 'PO'} | ${x.milestone_type || '—'} | ${x.status || '—'} | agreed ${d(x.agreed_date)}${x.completed_at ? ' | done ' + d(x.completed_at) : ''}`);
  }
  if (want('rfqs')) {
    const r = await sbGet('rfqs?tenant_id=eq.' + etid + '&select=project_number,item_description,category,status,est_hts_code,est_duty_pct,est_tariff_pct,max_fob_price,quote_quantity,sent_at,factories_to_send&order=created_at.desc&limit=20');
    add('rfqs', 'RFQs', r, x => `${x.project_number || '—'} | ${x.item_description || '—'} | ${x.category || '—'} | ${x.status || '—'} | HTS ${x.est_hts_code || '—'} | duty ${x.est_duty_pct != null ? x.est_duty_pct + '%' : '—'} | tariff ${x.est_tariff_pct != null ? x.est_tariff_pct + '%' : '—'} | maxFOB ${m(x.max_fob_price)} | qty ${x.quote_quantity != null ? x.quote_quantity : '—'}`);
  }
  if (want('rfq_quotes')) {
    const q = await sbGet('rfq_quotes?select=unit_fob_price,moq,production_lead_time_days,score_overall_v2,hts_code_verified,hts_ai_estimate,duty_rate_estimated,tariff_rate_estimated,compliance_status,factories(factory_name_english),rfqs!inner(item_description,category,tenant_id)&rfqs.tenant_id=eq.' + etid + '&order=created_at.desc&limit=60');
    add('rfq_quotes', 'RFQ QUOTES', q, x => `${(x.factories && x.factories.factory_name_english) || '—'} | ${(x.rfqs && x.rfqs.item_description) || '—'} | FOB ${m(x.unit_fob_price)} | MOQ ${x.moq != null ? x.moq : '—'} | lead ${x.production_lead_time_days != null ? x.production_lead_time_days + 'd' : '—'} | score ${x.score_overall_v2 != null ? x.score_overall_v2 : '—'} | HTS ${x.hts_code_verified || x.hts_ai_estimate || '—'} | duty ${x.duty_rate_estimated != null ? x.duty_rate_estimated + '%' : '—'} | ${x.compliance_status || ''}`);
  }
  let facs = null;
  if (want('factories')) {
    facs = await sbGet('factories?tenant_id=eq.' + etid + '&select=id,factory_name_english,city,country,certifications,product_categories,status,years_in_business,annual_revenue_usd&order=factory_name_english.asc&limit=40');
    add('factories', 'FACTORIES', facs, f => `${f.factory_name_english || '—'} | ${[f.city, f.country].filter(Boolean).join(', ') || '—'} | ${arr(f.certifications) || '—'} | ${arr(f.product_categories) || '—'}${f.years_in_business ? ' | ' + f.years_in_business + 'yrs' : ''}`);
  }
  if (want('factory_certs')) {
    const c = await sbGet('factory_certifications?tenant_id=eq.' + etid + '&select=certification_name,status,expiry_date,certificate_number,factories(factory_name_english)&order=expiry_date.asc&limit=50');
    add('factory_certs', 'FACTORY CERTIFICATIONS', c, x => `${(x.factories && x.factories.factory_name_english) || '—'} | ${x.certification_name || '—'} | ${x.status || '—'} | expires ${d(x.expiry_date)}${x.certificate_number ? ' | #' + x.certificate_number : ''}`);
  }
  if (want('factory_scores')) {
    let fids = facs ? facs.map(f => f.id) : (await sbGet('factories?tenant_id=eq.' + etid + '&select=id&limit=200')).map(f => f.id);
    if (fids.length) {
      const s = await sbGet('factory_performance_scores?factory_id=in.(' + fids.join(',') + ')&select=factory_id,composite_score,tier,responsiveness_score,quote_quality_score,sample_performance_score,production_reliability_score,compliance_hygiene_score,factories(factory_name_english)&limit=60');
      add('factory_scores', 'FACTORY SCORES', s, x => `${(x.factories && x.factories.factory_name_english) || x.factory_id} | composite ${x.composite_score != null ? x.composite_score : '—'} | tier ${x.tier || '—'} | responsiveness ${x.responsiveness_score != null ? x.responsiveness_score : '—'} | quote ${x.quote_quality_score != null ? x.quote_quality_score : '—'} | reliability ${x.production_reliability_score != null ? x.production_reliability_score : '—'} | compliance ${x.compliance_hygiene_score != null ? x.compliance_hygiene_score : '—'}`);
    }
  }
  if (want('factory_audits')) {
    const a = await sbGet('factory_audits?tenant_id=eq.' + etid + '&select=status,scheduled_date,conducted_date,overall_score,color_rating,inspector_company,factories(factory_name_english),factory_audit_types(name)&order=scheduled_date.desc&limit=10');
    add('factory_audits', 'FACTORY AUDITS', a, x => `${(x.factories && x.factories.factory_name_english) || '—'} | ${(x.factory_audit_types && x.factory_audit_types.name) || '—'} | ${x.status || '—'} | ${x.color_rating || '—'} | score ${x.overall_score != null ? x.overall_score : '—'} | scheduled ${d(x.scheduled_date)}${x.conducted_date ? ' | conducted ' + d(x.conducted_date) : ''} | ${x.inspector_company || ''}`);
  }
  if (want('inspections')) {
    const i = await sbGet('inspections?tenant_id=eq.' + etid + '&select=status,inspection_type,scheduled_date,outcome,aql_level,sample_size,inspector_company,factories(factory_name_english),purchase_orders(po_number)&order=scheduled_date.desc&limit=10');
    add('inspections', 'INSPECTIONS', i, x => `${(x.purchase_orders && x.purchase_orders.po_number) || '—'} | ${(x.factories && x.factories.factory_name_english) || '—'} | ${x.inspection_type || '—'} | ${x.status || '—'}${x.outcome ? ' | ' + x.outcome : ''} | AQL ${x.aql_level != null ? x.aql_level : '—'} | scheduled ${d(x.scheduled_date)}`);
  }
  if (want('skus')) {
    const s = await sbGet('skus?tenant_id=eq.' + etid + '&select=model_number,description,status,upc_code,packaging_primary,packaging_primary_material&order=created_at.desc&limit=30');
    add('skus', 'SKUs', s, x => `${x.model_number || '—'} | ${x.description || '—'} | ${x.status || '—'} | UPC ${x.upc_code || '—'} | pkg ${[x.packaging_primary, x.packaging_primary_material].filter(Boolean).join(' / ') || '—'}`);
  }
  if (want('action_items')) {
    const a = await sbGet('tenant_action_items?tenant_id=eq.' + etid + '&status=in.(open,acknowledged)&select=type,priority,title,description,due_date,created_at&order=priority.asc,due_date.asc&limit=20');
    add('action_items', 'ACTION ITEMS', a, x => `[${x.priority || '—'}] ${x.title || '—'} | ${x.type || ''} | due ${d(x.due_date)}`);
  }
  if (want('artwork_projects')) {
    const a = await sbGet('artwork_projects?tenant_id=eq.' + etid + '&select=product_name,status,due_date,artwork_types,factory_approved_by,factory_approved_at,skus(model_number)&order=created_at.desc&limit=30');
    add('artwork_projects', 'ARTWORK PROJECTS', a, x => `${x.product_name || '—'} | ${(x.skus && x.skus.model_number) || ''} | ${x.status || '—'} | due ${d(x.due_date)} | types ${arr(x.artwork_types) || '—'}${x.factory_approved_by ? ' | factory approved by ' + x.factory_approved_by : ''}`);
  }
  if (want('product_development')) {
    const p = await sbGet('product_development?tenant_id=eq.' + etid + '&select=pd_number,item_description,category,status,sku_lifecycle_status&order=created_at.desc&limit=30');
    add('product_development', 'PRODUCT DEVELOPMENT', p, x => `${x.pd_number || '—'} | ${x.item_description || '—'} | ${x.category || '—'} | ${x.status || x.sku_lifecycle_status || '—'}`);
  }
  if (want('shop_out_intel')) {
    let path = 'shop_out_observations?tenant_id=eq.' + etid + '&select=brand,product_name,retail_price,unit_price,country_of_origin,category_id,shop_outs(shop_date,store_location_text,customer_id)&order=created_at.desc&limit=30';
    if (params.product) path += '&product_name=ilike.' + encodeURIComponent('%' + params.product + '%');
    const o = await sbGet(path);
    add('shop_out_intel', 'SHOP-OUT INTELLIGENCE (competitor shelf data)', o, x => `Brand: ${x.brand || '—'} | Product: ${x.product_name || '—'} | Price: ${m(x.retail_price)}${x.unit_price ? ' (unit ' + m(x.unit_price) + ')' : ''} | Origin: ${x.country_of_origin || '—'} | Date: ${(x.shop_outs && x.shop_outs.shop_date) ? d(x.shop_outs.shop_date) : '—'} | Location: ${(x.shop_outs && x.shop_outs.store_location_text) || '—'}`);
  }
  if (want('retailer_news')) {
    let n = await sbGet('retailer_news?tenant_id=eq.' + etid + '&select=ingested_at,news_articles(headline,snippet,ai_highlight,published_at),retailers(name)&order=ingested_at.desc&limit=30');
    if (params.retailer) { const rt = params.retailer.toLowerCase(); const f = n.filter(x => ((x.retailers && x.retailers.name) || '').toLowerCase().includes(rt)); if (f.length) n = f; }
    add('retailer_news', 'RETAILER NEWS', n.slice(0, 15), x => `${(x.retailers && x.retailers.name) || '—'} | ${(x.news_articles && x.news_articles.headline) || '—'} | ${(x.news_articles && (x.news_articles.ai_highlight || x.news_articles.snippet)) || ''} | ${(x.news_articles && x.news_articles.published_at) ? d(x.news_articles.published_at) : ''}`);
  }
  if (want('retailer_filings')) {
    let fl = await sbGet('retailer_filings?select=form_type,filing_date,ai_summary,ai_extracted_signals,retailers(name)&order=filing_date.desc&limit=20');
    if (params.retailer) { const rt = params.retailer.toLowerCase(); const f = fl.filter(x => ((x.retailers && x.retailers.name) || '').toLowerCase().includes(rt)); if (f.length) fl = f; }
    add('retailer_filings', 'RETAILER FILINGS', fl.slice(0, 5), x => `${(x.retailers && x.retailers.name) || '—'} | ${x.form_type || '—'} | ${d(x.filing_date)} | ${(x.ai_summary || '').slice(0, 220)}`);
  }
  if (want('brand_watch')) {
    const runs = await sbGet('brand_watch_runs?tenant_id=eq.' + etid + '&select=id&order=started_at.desc&limit=20');
    const rids = runs.map(r => r.id);
    if (rids.length) {
      const bp = await sbGet('brand_watch_products?run_id=in.(' + rids.join(',') + ')&select=product_title,vendor,product_type,price_current_cents,currency,in_stock,observed_at&order=observed_at.desc&limit=20');
      add('brand_watch', 'BRAND WATCH (competitor products)', bp, x => `${x.product_title || '—'} | vendor ${x.vendor || '—'}${x.product_type ? ' | ' + x.product_type : ''} | ${x.price_current_cents != null ? '$' + (x.price_current_cents / 100).toFixed(2) : '—'} | ${x.in_stock ? 'in stock' : 'out of stock'}`);
    }
  }
  if (want('fx_rates')) {
    const fx = await sbGet('fx_rates?pair=eq.' + encodeURIComponent('USD/CNY') + '&order=rate_date.desc&limit=7');
    add('fx_rates', 'FX RATES', fx, x => `${x.pair}: ${x.rate} (${d(x.rate_date)})`);
  }
  if (want('compliance_reqs')) {
    let path = 'compliance_requirements?select=category,required_factory_certs,preferred_factory_certs,required_product_docs,preferred_product_docs&limit=40';
    if (params.category) path = 'compliance_requirements?category=ilike.' + encodeURIComponent('%' + params.category + '%') + '&select=category,required_factory_certs,preferred_factory_certs,required_product_docs,preferred_product_docs&limit=20';
    const cr = await sbGet(path);
    add('compliance_reqs', 'COMPLIANCE REQUIREMENTS', cr, x => `${x.category || '—'} | required certs: ${arr(x.required_factory_certs) || '—'} | required docs: ${arr(x.required_product_docs) || '—'}`);
  }

  // Pitch & positioning — global TBG data (not tenant-scoped). Always included so the AI can
  // speak to TBG's value proposition, competitive positioning, and demo queries regardless of
  // which tenant data sources the query selected.
  {
    const pitch = await sbGet('pitch_items?select=id,category,headline,detail,demo_query,demo_result,competitive_context&limit=50');
    add('pitch_items', 'Pitch & Positioning Data', pitch, x => `[${x.category || '—'}] ${x.headline || '—'} | ${x.detail || '—'}${x.demo_query ? ' | demo Q: ' + x.demo_query : ''}${x.demo_result ? ' | demo result: ' + x.demo_result : ''}${x.competitive_context ? ' | vs competitors: ' + x.competitive_context : ''}`);
  }

  return { text: sections.join('\n\n'), sources: used };
}

const ANSWER_SYSTEM = (context) => `You are the AI assistant for a B2B consumer goods sourcing portal. You have access to the following portal data for this tenant:

${context || '(no data returned for the requested sources)'}

Answer the user's question using ONLY the data provided above. Be specific — cite PO numbers, factory names, prices, dates. If data for a specific question isn't in the context, say what data IS available and suggest what to check.

For pricing questions: state whether prices are from RFQ quotes (factory-submitted) or PO records (contracted prices).
For factory questions: reference certifications, scores, and audit results when available.
For competitor intel: reference the shop-out date and retailer location.
For HTS/duty questions: pull from rfqs.est_hts_code and rfq_quotes.hts_code_verified.
For FX questions: state the date of the rate.
Format responses clearly — use markdown tables for comparisons, bullet points for lists.`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth
  const token = (req.headers.authorization || req.headers.Authorization || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  // A valid admin session token resolves to the Byline Brands tenant; otherwise require a
  // valid tenant session. (Admin tokens are HMAC payload.sig and won't match a tenant session.)
  let tid = null;
  if (verifyAdminToken(token)) {
    tid = ADMIN_TENANT_ID;
  } else {
    let session = null;
    try { const r = await fetch(SB_URL + '/rest/v1/tenant_sessions?select=tenant_id,expires_at&token=eq.' + encodeURIComponent(token) + '&limit=1', { headers: H }); const arr = r.ok ? await r.json() : []; session = Array.isArray(arr) ? arr[0] : null; } catch { session = null; }
    if (!session || new Date(session.expires_at) < new Date()) return res.status(401).json({ error: 'Invalid session' });
    tid = session.tenant_id;
  }
  const etid = encodeURIComponent(tid);
  const body = await readBody(req);
  const query = (body.query || '').toString().trim();
  if (!query) return res.status(400).json({ error: 'Query required' });
  if (!ANTHROPIC_KEY) return res.status(200).json({ mode: 'query', answer: 'AI service temporarily unavailable. Please try again.', sources: [] });

  try {
    // Step 1: classify
    let intent = 'general_query', params = {}, dataSources = null;
    try {
      const cls = await claude(INTENT_MODEL, 120, INTENT_SYSTEM, query);
      logCost(tid, 'tenant_search_intent', INTENT_MODEL, cls.usage);
      const p = extractJson(cls.text);
      if (p && p.intent) { intent = p.intent; params = p.params || {}; if (Array.isArray(p.data_sources)) dataSources = p.data_sources.filter(s => KNOWN_SOURCES.has(s)); }
    } catch (e) { intent = 'general_query'; params = {}; }

    // ACTION intents — return immediately
    if (intent === 'create_rfq' || intent === 'create_po' || intent === 'new_artwork' || intent === 'navigate') {
      let url, message;
      if (intent === 'create_rfq') { url = 'tenant-rfq.html#rfq'; message = 'Opening RFQ setup' + (params.product ? ' for ' + params.product : '') + '…'; }
      else if (intent === 'create_po') { url = 'tenant-operations.html#orders'; message = 'Opening purchase orders' + (params.product ? ' for ' + params.product : '') + '…'; }
      else if (intent === 'new_artwork') { url = 'tenant-operations.html#artwork'; message = 'Opening a new artwork project' + (params.product ? ' for ' + params.product : '') + '…'; }
      else { url = navUrl(params.destination || query); message = 'Navigating…'; }
      return res.status(200).json({ mode: 'action', action: intent, params, url, message });
    }

    // AR balance special-case (no registry source).
    if (intent === 'ar_balance') {
      const co = await sbGet('customer_orders?tenant_id=eq.' + etid + '&select=*&limit=50');
      if (!co.length) return res.status(200).json({ mode: 'query', answer: 'No AR data on file.', sources: [] });
      const out = await claude(ANSWER_MODEL, 500, ANSWER_SYSTEM('=== CUSTOMER ORDERS ===\n' + JSON.stringify(co)), query);
      logCost(tid, 'tenant_search_ar_balance', ANSWER_MODEL, out.usage);
      return res.status(200).json({ mode: 'query', answer: out.text || 'No answer returned.', sources: ['customer_orders'] });
    }

    const isComparison = intent === 'quote_comparison' || intent === 'factory_comparison';

    // Select sources: classifier's pick → intent defaults → general fallback.
    let chosen = (dataSources && dataSources.length) ? dataSources : (SOURCE_DEFAULTS[intent] || SOURCE_DEFAULTS.general_query);
    const srcSet = new Set(chosen);

    let ctx = '';
    let sources = [];
    try {
      const fetched = await fetchSources(srcSet, etid, params);
      ctx = fetched.text; sources = fetched.sources;
    } catch (e) { ctx = ''; sources = []; }

    // Pricing fallback for quote_comparison — guarantees prices even when rfq_quotes are empty.
    if (intent === 'quote_comparison') {
      try {
        const pc = await buildPricingContext(etid, params);
        if (pc.text) { ctx = (ctx ? ctx + '\n\n' : '') + '=== PRICING SUMMARY ===\n' + pc.text; pc.sources.forEach(s => { if (!sources.includes(s)) sources.push(s); }); }
      } catch (e) {}
    }

    let answer = '';
    try {
      const out = await claude(ANSWER_MODEL, isComparison ? 800 : 500, ANSWER_SYSTEM(ctx), query);
      logCost(tid, 'tenant_search_' + intent, ANSWER_MODEL, out.usage);
      answer = out.text || 'No answer returned.';
    } catch (e) { answer = 'Could not retrieve an answer right now. Please try again.'; }

    return res.status(200).json({ mode: isComparison ? 'comparison' : 'query', answer, sources });
  } catch (err) {
    console.error('tenant-search error:', err);
    return res.status(200).json({ mode: 'query', answer: 'Something went wrong. Please try again.', sources: [] });
  }
}
