// api/tenant-search.js
// Tenant AI toolbar — a three-mode intent engine (action / query / comparison).
// POST { query }  — tenant_id is derived from the validated session token, never trusted from the body.
// Auth: Authorization: Bearer <tenant session token>.
//
// Never throws a 500: every failure path returns JSON.
export const config = { runtime: 'nodejs' };

const SB_URL = process.env.SUPABASE_URL || 'https://mjkjubctswjwjihxjpnd.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const H = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' };
const INTENT_MODEL = 'claude-haiku-4-5-20251001';
const ANSWER_MODEL = 'claude-sonnet-4-6';

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
function extractJson(text) {
  let c = (text || '').trim().replace(/```json|```/g, '').trim();
  const s = c.indexOf('{'), e = c.lastIndexOf('}');
  if (s === -1 || e === -1) throw new Error('no json');
  return JSON.parse(c.substring(s, e + 1));
}
async function claude(model, maxTokens, system, userMsg) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: userMsg }] }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('anthropic ' + r.status);
  return { text: (d.content && d.content[0] && d.content[0].text) || '', usage: d.usage || {} };
}
function logCost(tid, feature, model, usage) {
  const tin = (usage && usage.input_tokens) || 0, tout = (usage && usage.output_tokens) || 0;
  const isHaiku = /haiku/i.test(model);
  const costUsd = isHaiku ? (tin / 1e6) * 0.8 + (tout / 1e6) * 4 : (tin / 1e6) * 3 + (tout / 1e6) * 15;
  fetch(SB_URL + '/rest/v1/api_cost_log', {
    method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
    body: JSON.stringify({ tenant_id: tid, service: 'anthropic', feature, model, tokens_in: tin, tokens_out: tout, cost_usd: costUsd, cost_usd_marked_up: costUsd * 1.5, prompt_summary: feature }),
  }).catch(() => {});
}

const INTENT_SYSTEM = `You are an intent classifier for a B2B sourcing portal. Classify the user query into exactly one of these intents and return ONLY valid JSON, nothing else:

ACTION intents (user wants to DO something):
- create_rfq: creating/starting a new RFQ or quote request
- create_po: creating/issuing a purchase order
- new_artwork: starting a new artwork project
- navigate: go to a specific page or section

QUERY intents (user wants DATA answered in text):
- ap_balance: what we owe vendors/factories
- ar_balance: what customers owe us
- open_orders: status of purchase orders / production
- sku_status: SKU library, active products
- action_items: pending actions, to-do items
- inspection_status: upcoming or recent inspections
- compliance_alerts: cert expiry, compliance issues
- general_query: any other question about their data

COMPARISON intents (user wants AI ANALYSIS across multiple records):
- quote_comparison: compare factories/quotes on price, quality, lead time for a product or category, OR any pricing question over historical quote data (e.g. "what was the lowest price we paid for X", "what do our serums cost", "cheapest quote for facial cleanser", "price range for candles")
- factory_comparison: compare factories on capabilities, certs, scores

Return JSON only:
{
  "intent": "<one of the above>",
  "params": {
    "product": "<extracted product name if mentioned>",
    "category": "<extracted category if mentioned>",
    "quantity": <number or null>,
    "target_cost": <number or null>,
    "destination": "<page/tab name if navigate intent>"
  }
}`;

// Map a free-text destination to the closest tenant URL.
function navUrl(dest) {
  const d = (dest || '').toLowerCase();
  const map = [
    [/dashboard|home|overview/, 'tenant-dashboard.html'],
    [/financ|invoice|payment|cost/, 'tenant-financials.html'],
    [/inspection/, 'tenant-operations.html#inspections'],
    [/cert/, 'tenant-operations.html#certifications'],
    [/artwork|design|creative/, 'tenant-operations.html#artwork'],
    [/action|to.?do|task/, 'tenant-operations.html#actions'],
    [/credit/, 'tenant-operations.html#credit'],
    [/forecast/, 'tenant-operations.html#forecasting'],
    [/order|production|po\b/, 'tenant-operations.html#orders'],
    [/audit/, 'tenant-factories.html#audits'],
    [/factor/, 'tenant-factories.html'],
    [/rfq|quote/, 'tenant-rfq.html#rfq'],
    [/product.?dev|\bpd\b|sample/, 'tenant-rfq.html#pd'],
    [/sku|catalog|product/, 'tenant-rfq.html#skus'],
    [/comms|message|email|inbox/, 'tenant-communications.html'],
    [/intel|trend|news/, 'tenant-intel.html'],
  ];
  for (const [re, url] of map) if (re.test(d)) return url;
  return 'tenant-dashboard.html';
}

