// /api/index-factory-products.js
//
// Indexes a factory's product documents (product_documents) into structured
// factory_product_attributes via Anthropic. Documents are grouped by product
// (product_development_id) and the product-descriptive ones (images, INCI,
// formulation, user manual, CoA) are sent together so each product yields ONE
// consolidated attributes row.
//
//   POST { factoryId }            → index all products for the factory
//   GET  ?factoryId=<uuid>        → same
// Re-running replaces the AI-extracted rows for that factory (idempotent).

const SUPABASE_URL = 'https://mjkjubctswjwjihxjpnd.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
  || process.env.SUPABASE_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1qa2p1YmN0c3dqd2ppaHhqcG5kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczNjQxNjcsImV4cCI6MjA5Mjk0MDE2N30.cZrD_ymrDsRPyfX_g3hUui5_JXuW6BgE77QkIoGpqHo';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-6';
const BUCKET = 'factory-documents';

export const config = { runtime: 'nodejs' };
export const maxDuration = 300;

// Document types worth feeding the extractor, richest first.
const DOC_PRIORITY = ['Product Image', 'INCI List', 'Full Formulation', 'User Manual', 'Certificate of Analysis', 'Stability Test Report', 'Technical Drawing', 'Die Lines'];
const MAX_DOCS_PER_PRODUCT = 6;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set in env' });

  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const factoryId = (body && body.factoryId) || (req.query && req.query.factoryId);
    if (!factoryId) return res.status(400).json({ error: 'Missing factoryId' });

    // Factory name (for the response).
    const fR = await sbFetch(`/rest/v1/factories?id=eq.${factoryId}&select=id,factory_name_english`);
    const factory = fR.ok ? (await fR.json())[0] : null;

    // Current product documents for the factory.
    const dR = await sbFetch(`/rest/v1/product_documents?factory_id=eq.${factoryId}&select=id,product_development_id,document_type,file_name,file_path&order=document_type.asc`);
    if (!dR.ok) throw new Error(`product_documents fetch ${dR.status}`);
    const docs = await dR.json();
    if (!docs.length) return res.status(200).json({ success: true, factory: factory && factory.factory_name_english, products_indexed: 0, note: 'No product documents.' });

    // Group by product (product_development_id; fall back to the factory).
    const groups = {};
    docs.forEach(d => { const k = d.product_development_id || ('factory:' + factoryId); (groups[k] = groups[k] || []).push(d); });

    // Idempotent: clear previously AI-extracted rows for this factory.
    await sbFetch(`/rest/v1/factory_product_attributes?factory_id=eq.${factoryId}&ai_extracted=eq.true`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });

    const results = [];
    for (const key of Object.keys(groups)) {
      const picked = pickDocs(groups[key]);
      if (!picked.length) continue;

      const content = [];
      for (const d of picked) {
        const block = await fetchDocBlock(d.file_path, d.file_name);
        if (block) content.push(block);
      }
      if (!content.length) continue;
      content.push({ type: 'text', text: buildPrompt() });

      const extracted = await callAnthropic(content);
      if (!extracted) continue;

      const primaryDoc = picked.find(d => d.document_type === 'Product Image') || picked[0];
      const payload = {
        factory_id: factoryId,
        product_document_id: primaryDoc ? primaryDoc.id : null,
        product_name: extracted.product_name || null,
        category: extracted.category || null,
        sub_category: extracted.sub_category || null,
        product_type: extracted.product_type || null,
        format: extracted.format || null,
        material: extracted.material || null,
        size_range: extracted.size_range || null,
        unit_type: extracted.unit_type || null,
        price_usd: numOrNull(extracted.price_usd),
        description: extracted.description || null,
        extracted_keywords: Array.isArray(extracted.extracted_keywords) ? extracted.extracted_keywords.slice(0, 25) : null,
        ai_extracted: true
      };
      const insR = await sbFetch('/rest/v1/factory_product_attributes', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body: JSON.stringify(payload)
      });
      if (insR.ok) results.push((await insR.json())[0]);
      else console.warn('attr insert failed', insR.status, await insR.text());
    }

    return res.status(200).json({
      success: true,
      factory: factory && factory.factory_name_english,
      products_indexed: results.length,
      products: results.map(r => ({ product_name: r.product_name, category: r.category, sub_category: r.sub_category, unit_type: r.unit_type }))
    });
  } catch (err) {
    console.error('index-factory-products error:', err);
    return res.status(500).json({ error: err.message || String(err) });
  }
}

