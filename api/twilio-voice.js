// api/twilio-voice.js
//
// Initiate an outbound call via Twilio using TwiML. Credentials are server-side
// only. Logs the call to twilio_communications.
//
//   POST { to, factory_id?, message?, connectTo?, twiml? } → { success, sid, status }
//     - twiml      : explicit TwiML to run on answer (overrides the rest)
//     - connectTo  : a phone number to <Dial> (bridge the factory to this number)
//     - message    : spoken <Say> text (default greeting if neither given)
export const config = { runtime: 'nodejs' };

import { logComm } from '../lib/twilio-log.mjs';

function escXml(s) { return (s || '').toString().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;'); }

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
  const factory_id = body.factory_id || null;
  if (!to) return res.status(400).json({ error: 'Missing "to"' });

  let twiml = body.twiml;
  if (!twiml) {
    if (body.connectTo) twiml = '<Response><Say voice="alice">Connecting your call from T B G Sourcing.</Say><Dial>' + escXml(body.connectTo) + '</Dial></Response>';
    else twiml = '<Response><Say voice="alice">' + escXml(body.message || 'Hello, this is an automated call from T B G Sourcing. Please hold while a representative connects with you.') + '</Say></Response>';
  }

  try {
    const params = new URLSearchParams({ To: to, From: FROM, Twiml: twiml });
    const r = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + SID + '/Calls.json', {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(SID + ':' + TOKEN).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ error: (d && d.message) || 'Twilio call failed', code: d && d.code });
    await logComm({ factory_id, direction: 'outbound', channel: 'voice', to_number: to, from_number: FROM, body: body.message || (body.connectTo ? 'Bridged call to ' + body.connectTo : 'Outbound call'), status: d.status || 'queued', twilio_sid: d.sid || null });
    return res.status(200).json({ success: true, sid: d.sid, status: d.status });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}
