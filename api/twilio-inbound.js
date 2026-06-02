// api/twilio-inbound.js
//
// Webhook for inbound SMS / voice to the TWILIO_PHONE_NUMBER, plus the voice
// transcription callback. Configure BOTH the Messaging and Voice webhooks of
// the Twilio number to POST here:
//   https://portal.tbgsourcing.net/api/twilio-inbound
//
// Behaviour:
//   • Inbound SMS  → match sender to a factory, log to twilio_communications,
//                    auto-reply an acknowledgement (TwiML <Message>).
//   • Inbound call → log, then answer with TwiML that records a voicemail with
//                    transcription (transcribeCallback points back here).
//   • Transcription callback (?event=transcription) → update the voice row's
//                    body with the transcript.
//
// Signature validation is enforced only when TWILIO_VALIDATE_SIGNATURE=true
// (off by default so a missing/misconfigured URL never silently drops traffic).
export const config = { api: { bodyParser: false } };

import { createHmac } from 'crypto';

const SB_URL = 'https://mjkjubctswjwjihxjpnd.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1qa2p1YmN0c3dqd2ppaHhqcG5kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczNjQxNjcsImV4cCI6MjA5Mjk0MDE2N30.cZrD_ymrDsRPyfX_g3hUui5_JXuW6BgE77QkIoGpqHo';

function readRaw(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}
async function sb(path, method, body) {
  const r = await fetch(SB_URL + '/rest/v1/' + path, {
    method: method || 'GET',
    headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.ok ? r.json().catch(() => null) : null;
}
function digits(s) { return (s || '').toString().replace(/\D/g, ''); }
function xml(res, body) { res.setHeader('Content-Type', 'text/xml'); res.status(200).end('<?xml version="1.0" encoding="UTF-8"?>' + body); }

// Match an inbound number to a factory by comparing the last 10 digits against
// telephone / sales_mobile / sales_whatsapp.
async function matchFactory(fromNumber) {
  const tail = digits(fromNumber).slice(-10);
  if (!tail) return null;
  const rows = await sb('factories?select=id,telephone,sales_mobile,sales_whatsapp&limit=5000');
  if (!Array.isArray(rows)) return null;
  const hit = rows.find((f) => [f.telephone, f.sales_mobile, f.sales_whatsapp].some((p) => p && digits(p).slice(-10) === tail));
  return hit ? hit.id : null;
}

// Expected Twilio request signature: base64(HMAC-SHA1(authToken, url + sorted
// concatenated POST params)). Compare against the X-Twilio-Signature header.
function expectedSignature(token, url, params) {
  let data = url;
  Object.keys(params).sort().forEach((k) => { data += k + params[k]; });
  return createHmac('sha1', token).update(Buffer.from(data, 'utf-8')).digest('base64');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).end(); return; }

  const raw = await readRaw(req);
  const params = {};
  new URLSearchParams(raw).forEach((v, k) => { params[k] = v; });

  // Optional signature check
  if (process.env.TWILIO_VALIDATE_SIGNATURE === 'true' && process.env.TWILIO_AUTH_TOKEN) {
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const fullUrl = proto + '://' + req.headers.host + req.url;
    const expected = expectedSignature(process.env.TWILIO_AUTH_TOKEN, fullUrl, params);
    if (req.headers['x-twilio-signature'] !== expected) { res.status(403).end('Invalid signature'); return; }
  }

  const TO = process.env.TWILIO_PHONE_NUMBER || params.To || '';
  const isTranscription = (req.url || '').includes('event=transcription') || params.TranscriptionText != null || params.TranscriptionStatus != null;

  try {
    // ── Voice transcription callback ──
    if (isTranscription) {
      const callSid = params.CallSid || '';
      const text = params.TranscriptionText || '';
      if (callSid) {
        await sb('twilio_communications?twilio_sid=eq.' + encodeURIComponent(callSid) + '&channel=eq.voice', 'PATCH',
          { body: text ? ('Voicemail transcript: ' + text) : 'Voicemail received (no transcript available).', status: 'transcribed' });
      }
      res.status(200).end('');
      return;
    }

    // ── Inbound SMS ──
    const isSms = params.Body != null && (params.MessageSid || params.SmsSid || params.SmsMessageSid);
    if (isSms) {
      const from = params.From || '';
      const factory_id = await matchFactory(from);
      await sb('twilio_communications', 'POST', {
        factory_id, direction: 'inbound', channel: 'sms',
        to_number: TO, from_number: from, body: params.Body || '',
        status: 'received', twilio_sid: params.MessageSid || params.SmsSid || params.SmsMessageSid || null,
      });
      // Auto-reply acknowledgement
      xml(res, '<Response><Message>Thanks — TBG Sourcing received your message and will reply shortly.</Message></Response>');
      return;
    }

    // ── Inbound voice call ──
    if (params.CallSid) {
      const from = params.From || '';
      const factory_id = await matchFactory(from);
      await sb('twilio_communications', 'POST', {
        factory_id, direction: 'inbound', channel: 'voice',
        to_number: TO, from_number: from, body: 'Inbound call — awaiting voicemail/transcription.',
        status: 'received', twilio_sid: params.CallSid,
      });
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const cb = proto + '://' + req.headers.host + '/api/twilio-inbound?event=transcription';
      xml(res,
        '<Response>' +
          '<Say voice="alice">You have reached T B G Sourcing. Please leave a message after the tone, and we will get back to you.</Say>' +
          '<Record maxLength="120" playBeep="true" transcribe="true" transcribeCallback="' + cb.replace(/&/g, '&amp;') + '" />' +
          '<Say voice="alice">We did not receive a recording. Goodbye.</Say>' +
        '</Response>');
      return;
    }

    // Unknown payload — acknowledge so Twilio doesn't retry forever.
    res.status(200).end('');
  } catch (e) {
    // Always 200 to Twilio to avoid retry storms; the error is non-recoverable here.
    res.status(200).end('');
  }
}
