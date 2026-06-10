// api/admin-settings.js
// GET → masked values of server-side API keys (read-only; keys are managed in Vercel).
//   { ok, keys: { anthropic:{present,masked,last4}, sendgrid:{...}, supabase:{...} } }
// Full secrets are NEVER returned to the client.
export const config = { runtime: 'nodejs' };

function maskKey(raw) {
  const v = raw == null ? '' : String(raw).trim();
  if (!v) return { present: false, masked: '— not set —', last4: '' };
  const last4 = v.length >= 4 ? v.slice(-4) : v;
  const dots = '••••••••';
  // Show a short prefix (if the key is long enough) + dots + last 4.
  const prefix = v.length > 12 ? v.slice(0, 4) : '';
  return { present: true, masked: (prefix ? prefix : '') + dots + last4, last4 };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const keys = {
    anthropic: maskKey(process.env.ANTHROPIC_API_KEY),
    sendgrid: maskKey(process.env.SENDGRID_API_KEY),
    supabase: maskKey(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY)
  };
  return res.status(200).json({ ok: true, keys });
}
