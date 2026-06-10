// api/u/[code].js — short-link resolver (Vercel dynamic route → /u/<code>)
//   GET /u/<code>
//     • found & not expired → 302 redirect to the stored url (+ bump click_count)
//     • not found or expired → 404 "Link expired or not found" page
export const config = { runtime: 'nodejs' };

const SB_URL = process.env.SUPABASE_URL || 'https://mjkjubctswjwjihxjpnd.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const H = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' };

function notFound(res) {
  const html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" />' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0" />' +
    '<title>Link expired or not found</title>' +
    '<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f5f5f0;color:#1a1a2e;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}' +
    '.box{background:#fff;border:1px solid #e0e0d8;border-radius:14px;padding:2.5rem;max-width:420px;text-align:center;box-shadow:0 2px 16px rgba(0,0,0,0.06);}' +
    'h1{font-size:18px;margin:0 0 8px;}p{font-size:14px;color:#888;margin:0;}</style></head>' +
    '<body><div class="box"><div style="font-size:38px;margin-bottom:10px;">🔗</div>' +
    '<h1>Link expired or not found</h1>' +
    '<p>This link is no longer valid. Please request a new one.</p></div></body></html>';
  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.end(html);
}

export default async function handler(req, res) {
  const code = (req.query && req.query.code ? req.query.code : '').toString().trim();
  if (!code || !SB_KEY) return notFound(res);

  try {
    const r = await fetch(SB_URL + '/rest/v1/short_links?code=eq.' + encodeURIComponent(code) + '&select=id,url,expires_at,click_count&limit=1', { headers: H });
    const rows = r.ok ? await r.json() : [];
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row || !row.url) return notFound(res);
    if (row.expires_at && new Date(row.expires_at) < new Date()) return notFound(res);

    // Best-effort click tracking — never blocks the redirect.
    try {
      await fetch(SB_URL + '/rest/v1/short_links?id=eq.' + row.id, {
        method: 'PATCH',
        headers: Object.assign({}, H, { Prefer: 'return=minimal' }),
        body: JSON.stringify({ click_count: (row.click_count || 0) + 1 })
      });
    } catch (e) { /* non-fatal */ }

    res.statusCode = 302;
    res.setHeader('Location', row.url);
    res.setHeader('Cache-Control', 'no-store');
    return res.end();
  } catch (err) {
    console.error('short-link resolve error:', err);
    return notFound(res);
  }
}
