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

function sbGet(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(SB_URL + path);
    const req = https.request({
      hostname: url.hostname, path: url.pathname + url.search,
      method: 'GET', headers: {
        'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY,
        'Accept': 'application/json'
      }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(d) }); } catch(e) { resolve({ status: res.statusCode, data: d }); } });
    });
    req.on('error', reject); req.end();
  });
}

function sbDelete(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(SB_URL + path);
    const req = https.request({
      hostname: url.hostname, path: url.pathname + url.search,
      method: 'DELETE', headers: {
        'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY
      }
    }, res => { resolve({ status: res.statusCode }); });
    req.on('error', reject); req.end();
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAdmin(req, res)) return;
  if (!SB_KEY) return res.status(500).json({ error: 'Missing SUPABASE_SERVICE_ROLE_KEY' });

  const { action, dataset_id } = req.query;

  try {
    if (req.method === 'GET' && action === 'datasets') {
      const r = await sbGet('/rest/v1/ig_datasets?select=id,dataset_name,category,competitor_name,row_count,uploaded_at&order=uploaded_at.desc&limit=20');
      return res.status(200).json(r.data);
    }

    if (req.method === 'GET' && action === 'shipments' && dataset_id) {
      const r = await sbGet('/rest/v1/ig_shipments?select=*&dataset_id=eq.' + dataset_id + '&order=arrival_date.desc&limit=10000');
      return res.status(200).json(r.data);
    }

    if (req.method === 'DELETE' && action === 'dataset' && dataset_id) {
      await sbDelete('/rest/v1/ig_shipments?dataset_id=eq.' + dataset_id);
      await sbDelete('/rest/v1/ig_datasets?id=eq.' + dataset_id);
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
