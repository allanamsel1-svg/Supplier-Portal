// ============================================================
// /api/check-factory-performance-scores.js
//
// Nightly cron at 03:00 UTC. Loops every active factory and
// recomputes their performance score by POSTing to
// /api/compute-factory-performance.
//
// Runs serially to avoid hammering Supabase and to make
// error attribution easy.
//
// Env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VERCEL_URL (auto-set)
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Supabase ${res.status}: ${txt}`);
  }
  return res.status === 204 ? null : await res.json();
}

async function handler(req, res) {
  // Accept GET (Vercel cron) and POST (manual trigger)
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Missing SUPABASE env vars.' });
  }

  // Resolve the base URL for calling compute-factory-performance
  const baseUrl = (req.headers['x-forwarded-proto'] && req.headers['x-forwarded-host'])
    ? `${req.headers['x-forwarded-proto']}://${req.headers['x-forwarded-host']}`
    : (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://portal.tbgsourcing.net');

  const summary = {
    total: 0,
    succeeded: 0,
    failed: 0,
    insufficient_data: 0,
    by_tier: { green: 0, yellow: 0, red: 0, insufficient_data: 0 },
    errors: []
  };

  try {
    // Pull factories — only active ones (skip archived/disabled if you tag them)
    const factories = await sb(
      'factories?select=id,factory_name_english&order=factory_name_english.asc'
    ) || [];
    summary.total = factories.length;

    // Run serially. Each compute call ~200-500ms.
    for (const f of factories) {
      try {
        const r = await fetch(`${baseUrl}/api/compute-factory-performance`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ factory_id: f.id })
        });
        if (!r.ok) {
          const e = await r.json().catch(() => ({}));
          summary.failed++;
          summary.errors.push({ factory: f.factory_name_english, error: e.error || `HTTP ${r.status}` });
          continue;
        }
        const data = await r.json();
        summary.succeeded++;
        const tier = data?.score?.tier || 'insufficient_data';
        if (summary.by_tier[tier] !== undefined) summary.by_tier[tier]++;
        if (tier === 'insufficient_data') summary.insufficient_data++;
      } catch (e) {
        summary.failed++;
        summary.errors.push({ factory: f.factory_name_english, error: e.message });
      }
    }

    return res.status(200).json({ success: true, summary });
  } catch (err) {
    console.error('check-factory-performance-scores error:', err);
    return res.status(500).json({ error: String(err.message || err), summary });
  }
}

module.exports = handler;
module.exports.default = handler;
