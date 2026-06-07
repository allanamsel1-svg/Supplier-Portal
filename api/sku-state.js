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

// ── Service-role Supabase helpers (same pattern as api/ig-import.js) ──
function sbPost(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(SB_URL + path);
    const req = https.request({
      hostname: url.hostname, path: url.pathname + url.search,
      method: 'POST', headers: {
        'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY,
        'Content-Type': 'application/json', 'Prefer': 'return=minimal',
        'Content-Length': Buffer.byteLength(data)
      }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, data: d ? JSON.parse(d) : null }); } catch(e) { resolve({ status: res.statusCode, data: d }); } });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

function sbPatch(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(SB_URL + path);
    const req = https.request({
      hostname: url.hostname, path: url.pathname + url.search,
      method: 'PATCH', headers: {
        'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY,
        'Content-Type': 'application/json', 'Prefer': 'return=minimal',
        'Content-Length': Buffer.byteLength(data)
      }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, data: d ? JSON.parse(d) : null }); } catch(e) { resolve({ status: res.statusCode, data: d }); } });
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
    var body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};
    const action = body.action;
    const stateId = body.state_id;
    const newState = body.new_state;
    const note = body.note || '';
    const approvedBy = body.approved_by || 'admin';
    const now = new Date().toISOString();

    if (!stateId) return res.status(400).json({ error: 'Missing state_id' });
    const stateRef = '/rest/v1/sku_inventory_states?id=eq.' + encodeURIComponent(stateId);

    if (action === 'approve') {
      if (!newState) return res.status(400).json({ error: 'Missing new_state' });
      var ins = await sbPost('/rest/v1/sku_state_transitions', {
        sku_inventory_state_id: stateId, to_state: newState, triggered_by: 'manual',
        approved_by: approvedBy, approved_at: now, notes: note
      });
      if (ins.status >= 300) return res.status(500).json({ error: 'Transition insert failed', detail: ins.data });
      var upd = await sbPatch(stateRef, {
        current_state: newState, proposed_state: null, proposed_at: null, proposed_reason: null,
        approved_by: approvedBy, approved_at: now
      });
      if (upd.status >= 300) return res.status(500).json({ error: 'State update failed', detail: upd.data });
      return res.status(200).json({ success: true });
    }

    if (action === 'reject') {
      var r = await sbPatch(stateRef, {
        proposed_state: null, proposed_at: null, proposed_reason: null, notes: note || 'Rejected'
      });
      if (r.status >= 300) return res.status(500).json({ error: 'Reject failed', detail: r.data });
      return res.status(200).json({ success: true });
    }

    if (action === 'manual_change') {
      if (!newState) return res.status(400).json({ error: 'Missing new_state' });
      var m = await sbPatch(stateRef, {
        proposed_state: newState, proposed_at: now, proposed_reason: 'Manual change request: ' + note
      });
      if (m.status >= 300) return res.status(500).json({ error: 'Manual change failed', detail: m.data });
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
