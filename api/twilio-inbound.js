// api/twilio-inbound.js
//
// Webhook for inbound WhatsApp / SMS / voice to the TWILIO_PHONE_NUMBER, plus
// the voice transcription callback. Configure BOTH the Messaging and Voice
// webhooks of the Twilio number to POST here:
//   https://portal.tbgsourcing.net/api/twilio-inbound
//
// Routing:
//   • Inbound WhatsApp (From has a "whatsapp:" prefix) → log channel=whatsapp,
//     auto-reply acknowledgement.
//   • Inbound SMS → log channel=sms, auto-reply acknowledgement.
//   • Inbound voice → log channel=voice, answer with TwiML that records a
//     voicemail with transcription (transcribeCallback points back here).
//   • Transcription callback (?event=transcription) → update the voice row body.
//
// Sender is matched to a factory by last-10-digits across telephone /
// sales_mobile / sales_whatsapp (the whatsapp: prefix is stripped first).
// Signature validation is enforced only when TWILIO_VALIDATE_SIGNATURE=true.
export const config = { api: { bodyParser: false } };

import { createHmac } from 'crypto';
import { logComm } from '../lib/twilio-log.mjs';

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
const digits = (s) => (s || '').toString().replace(/\D/g, '');
const stripWa = (s) => (s || '').toString().replace(/^whatsapp:/, '').trim();
function xml(res, b) { res.setHeader('Content-Type', 'text/xml'); res.status(200).end('<?xml version="1.0" encoding="UTF-8"?>' + b); }

async function matchFactory(fromNumber) {
  const tail = digits(stripWa(fromNumber)).slice(-10);
  if (!tail) return null;
  try {
    const r = await fetch(SB_URL + '/rest/v1/factories?select=id,telephone,sales_mobile,sales_whatsapp&limit=5000', { headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY } });
    const rows = r.ok ? await r.json() : [];
    const hit = (Array.isArray(rows) ? rows : []).find((f) => [f.telephone, f.sales_mobile, f.sales_whatsapp].some((p) => p && digits(p).slice(-10) === tail));
    return hit ? hit.id : null;
  } catch { return null; }
}

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

  if (process.env.TWILIO_VALIDATE_SIGNATURE === 'true' && process.env.TWILIO_AUTH_TOKEN) {
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const fullUrl = proto + '://' + req.headers.host + req.url;
    if (req.headers['x-twilio-signature'] !== expectedSignature(process.env.TWILIO_AUTH_TOKEN, fullUrl, params)) {
      res.status(403).end('Invalid signature'); return;
    }
  }

  const TO = stripWa(params.To) || process.env.TWILIO_PHONE_NUMBER || '';
  const FROM = params.From || '';
  const isWhatsApp = FROM.startsWith('whatsapp:') || (params.To || '').startsWith('whatsapp:');
  const isTranscription = (req.url || '').includes('event=transcription') || params.TranscriptionText != null || params.TranscriptionStatus != null;

  try {
    // ── Voice transcription callback ──
    if (isTranscription) {
      const callSid = params.CallSid || '';
      const text = params.TranscriptionText || '';
      if (callSid) {
        await fetch(SB_URL + '/rest/v1/twilio_communications?twilio_sid=eq.' + encodeURIComponent(callSid) + '&channel=eq.voice', {
          method: 'PATCH',
          headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({ body: text ? ('Voicemail transcript: ' + text) : 'Voicemail received (no transcript available).', status: 'transcribed', word_count: text ? text.trim().split(/\s+/).length : 0 }),
        });
      }
      res.status(200).end('');
      return;
    }

    // ── Inbound WhatsApp / SMS ──
    const isMessage = params.Body != null && (params.MessageSid || params.SmsSid || params.SmsMessageSid);
    if (isMessage) {
      const channel = isWhatsApp ? 'whatsapp' : 'sms';
      const factory_id = await matchFactory(FROM);
      await logComm({
        factory_id, direction: 'inbound', channel,
        to_number: TO, from_number: stripWa(FROM), body: params.Body || '',
        status: 'received', twilio_sid: params.MessageSid || params.SmsSid || params.SmsMessageSid || null,
        has_attachment: parseInt(params.NumMedia || '0', 10) > 0,
      });
      const ack = isWhatsApp
        ? 'Thanks — TBG Sourcing received your WhatsApp message and will reply shortly.'
        : 'Thanks — TBG Sourcing received your message and will reply shortly.';
      xml(res, '<Response><Message>' + ack + '</Message></Response>');
      return;
    }

    // ── Inbound voice ──
    if (params.CallSid) {
      const factory_id = await matchFactory(FROM);
      await logComm({
        factory_id, direction: 'inbound', channel: 'voice',
        to_number: TO, from_number: stripWa(FROM), body: 'Inbound call — awaiting voicemail/transcription.',
        status: 'received', twilio_sid: params.CallSid,
      });
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const cb = (proto + '://' + req.headers.host + '/api/twilio-inbound?event=transcription').replace(/&/g, '&amp;');
      xml(res,
        '<Response>' +
          '<Say voice="alice">You have reached T B G Sourcing. Please leave a message after the tone, and we will get back to you.</Say>' +
          '<Record maxLength="120" playBeep="true" transcribe="true" transcribeCallback="' + cb + '" />' +
          '<Say voice="alice">We did not receive a recording. Goodbye.</Say>' +
        '</Response>');
      return;
    }

    res.status(200).end('');
  } catch (e) {
    res.status(200).end(''); // always 200 to avoid Twilio retry storms
  }
}
