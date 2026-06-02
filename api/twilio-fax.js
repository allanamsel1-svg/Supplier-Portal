// api/twilio-fax.js
//
// Send a fax via the Twilio Programmable Fax API. Credentials are server-side
// only. Requires a publicly reachable PDF URL (mediaUrl) — the admin UI uploads
// the PDF to the public `twilio-fax` Supabase bucket and passes its public URL.
// Logs the fax to twilio_communications.
//
//   POST { to, mediaUrl, factory_id? } → { success, sid, status }
//
// Note: Programmable Fax must be enabled on the Twilio account.
export const config = { runtime: 'nodejs' };

const SB_URL = 'https://mjkjubctswjwjihxjpnd.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1qa2p1YmN0c3dqd2ppaHhqcG5kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczNjQxNjcsImV4cCI6MjA5Mjk0MDE2N30.cZrD_ymrDsRPyfX_g3hUui5_JXuW6BgE77QkIoGpqHo';

async function logComm(row) {
  try {
    await fetch(SB_URL + '/rest/v1/twilio_communications', {
      method: 'POST',
      headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(row),
    });
  } catch (e) { /* best-effort */ }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const SID = process.env.TWILIO_ACCOUNT_SID, TOKEN = process.env.TWILIO_AUTH_TOKEN, FROM = process.env.TWILIO_PHONE_NUMBER;
  if (!SID || !TOKEN || !FROM) return res.status(500).json({ error: 'Twilio environment variables are not configured' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  const to = (body.to || '').toString().trim();
  const mediaUrl = (body.mediaUrl || '').toString().trim();
  const factory_id = body.factory_id || null;
  if (!to || !mediaUrl) return res.status(400).json({ error: 'Missing "to" or "mediaUrl"' });

  try {
    const params = new URLSearchParams({ To: to, From: FROM, MediaUrl: mediaUrl });
    const r = await fetch('https://fax.twilio.com/v1/Faxes', {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(SID + ':' + TOKEN).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ error: (d && d.message) || 'Twilio fax failed', code: d && d.code });
    await logComm({ factory_id, direction: 'outbound', channel: 'fax', to_number: to, from_number: FROM, body: mediaUrl, status: d.status || 'queued', twilio_sid: d.sid || null });
    return res.status(200).json({ success: true, sid: d.sid, status: d.status });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}