const PRICING_GUIDE = "When answering pricing questions: use RFQ Quote History if available (these are factory-submitted quotes). If only Purchase Order Price History is available, use those prices — they represent actual contracted FOB prices. If all POs are from the same factory, note that cross-factory comparison isn't possible and show the price range across product variants instead. Always state the source of the data (quoted price vs contracted PO price).";

// Pull BOTH rfq_quotes and purchase_orders (tenant-scoped), filter by product/category when given,
// and return a context string preferring quotes, falling back to PO prices.
async function buildPricingContext(etid, params) {
  const cat = (params.category || '').trim().toLowerCase();
  const prod = (params.product || '').trim().toLowerCase();
  let quotes = await sbGet('rfq_quotes?select=unit_fob_price,moq,production_lead_time_days,score_overall_v2,status,factories(factory_name_english),rfqs!inner(item_description,category,tenant_id)&rfqs.tenant_id=eq.' + etid + '&order=created_at.desc&limit=80');
  if (cat || prod) {
    const m = quotes.filter(q => { const it = ((q.rfqs && q.rfqs.item_description) || '').toLowerCase(), c = ((q.rfqs && q.rfqs.category) || '').toLowerCase(); return (prod && it.includes(prod)) || (cat && c.includes(cat)); });
    if (m.length) quotes = m;
  }
  let pos = await sbGet('purchase_orders?tenant_id=eq.' + etid + '&select=po_number,description_snapshot,factory_name_snapshot,unit_fob_price,quantity,status&order=created_at.desc&limit=80');
  if (cat || prod) {
    const m = pos.filter(p => { const d = ((p.description_snapshot) || '').toLowerCase(); return (prod && d.includes(prod)) || (cat && d.includes(cat)); });
    if (m.length) pos = m;
  }
  const sources = [];
  let text;
  if (quotes.length) {
    sources.push('rfq_quotes');
    text = 'RFQ Quote History: ' + JSON.stringify(quotes.map(q => ({ factory: (q.factories && q.factories.factory_name_english) || '—', product: q.rfqs && q.rfqs.item_description, unit_fob_price: q.unit_fob_price, moq: q.moq, lead_time: q.production_lead_time_days, score: q.score_overall_v2 })));
  } else if (pos.length) {
    sources.push('purchase_orders');
    text = 'Purchase Order Price History (no factory quotes on file — using issued PO prices): ' + JSON.stringify(pos.map(p => ({ po_number: p.po_number, description_snapshot: p.description_snapshot, factory_name_snapshot: p.factory_name_snapshot, unit_fob_price: p.unit_fob_price, quantity: p.quantity, status: p.status })));
  } else {
    text = 'No pricing data available for this tenant.';
  }
  return { text, sources, hasData: quotes.length > 0 || pos.length > 0 };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Validate session ──
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
  const etid = encodeURIComponent(tid);
  const body = await readBody(req);
  const query = (body.query || '').toString().trim();
  if (!query) return res.status(400).json({ error: 'Query required' });
  if (!ANTHROPIC_KEY) return res.status(200).json({ mode: 'query', answer: 'AI service temporarily unavailable. Please try again.', sources: [] });

  try {
    // ── STEP 1: classify intent (fast, cheap) ──
    let intent = 'general_query', params = {};
    try {
      const cls = await claude(INTENT_MODEL, 80, INTENT_SYSTEM, query);
      logCost(tid, 'tenant_search_intent', INTENT_MODEL, cls.usage);
      const parsed = extractJson(cls.text);
      if (parsed && parsed.intent) { intent = parsed.intent; params = parsed.params || {}; }
    } catch (e) { intent = 'general_query'; params = {}; }

    const ACTIONS = { create_rfq: 1, create_po: 1, new_artwork: 1, navigate: 1 };

    // ── ACTION intents — return immediately, no data/answer call ──
    if (ACTIONS[intent]) {
      let url, message;
      if (intent === 'create_rfq') { url = 'tenant-rfq.html#rfq'; message = 'Opening RFQ setup' + (params.product ? ' for ' + params.product : '') + '…'; }
      else if (intent === 'create_po') { url = 'tenant-operations.html#orders'; message = 'Opening purchase orders' + (params.product ? ' for ' + params.product : '') + '…'; }
      else if (intent === 'new_artwork') { url = 'tenant-operations.html#artwork'; message = 'Opening a new artwork project' + (params.product ? ' for ' + params.product : '') + '…'; }
      else { url = navUrl(params.destination || query); message = 'Navigating…'; }
      return res.status(200).json({ mode: 'action', action: intent, params, url, message });
    }

    // ── COMPARISON intents ──
    if (intent === 'quote_comparison' || intent === 'factory_comparison') {
      let answer = '', sources = [];
      try {
        if (intent === 'quote_comparison') {
          const pc = await buildPricingContext(etid, params);
          sources = pc.sources.length ? pc.sources : ['rfq_quotes', 'purchase_orders'];
          const sys = PRICING_GUIDE + '\n\nYou are a sourcing analyst. Using the pricing data below, produce a MARKDOWN TABLE ranked best-first (weigh unit price, quality score, and lead time where available), then 2-3 plain-English sentences with a recommendation. State whether the prices are quoted prices or contracted PO prices. If no pricing data exists, say so briefly.\n\n' + pc.text;
          const out = await claude(ANSWER_MODEL, 800, sys, query);
          logCost(tid, 'tenant_search_quote_comparison', ANSWER_MODEL, out.usage);
          answer = out.text || 'No pricing data available to compare.';
        } else {
          const factories = await sbGet('factories?tenant_id=eq.' + etid + '&select=id,factory_name_english,product_categories,status,certifications,reliability_score,credit_score&order=created_at.desc&limit=30');
          const fids = factories.map(f => f.id).filter(Boolean);
          let scores = [];
          if (fids.length) scores = await sbGet('factory_performance_scores?factory_id=in.(' + fids.join(',') + ')&select=factory_id,composite_score,tier,production_reliability_score,compliance_hygiene_score');
          const scoreBy = {}; scores.forEach(s => { scoreBy[s.factory_id] = s; });
          sources = ['factories', 'factory_performance_scores'];
          const data = factories.map(f => ({ factory: f.factory_name_english, categories: f.product_categories, status: f.status, certifications: f.certifications, score: scoreBy[f.id] || null }));
          const sys = 'You are a sourcing analyst. Given the factories (JSON), produce a MARKDOWN TABLE comparing them on capabilities, certifications, and performance scores, ranked best-first, then a 2-3 sentence recommendation. If insufficient data, say so.\n\nFACTORIES:\n' + JSON.stringify(data);
          const out = await claude(ANSWER_MODEL, 800, sys, query);
          logCost(tid, 'tenant_search_factory_comparison', ANSWER_MODEL, out.usage);
          answer = out.text || 'No factory data available to compare.';
        }
      } catch (e) { answer = 'Could not complete the comparison right now. Please try again.'; }
      return res.status(200).json({ mode: 'comparison', answer, sources });
    }

    // ── QUERY intents ──
    let dataCtx = {}, sources = [];
    try {
      if (intent === 'ap_balance') {
        const pos = await sbGet('purchase_orders?tenant_id=eq.' + etid + '&status=not.in.(cancelled,closed)&select=po_number,subtotal_fob,quantity,unit_fob_price,factory_name_snapshot,factories(factory_name_english),status');
        const byFactory = {};
        pos.forEach(p => { const f = (p.factories && p.factories.factory_name_english) || p.factory_name_snapshot || 'Unknown'; const v = p.subtotal_fob != null ? Number(p.subtotal_fob) : (Number(p.quantity || 0) * Number(p.unit_fob_price || 0)); byFactory[f] = (byFactory[f] || 0) + (v || 0); });
        dataCtx = { ap_by_factory: byFactory, total_ap: Object.values(byFactory).reduce((a, b) => a + b, 0) }; sources = ['purchase_orders'];
      } else if (intent === 'ar_balance') {
        const co = await sbGet('customer_orders?tenant_id=eq.' + etid + '&select=*&limit=50');
        if (!co.length) return res.status(200).json({ mode: 'query', answer: 'No AR data on file.', sources: [] });
        dataCtx = { customer_orders: co }; sources = ['customer_orders'];
      } else if (intent === 'open_orders') {
        const pos = await sbGet('purchase_orders?tenant_id=eq.' + etid + '&status=not.in.(cancelled,closed,complete,completed)&select=id,po_number,status,factory_name_snapshot,factories(factory_name_english),expected_ship_date');
        const ids = pos.map(p => p.id);
        let ms = [];
        if (ids.length) ms = await sbGet('po_milestones?purchase_order_id=in.(' + ids.join(',') + ')&select=purchase_order_id,milestone_type,agreed_date,revised_date,status&order=agreed_date.asc');
        const msBy = {}; ms.forEach(m => { (msBy[m.purchase_order_id] = msBy[m.purchase_order_id] || []).push(m); });
        dataCtx = { open_orders: pos.map(p => ({ po: p.po_number, status: p.status, factory: (p.factories && p.factories.factory_name_english) || p.factory_name_snapshot, expected_ship: p.expected_ship_date, milestones: (msBy[p.id] || []).map(m => ({ type: m.milestone_type, due: m.revised_date || m.agreed_date, status: m.status })) })) };
        sources = ['purchase_orders', 'po_milestones'];
      } else if (intent === 'sku_status') {
        const skus = await sbGet('skus?tenant_id=eq.' + etid + '&select=model_number,description,status,upc_code&order=created_at.desc&limit=80');
        dataCtx = { skus }; sources = ['skus'];
      } else if (intent === 'action_items') {
        const items = await sbGet('tenant_action_items?tenant_id=eq.' + etid + '&status=in.(open,acknowledged)&select=title,priority,due_date,type&order=priority.asc,created_at.asc&limit=50');
        dataCtx = { action_items: items }; sources = ['tenant_action_items'];
      } else if (intent === 'inspection_status') {
        const today = new Date().toISOString().slice(0, 10);
        const insp = await sbGet('inspections?tenant_id=eq.' + etid + '&scheduled_date=gte.' + today + '&select=scheduled_date,status,inspection_type,po_id,factories(factory_name_english)&order=scheduled_date.asc&limit=40');
        dataCtx = { inspections: insp.map(i => ({ date: i.scheduled_date, status: i.status, type: i.inspection_type, factory: i.factories && i.factories.factory_name_english })) }; sources = ['inspections'];
      } else if (intent === 'compliance_alerts') {
        const cutoff = new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10);
        const certs = await sbGet('factory_certifications?tenant_id=eq.' + etid + '&expiry_date=lte.' + cutoff + '&select=certification_name,expiry_date,status,factories(factory_name_english)&order=expiry_date.asc&limit=50');
        dataCtx = { expiring_certifications: certs.map(c => ({ factory: c.factories && c.factories.factory_name_english, cert: c.certification_name, expiry: c.expiry_date, status: c.status })) }; sources = ['factory_certifications'];
      } else {
        const [skus, pos, items, quotes] = await Promise.all([
          sbGet('skus?tenant_id=eq.' + etid + '&select=model_number,description,status,upc_code&order=created_at.desc&limit=40'),
          sbGet('purchase_orders?tenant_id=eq.' + etid + '&select=po_number,status,factory_name_snapshot,description_snapshot,unit_fob_price,quantity&order=created_at.desc&limit=40'),
          sbGet('tenant_action_items?tenant_id=eq.' + etid + '&status=in.(open,acknowledged)&select=title,priority&limit=20'),
          sbGet('rfq_quotes?select=unit_fob_price,factory_id,moq,production_lead_time_days,score_overall_v2,status,rfqs!inner(item_description,category,tenant_id)&rfqs.tenant_id=eq.' + etid + '&order=created_at.desc&limit=60'),
        ]);
        const quoteData = quotes.map(q => ({ product: q.rfqs && q.rfqs.item_description, category: q.rfqs && q.rfqs.category, unit_fob_price: q.unit_fob_price, factory_id: q.factory_id, moq: q.moq, lead_time_days: q.production_lead_time_days, quality_score: q.score_overall_v2, status: q.status }));
        dataCtx = { skus, purchase_orders: pos, rfq_quotes: quoteData, action_items: items };
        sources = ['skus', 'purchase_orders', 'rfq_quotes', 'tenant_action_items'];
      }
    } catch (e) { dataCtx = {}; }

    let answer = '';
    try {
      const sys = 'You are a sourcing intelligence assistant. Answer the question concisely and specifically using ONLY the portal data below (scoped to this tenant). Use markdown (bold, bullets, small tables) where helpful. If the data does not contain the answer, say so plainly.\n\n' + PRICING_GUIDE + '\n\nPORTAL DATA (JSON):\n' + JSON.stringify(dataCtx);
      const out = await claude(ANSWER_MODEL, 600, sys, query);
      logCost(tid, 'tenant_search_' + intent, ANSWER_MODEL, out.usage);
      answer = out.text || 'No answer returned.';
    } catch (e) { answer = 'Could not retrieve an answer right now. Please try again.'; }

    return res.status(200).json({ mode: 'query', answer, sources });
  } catch (err) {
    console.error('tenant-search error:', err);
    // Never a 500 — best-effort JSON.
    return res.status(200).json({ mode: 'query', answer: 'Something went wrong. Please try again.', sources: [] });
  }
}
