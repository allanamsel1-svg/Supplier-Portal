// api/twilio-sms.js
//
// Send an outbound SMS via Twilio. Credentials live only in Vercel env vars —
// never client-side. Logs the message to twilio_communications.
//
//   POST { to, message, factory_id? } → { success, sid, status }
export const config = { runtime: 'nodejs' };

async function logComm(row) {
  const SB_URL = 'https://mjkjubctswjwjihxjpnd.supabase.co';
  const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1qa2p1YmN0c3dqd2ppaHhqcG5kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczNjQxNjcsImV4cCI6MjA5Mjk0MDE2N30.cZrD_ymrDsRPyfX_g3hUui5_JXuW6BgE77QkIoGpqHo';
  const H = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' };
  const dig = (s) => (s || '').toString().replace(/\D/g, '');
  const bodyTxt = row.body || '';
  const word_count = bodyTxt.trim() ? bodyTxt.trim().split(/\s+/).length : 0;
  const counterpart = row.direction === 'outbound' ? row.to_number : row.from_number;
  let thread_id = row.factory_id ? String(row.factory_id) : (dig(counterpart).slice(-10) || null);
  let response_time_hours = null, channel_preference = null;
  if (row.factory_id) {
    let rows = [];
    try { const rr = await fetch(SB_URL + '/rest/v1/twilio_communications?factory_id=eq.' + row.factory_id + '&order=created_at.desc&limit=300', { headers: H }); rows = rr.ok ? await rr.json() : []; } catch {}
    if (row.direction === 'outbound' && rows.length) {
      const li = rows.find((r) => r.direction === 'inbound');
      if (li) { const newer = rows.filter((r) => new Date(r.created_at) > new Date(li.created_at)); if (!newer.some((r) => r.direction === 'outbound')) response_time_hours = Math.round(((Date.now() - new Date(li.created_at).getTime()) / 3600000) * 100) / 100; }
    }
    const byChan = {};
    rows.concat([{ channel: row.channel, response_time_hours }]).forEach((r) => { if (r.response_time_hours != null && r.channel) (byChan[r.channel] = byChan[r.channel] || []).push(r.response_time_hours); });
    let best = null, ba = Infinity;
    Object.keys(byChan).forEach((ch) => { const a = byChan[ch], avg = a.reduce((x, y) => x + y, 0) / a.length; if (avg < ba) { ba = avg; best = ch; } });
    channel_preference = best;
  }
  const full = { factory_id: row.factory_id || null, direction: row.direction, channel: row.channel, to_number: row.to_number || null, from_number: row.from_number || null, body: bodyTxt, status: row.status || null, twilio_sid: row.twilio_sid || null, word_count, has_attachment: row.has_attachment != null ? !!row.has_attachment : (row.channel === 'fax'), thread_id, response_time_hours, channel_preference, sentiment_score: null };
  try { await fetch(SB_URL + '/rest/v1/twilio_communications', { method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(full) }); } catch {}
  return full;
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
  const message = (body.message || '').toString();
  const factory_id = body.factory_id || null;
  if (!to || !message) return res.status(400).json({ error: 'Missing "to" or "message"' });

  try {
    const params = new URLSearchParams({ To: to, From: FROM, Body: message });
    const r = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + SID + '/Messages.json', {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(SID + ':' + TOKEN).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ error: (d && d.message) || 'Twilio SMS failed', code: d && d.code });
    await logComm({ factory_id, direction: 'outbound', channel: 'sms', to_number: to, from_number: FROM, body: message, status: d.status || 'queued', twilio_sid: d.sid || null });
    return res.status(200).json({ success: true, sid: d.sid, status: d.status });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}
