// api/twilio-whatsapp.js
//
// Send an outbound WhatsApp message via Twilio (whatsapp: prefix on To/From).
// Credentials are server-side only. Logs to twilio_communications (channel=whatsapp).
//
//   POST { to, message, factory_id? } → { success, sid, status }
//
// Note: TWILIO_PHONE_NUMBER must be a WhatsApp-enabled sender (or the Twilio
// WhatsApp sandbox number) for this to deliver.
export const config = { runtime: 'nodejs' };

import { logComm } from '../lib/twilio-log.mjs';

const waAddr = (n) => {
  const s = (n || '').toString().trim();
  return s.startsWith('whatsapp:') ? s : 'whatsapp:' + s;
};
const plain = (n) => (n || '').toString().trim().replace(/^whatsapp:/, '');

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
  const message = (body.message || '').toString();
  const factory_id = body.factory_id || null;
  if (!to || !message) return res.status(400).json({ error: 'Missing "to" or "message"' });

  try {
    const params = new URLSearchParams({ To: waAddr(to), From: waAddr(FROM), Body: message });
    const r = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + SID + '/Messages.json', {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(SID + ':' + TOKEN).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ error: (d && d.message) || 'Twilio WhatsApp failed', code: d && d.code });
    await logComm({ factory_id, direction: 'outbound', channel: 'whatsapp', to_number: plain(to), from_number: plain(FROM), body: message, status: d.status || 'queued', twilio_sid: d.sid || null });
    return res.status(200).json({ success: true, sid: d.sid, status: d.status });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}
