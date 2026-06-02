// api/twilio-fax.js
//
// Send a fax via EMAIL-TO-FAX. Twilio Programmable Fax (/v1/Faxes) is
// deprecated on this account ("resource /v1/Faxes was not found"), so instead
// we email the PDF to the Fax.Plus gateway ({digits}@fax.plus) via SendGrid.
// The admin UI uploads the PDF to the public `twilio-fax` Supabase bucket and
// passes its public URL (mediaUrl); we fetch + attach it. Logs to
// twilio_communications.
//
//   POST { to, mediaUrl, factory_id? }
//     → { success:true, status:'sent', via:'email-to-fax', gateway }
//     → on failure: { error, fallback:true, number }  (clear manual-send message)
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

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  const to = (body.to || '').toString().trim();
  const mediaUrl = (body.mediaUrl || '').toString().trim();
  const factory_id = body.factory_id || null;
  if (!to || !mediaUrl) return res.status(400).json({ error: 'Missing "to" or "mediaUrl"' });

  const SENDGRID_KEY = process.env.SENDGRID_API_KEY;
  const FROM_EMAIL = 'sourcing@tbgsourcing.net';
  const digits = to.replace(/\D/g, '');                 // Fax.Plus wants digits-only, no '+'
  const faxAddr = digits + '@fax.plus';
  const fallbackMsg = 'Fax not available — please use Dropbox Fax at fax.plus to send manually to ' + to;
  const fail = async (detail) => {
    try { await logComm({ factory_id, direction: 'outbound', channel: 'fax', to_number: to, from_number: FROM_EMAIL, body: 'Email-to-fax not sent (' + faxAddr + ') — ' + mediaUrl, status: 'failed', twilio_sid: null, has_attachment: true }); } catch {}
    return res.status(502).json({ error: fallbackMsg, fallback: true, number: to, detail: detail || undefined });
  };

  if (!SENDGRID_KEY) return fail('SENDGRID_API_KEY not configured');
  if (!digits) return fail('Invalid fax number');

  try {
    // Fetch the uploaded PDF and attach it to the gateway email.
    const pdfResp = await fetch(mediaUrl);
    if (!pdfResp.ok) return fail('Could not fetch the PDF (' + pdfResp.status + ')');
    const b64 = Buffer.from(await pdfResp.arrayBuffer()).toString('base64');

    const payload = {
      personalizations: [{ to: [{ email: faxAddr }] }],
      from: { email: FROM_EMAIL, name: 'TBG Sourcing' },
      subject: 'Fax to ' + to,
      content: [{ type: 'text/plain', value: 'Fax document attached (sent via the Fax.Plus email-to-fax gateway).' }],
      attachments: [{ content: b64, filename: 'fax-' + digits + '.pdf', type: 'application/pdf', disposition: 'attachment' }],
    };
    const sg = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + SENDGRID_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!sg.ok) {
      const e = await sg.json().catch(() => ({}));
      return fail((e.errors && e.errors[0] && e.errors[0].message) || ('SendGrid ' + sg.status));
    }
    await logComm({ factory_id, direction: 'outbound', channel: 'fax', to_number: to, from_number: FROM_EMAIL, body: 'Email-to-fax via ' + faxAddr + ' — ' + mediaUrl, status: 'sent', twilio_sid: null, has_attachment: true });
    return res.status(200).json({ success: true, status: 'sent', via: 'email-to-fax', gateway: faxAddr });
  } catch (e) {
    return fail(e.message);
  }
}
