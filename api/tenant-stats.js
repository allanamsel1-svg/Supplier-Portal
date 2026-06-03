// api/tenant-stats.js
// Per-tenant dashboard counts (active RFQs, factories, live SKUs, open POs).
// ESM + native fetch to Supabase PostgREST (service key) — same style as the
// rest of the portal's serverless functions. Resilient: any table missing a
// tenant_id column simply returns 0 rather than failing the whole response.
export const config = { runtime: 'nodejs' };

const SB_URL = process.env.SUPABASE_URL || 'https://mjkjubctswjwjihxjpnd.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const H = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY };

async function count(path) {
  try {
    const r = await fetch(SB_URL + '/rest/v1/' + path, { method: 'HEAD', headers: { ...H, Prefer: 'count=exact', Range: '0-0' } });
    if (!r.ok) return 0;
    const cr = r.headers.get('content-range') || '';
    const total = cr.split('/')[1];
    return total && total !== '*' ? (parseInt(total, 10) || 0) : 0;
  } catch { return 0; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = (req.headers.authorization || req.headers.Authorization || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  // Validate session
  let session = null;
  try {
    const r = await fetch(SB_URL + '/rest/v1/tenant_sessions?select=tenant_id,expires_at&token=eq.' + encodeURIComponent(token) + '&limit=1', { headers: H });
    const arr = r.ok ? await r.json() : [];
    session = Array.isArray(arr) ? arr[0] : null;
  } catch { session = null; }
  if (!session || new Date(session.expires_at) < new Date()) return res.status(401).json({ error: 'Invalid session' });

  const tid = encodeURIComponent(session.tenant_id);

  const [rfqs, factories, skus, pos] = await Promise.all([
    count('rfqs?tenant_id=eq.' + tid + '&status=in.(active,open,pending)'),
    count('factories?tenant_id=eq.' + tid),
    count('skus?tenant_id=eq.' + tid),
    count('purchase_orders?tenant_id=eq.' + tid + '&status=not.in.(cancelled,closed,complete)'),
  ]);

  return res.status(200).json({ rfqs, factories, skus, pos });
}
