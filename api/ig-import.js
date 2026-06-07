const https = require('https');
const { createHmac, timingSafeEqual } = require('crypto');

const SB_URL = process.env.SUPABASE_URL || 'https://mjkjubctswjwjihxjpnd.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ALLOW_ORIGIN = 'https://portal.tbgsourcing.net';

// ── Admin auth gate (same HMAC scheme as api/admin-auth.js / other admin routes) ──
function bearer(req) { return (req.headers.authorization || req.headers.Authorization || '').replace('Bearer ', '').trim(); }
function verifyAdminToken(token, key) {
  if (!token || typeof token !== 'string' || token.indexOf('.') === -1) return false;
  const [payload, sig] = token.split('.');
  const expected = createHmac('sha256', key).update(payload).digest('base64url');
  if (!sig || sig.length !== expected.length) return false;
  try { if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false; } catch (e) { return false; }
  try { const obj = JSON.parse(Buffer.from(payload, 'base64url').toString()); return !obj.exp || Date.now() < obj.exp; } catch (e) { return false; }
}
// Returns true if allowed to proceed. Skips the gate only when ADMIN_PASSWORD is
// unconfigured (legacy mode) so deploying this never locks out an existing setup.
function requireAdmin(req, res) {
  const PASS = process.env.ADMIN_PASSWORD != null ? String(process.env.ADMIN_PASSWORD).trim() : null;
  const KEY = String(process.env.ADMIN_SESSION_SECRET || PASS || '').trim();
  if (PASS && !verifyAdminToken(bearer(req), KEY)) { res.status(401).json({ error: 'Unauthorized' }); return false; }
  return true;
}

function sbPost(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(SB_URL + path);
    const req = https.request({
      hostname: url.hostname, path: url.pathname + url.search,
      method: 'POST', headers: {
        'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY,
        'Content-Type': 'application/json', 'Prefer': 'return=representation',
        'Content-Length': Buffer.byteLength(data)
      }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(d) }); } catch(e) { resolve({ status: res.statusCode, data: d }); } });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdmin(req, res)) return;
  if (!SB_KEY) return res.status(500).json({ error: 'Missing SUPABASE_SERVICE_ROLE_KEY' });

  try {
    const { dataset_name, category, competitor_name, pull_type, date_from, date_to, row_count, uploaded_by, shipments } = req.body;

    // Insert dataset
    const dsRes = await sbPost('/rest/v1/ig_datasets', {
      dataset_name, category: category || 'general', competitor_name: competitor_name || null,
      pull_type: pull_type || 'manual_upload', date_from: date_from || null,
      date_to: date_to || null, row_count: row_count || shipments.length,
      uploaded_by: uploaded_by || 'admin'
    });
    if (dsRes.status >= 300) return res.status(500).json({ error: 'Dataset insert failed', detail: dsRes.data });
    const datasetId = dsRes.data[0].id;

    // Insert shipments in batches of 200
    const tagged = shipments.map(s => ({ ...s, dataset_id: datasetId }));
    for (let i = 0; i < tagged.length; i += 200) {
      const batch = tagged.slice(i, i + 200);
      const bRes = await sbPost('/rest/v1/ig_shipments', batch);
      if (bRes.status >= 300) return res.status(500).json({ error: 'Shipment insert failed at row ' + i, detail: bRes.data });
    }

    return res.status(200).json({ success: true, dataset_id: datasetId, row_count: tagged.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