// ─── helpers ─────────────────────────────────────────────────────────
function pickDocs(groupDocs) {
  return groupDocs
    .filter(d => mediaTypeFor(d.file_name))
    .sort((a, b) => (DOC_PRIORITY.indexOf(a.document_type) + 1 || 99) - (DOC_PRIORITY.indexOf(b.document_type) + 1 || 99))
    .slice(0, MAX_DOCS_PER_PRODUCT);
}

function mediaTypeFor(fileName) {
  const n = String(fileName || '').toLowerCase();
  if (n.endsWith('.png')) return { kind: 'image', mt: 'image/png' };
  if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return { kind: 'image', mt: 'image/jpeg' };
  if (n.endsWith('.webp')) return { kind: 'image', mt: 'image/webp' };
  if (n.endsWith('.gif')) return { kind: 'image', mt: 'image/gif' };
  if (n.endsWith('.pdf')) return { kind: 'pdf', mt: 'application/pdf' };
  // Product Images sometimes have no extension — treat extension-less as jpeg.
  if (!/\.[a-z0-9]{2,4}$/.test(n)) return { kind: 'image', mt: 'image/jpeg' };
  return null; // .step and anything else
}

async function fetchDocBlock(path, fileName) {
  const media = mediaTypeFor(fileName);
  if (!media) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
    });
    if (!r.ok) { console.warn(`doc fetch ${r.status}: ${path}`); return null; }
    const buf = await r.arrayBuffer();
    if (buf.byteLength > 4.5 * 1024 * 1024) { console.warn(`doc too large: ${path}`); return null; }
    const data = Buffer.from(buf).toString('base64');
    if (media.kind === 'pdf') return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
    return { type: 'image', source: { type: 'base64', media_type: media.mt, data } };
  } catch (e) { console.warn('fetchDocBlock error', path, e.message); return null; }
}

async function callAnthropic(content) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 1024, messages: [{ role: 'user', content }] })
  });
  if (!r.ok) { console.warn('anthropic', r.status, await r.text()); return null; }
  const data = await r.json();
  const text = (data.content || []).map(c => c.text || '').join('\n');
  const fence = text.match(/```json\s*([\s\S]*?)\s*```/);
  const brace = text.match(/(\{[\s\S]*\})/);
  const jsonText = fence ? fence[1] : (brace ? brace[1] : text);
  try { return JSON.parse(jsonText); } catch { console.warn('unparseable', text.slice(0, 300)); return null; }
}

function buildPrompt() {
  return `You are cataloguing ONE manufactured product from a factory's product documents (images, formulation/INCI sheets, technical drawings, user manual). All the attached documents describe the SAME single product. Extract a structured catalogue record and return STRICTLY one JSON object — no prose, no markdown fences.

{
  "product_name": "string — concise product name",
  "category": "string — top category, e.g. 'Health & Beauty'",
  "sub_category": "string — e.g. 'Skin Care'",
  "product_type": "string — specific type, e.g. 'Face Serum', 'Facial Wipes', 'Body Lotion'",
  "format": "string or null — physical format, e.g. 'dropper bottle', 'tube', 'pump', 'sachet'",
  "material": "string or null — primary material/packaging material if evident",
  "size_range": "string or null — size(s) offered, e.g. '30ml', '50-100ml'",
  "unit_type": "string — the selling unit: one of ml, g, fl_oz, oz, count, piece, pack, set, kit",
  "price_usd": "number or null — unit price in USD only if explicitly visible",
  "description": "string — one or two sentence description",
  "extracted_keywords": ["array of 5-15 lowercase single-word or short keywords describing the product, its ingredients, use, and category"]
}

Output a single JSON object only.`;
}

function sbFetch(path, opts = {}) {
  opts.headers = opts.headers || {};
  opts.headers.apikey = SUPABASE_KEY;
  opts.headers.Authorization = `Bearer ${SUPABASE_KEY}`;
  return fetch(`${SUPABASE_URL}${path}`, opts);
}
function numOrNull(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
