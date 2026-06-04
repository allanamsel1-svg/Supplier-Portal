// ============================================================
// /api/inspection-parse-document.js
// Reads an uploaded inspection report (PDF or image) with Claude vision and
// extracts measurement data, then upserts inspection_measurements rows.
// Called from the admin inspections page (no auth required).
//
// POST { inspection_id, file_url, product_category }
//   → { extracted: { unit, inner, master, upc_codes }, measurements_updated: N }
//
// Env: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// ============================================================
export const config = { runtime: 'nodejs' };
export const maxDuration = 60;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SB_URL = process.env.SUPABASE_URL || 'https://mjkjubctswjwjihxjpnd.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
const MODEL = 'claude-sonnet-4-6';
const SBH = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' };

function readBody(req) {
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
  return b || {};
}

function extractJson(text) {
  let c = (text || '').trim().replace(/```json|```/g, '').trim();
  const start = c.indexOf('{');
  const end = c.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON in model output');
  return JSON.parse(c.substring(start, end + 1));
}

function logCost(tokensIn, tokensOut, summary) {
  if (!SB_KEY) return;
  const costUsd = (tokensIn / 1e6) * 3 + (tokensOut / 1e6) * 15;
  fetch(SB_URL + '/rest/v1/api_cost_log', {
    method: 'POST', headers: { ...SBH, Prefer: 'return=minimal' },
    body: JSON.stringify({
      tenant_id: null, service: 'anthropic', feature: 'inspection_parse_document',
      model: MODEL, tokens_in: tokensIn, tokens_out: tokensOut,
      cost_usd: costUsd, cost_usd_marked_up: costUsd * 1.5, prompt_summary: (summary || '').slice(0, 100),
    }),
  }).catch(() => {});
}

// Upsert one measurement_type row for an inspection. We dedupe on (inspection_id, measurement_type)
// by deleting any existing row of that type first, then inserting.
async function upsertMeasurement(inspectionId, type, data) {
  if (!data) return false;
  const row = {
    inspection_id: inspectionId,
    measurement_type: type,
    weight_actual: data.weight_kg ?? null,
    length_actual: data.length_cm ?? null,
    width_actual: data.width_cm ?? null,
    height_actual: data.height_cm ?? null,
    qty_per_pack_actual: data.qty_per_inner ?? data.qty_per_master ?? null,
  };
  // Drop nulls so we never overwrite with empty.
  Object.keys(row).forEach(k => { if (row[k] === null || row[k] === undefined) delete row[k]; });
  if (Object.keys(row).length <= 2) return false; // only the keys, nothing extracted

  try {
    await fetch(SB_URL + '/rest/v1/inspection_measurements?inspection_id=eq.' + encodeURIComponent(inspectionId) + '&measurement_type=eq.' + encodeURIComponent(type), {
      method: 'DELETE', headers: { ...SBH, Prefer: 'return=minimal' },
    });
    const r = await fetch(SB_URL + '/rest/v1/inspection_measurements', {
      method: 'POST', headers: { ...SBH, Prefer: 'return=minimal' }, body: JSON.stringify(row),
    });
    return r.ok;
  } catch { return false; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set in Vercel.' });

  const { inspection_id, file_url, product_category } = readBody(req);
  if (!inspection_id || !file_url) return res.status(400).json({ error: 'Missing inspection_id or file_url.' });

  try {
    // 1. Fetch the document and base64-encode it.
    const docRes = await fetch(file_url);
    if (!docRes.ok) return res.status(400).json({ error: 'Could not fetch document: ' + docRes.status });
    const contentType = (docRes.headers.get('content-type') || '').toLowerCase();
    const buf = Buffer.from(await docRes.arrayBuffer());
    const b64 = buf.toString('base64');
    const isPdf = contentType.includes('pdf') || /\.pdf($|\?)/i.test(file_url);

    const docBlock = isPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
      : { type: 'image', source: { type: 'base64', media_type: contentType.includes('png') ? 'image/png' : 'image/jpeg', data: b64 } };

    const system = 'You are a quality control inspector reading an inspection report. Extract all measurement data you can find including weights, dimensions (L×W×H), quantities per inner/master carton, and UPC/barcode numbers. Return ONLY valid JSON.';
    const userText = `Product category: ${product_category || 'general'}. Extract measurements. Return JSON: { "unit": { "weight_kg": number|null, "length_cm": number|null, "width_cm": number|null, "height_cm": number|null }, "inner": { "weight_kg": number|null, "length_cm": number|null, "width_cm": number|null, "height_cm": number|null, "qty_per_inner": number|null }, "master": { "weight_kg": number|null, "length_cm": number|null, "width_cm": number|null, "height_cm": number|null, "qty_per_master": number|null }, "upc_codes": [] }`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 1500, system, messages: [{ role: 'user', content: [docBlock, { type: 'text', text: userText }] }] }),
    });
    if (!r.ok) return res.status(502).json({ error: 'Anthropic ' + r.status + ': ' + (await r.text()).slice(0, 300) });
    const d = await r.json();
    logCost((d.usage && d.usage.input_tokens) || 0, (d.usage && d.usage.output_tokens) || 0, 'parse ' + inspection_id);

    let extracted;
    try { extracted = extractJson((d.content && d.content[0] && d.content[0].text) || ''); }
    catch (e) { return res.status(200).json({ extracted: null, measurements_updated: 0, warning: 'Could not parse model output as JSON.' }); }

    // 5. Upsert measurement rows.
    let updated = 0;
    if (await upsertMeasurement(inspection_id, 'unit', extracted.unit)) updated++;
    if (await upsertMeasurement(inspection_id, 'inner', extracted.inner)) updated++;
    if (await upsertMeasurement(inspection_id, 'master', extracted.master)) updated++;

    // Persist the report_url on the inspection (best-effort) and flag UPC verification potential.
    fetch(SB_URL + '/rest/v1/inspections?id=eq.' + encodeURIComponent(inspection_id), {
      method: 'PATCH', headers: { ...SBH, Prefer: 'return=minimal' }, body: JSON.stringify({ report_url: file_url }),
    }).catch(() => {});

    return res.status(200).json({ extracted, measurements_updated: updated });
  } catch (err) {
    console.error('inspection-parse-document error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
