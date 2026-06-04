// ============================================================
// /api/inspection-variance-explain.js
// AI explains a measurement variance found during a pre-shipment inspection.
// Called from the admin inspections page (no auth required).
//
// POST { measurement_type, spec_value, actual_value, variance_pct, product_category }
//   → { reasons: string[] }
//
// Env: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (cost log, best-effort)
// ============================================================
export const config = { runtime: 'nodejs' };

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SB_URL = process.env.SUPABASE_URL || 'https://mjkjubctswjwjihxjpnd.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
const MODEL = 'claude-sonnet-4-6';

function readBody(req) {
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
  return b || {};
}

function logCost(tokensIn, tokensOut, summary) {
  if (!SB_KEY) return;
  const costUsd = (tokensIn / 1e6) * 3 + (tokensOut / 1e6) * 15;
  fetch(SB_URL + '/rest/v1/api_cost_log', {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({
      tenant_id: null, service: 'anthropic', feature: 'inspection_variance',
      model: MODEL, tokens_in: tokensIn, tokens_out: tokensOut,
      cost_usd: costUsd, cost_usd_marked_up: costUsd * 1.5,
      prompt_summary: (summary || '').slice(0, 100),
    }),
  }).catch(() => {});
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set in Vercel.' });

  const { measurement_type, spec_value, actual_value, variance_pct, product_category } = readBody(req);

  const system = 'You are a consumer goods quality control expert. Given a measurement variance during pre-shipment inspection, provide 4-5 brief bullet points explaining possible reasons for the variance. Be specific to the product category. Keep each reason to one sentence.';
  const user = `Product category: ${product_category || 'general consumer goods'}. Measurement: ${measurement_type || 'unknown'}. Spec: ${spec_value}. Actual: ${actual_value}. Variance: ${variance_pct}%. What are the most likely reasons?`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 500, system, messages: [{ role: 'user', content: user }] }),
    });
    if (!r.ok) return res.status(502).json({ error: 'Anthropic ' + r.status + ': ' + (await r.text()).slice(0, 300) });
    const d = await r.json();
    const text = (d.content && d.content[0] && d.content[0].text) || '';

    // Parse bullet points into a clean array.
    const reasons = text
      .split('\n')
      .map(l => l.replace(/^\s*[-*•\d.)\]]+\s*/, '').trim())
      .filter(l => l.length > 0);

    logCost((d.usage && d.usage.input_tokens) || 0, (d.usage && d.usage.output_tokens) || 0,
      `${measurement_type} ${spec_value}->${actual_value}`);

    return res.status(200).json({ reasons: reasons.length ? reasons : [text.trim()].filter(Boolean) });
  } catch (err) {
    console.error('inspection-variance-explain error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
