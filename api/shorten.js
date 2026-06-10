// api/shorten.js
// Create a short link for a long URL.
//   POST { url, expires_at }
//     url         (required) the full destination URL
//     expires_at  (optional) ISO timestamp after which the link 404s
//   → { short_url: "https://portal.tbgsourcing.net/u/<code>" }
//
// Writes a row into public.short_links { code, url, expires_at, created_at }.
export const config = { runtime: 'nodejs' };

const SB_URL = process.env.SUPABASE_URL || 'https://mjkjubctswjwjihxjpnd.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const H = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' };
const BASE_URL = (process.env.SHORT_LINK_BASE_URL || 'https://portal.tbgsourcing.net').replace(/\/+$/, '');

// 6-char alphanumeric code (lowercase letters + digits), e.g. "x7k2mq".
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
function makeCode(len) {
  let out = '';
  for (let i = 0; i < (len || 6); i++) out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });
  if (!SB_KEY) return res.status(500).json({ error: 'Short-link service is not configured.' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const url = (body.url || '').toString().trim();
  const expiresAt = body.expires_at ? new Date(body.expires_at).toISOString() : null;
  if (!url) return res.status(400).json({ error: 'url is required.' });

  // Insert with a fresh code, retrying on the (rare) UNIQUE collision.
  try {
    for (let attempt = 0; attempt < 6; attempt++) {
      const code = makeCode(6);
      const r = await fetch(SB_URL + '/rest/v1/short_links', {
        method: 'POST',
        headers: Object.assign({}, H, { Prefer: 'return=representation' }),
        body: JSON.stringify({ code, url, expires_at: expiresAt, created_at: new Date().toISOString() })
      });
      if (r.ok) {
        return res.status(200).json({ short_url: BASE_URL + '/u/' + code, code });
      }
      // 409 = unique-violation on code → try a different code; anything else is a real error.
      if (r.status !== 409) {
        const t = await r.text().catch(() => '');
        return res.status(500).json({ error: 'Could not create short link (' + r.status + ') ' + t.slice(0, 200) });
      }
    }
    return res.status(500).json({ error: 'Could not allocate a unique short code, please retry.' });
  } catch (err) {
    console.error('shorten error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
