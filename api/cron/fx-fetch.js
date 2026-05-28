// ════════════════════════════════════════════════════════════════════
// /api/cron/fx-fetch.js
// Daily USD/CNY exchange rate fetch -> fx_rates.
// Idempotent via on_conflict=pair,rate_date (PostgREST merge-duplicates).
// ════════════════════════════════════════════════════════════════════

export const config = { runtime: 'nodejs' };
export const maxDuration = 30;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const FX_URL = 'https://api.exchangerate.host/latest?base=USD&symbols=CNY';
const SOURCE = 'exchangerate.host';

export default async function handler(req, res) {
  try {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(500).json({ ok: false, error: 'missing SUPABASE_URL / SUPABASE_SERVICE_KEY env' });
    }

    const upstream = await fetch(FX_URL);
    const upstreamText = await upstream.text();
    let parsed;
    try {
      parsed = JSON.parse(upstreamText);
    } catch {
      return res.status(502).json({ ok: false, error: 'upstream returned non-JSON', upstream: upstreamText.slice(0, 300) });
    }

    const rate = parsed?.rates?.CNY;
    if (!Number.isFinite(rate)) {
      return res.status(502).json({ ok: false, error: 'no CNY rate in upstream payload', upstream: parsed });
    }

    const today = new Date().toISOString().slice(0, 10);
    const row = {
      pair: 'USD/CNY',
      rate_date: today,
      rate,
      source: SOURCE,
      fetched_at: new Date().toISOString()
    };

    const upRes = await fetch(`${SUPABASE_URL}/rest/v1/fx_rates?on_conflict=pair,rate_date`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=representation'
      },
      body: JSON.stringify(row)
    });

    if (!upRes.ok) {
      const errBody = await upRes.text();
      return res.status(500).json({ ok: false, error: `supabase ${upRes.status}`, body: errBody });
    }

    const inserted = await upRes.json();
    return res.status(200).json({
      ok: true,
      pair: 'USD/CNY',
      rate_date: today,
      rate,
      source: SOURCE,
      row: Array.isArray(inserted) ? inserted[0] : inserted
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
