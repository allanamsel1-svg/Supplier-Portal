// lib/twilio-log.mjs
//
// Shared enriched logger for Twilio communications. Every Twilio proxy
// (sms / voice / fax / whatsapp / inbound) writes through logComm so the
// ML-ready columns are populated consistently:
//   word_count, has_attachment, thread_id, response_time_hours,
//   channel_preference (sentiment_score is left null for later ML).

const SB_URL = 'https://mjkjubctswjwjihxjpnd.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1qa2p1YmN0c3dqd2ppaHhqcG5kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczNjQxNjcsImV4cCI6MjA5Mjk0MDE2N30.cZrD_ymrDsRPyfX_g3hUui5_JXuW6BgE77QkIoGpqHo';

const H = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' };
const digits = (s) => (s || '').toString().replace(/\D/g, '');

async function recentForFactory(factoryId) {
  try {
    const r = await fetch(SB_URL + '/rest/v1/twilio_communications?factory_id=eq.' + factoryId + '&order=created_at.desc&limit=300', { headers: H });
    return r.ok ? await r.json() : [];
  } catch { return []; }
}

// row: { factory_id, direction, channel, to_number, from_number, body, status,
//        twilio_sid, has_attachment? }
export async function logComm(row) {
  const body = row.body || '';
  const word_count = body.trim() ? body.trim().split(/\s+/).length : 0;
  const counterpart = row.direction === 'outbound' ? row.to_number : row.from_number;
  let thread_id = row.factory_id ? String(row.factory_id) : (digits(counterpart).slice(-10) || null);

  let response_time_hours = null;
  let channel_preference = null;

  if (row.factory_id) {
    const rows = await recentForFactory(row.factory_id);
    // response_time_hours: only for an outbound that directly answers the most
    // recent inbound (no outbound has happened since that inbound).
    if (row.direction === 'outbound' && rows.length) {
      const lastInbound = rows.find((r) => r.direction === 'inbound');
      if (lastInbound) {
        const newer = rows.filter((r) => new Date(r.created_at) > new Date(lastInbound.created_at));
        const answeredAlready = newer.some((r) => r.direction === 'outbound');
        if (!answeredAlready) {
          response_time_hours = Math.round(((Date.now() - new Date(lastInbound.created_at).getTime()) / 3600000) * 100) / 100;
        }
      }
    }
    // channel_preference: channel with the lowest average response_time_hours
    // across this factory's history (including the row we're about to write).
    const byChan = {};
    rows.concat([{ channel: row.channel, response_time_hours }]).forEach((r) => {
      if (r.response_time_hours != null && r.channel) (byChan[r.channel] = byChan[r.channel] || []).push(r.response_time_hours);
    });
    let best = null, bestAvg = Infinity;
    Object.keys(byChan).forEach((ch) => {
      const avg = byChan[ch].reduce((a, b) => a + b, 0) / byChan[ch].length;
      if (avg < bestAvg) { bestAvg = avg; best = ch; }
    });
    channel_preference = best;
  }

  const full = {
    factory_id: row.factory_id || null,
    direction: row.direction,
    channel: row.channel,
    to_number: row.to_number || null,
    from_number: row.from_number || null,
    body,
    status: row.status || null,
    twilio_sid: row.twilio_sid || null,
    word_count,
    has_attachment: row.has_attachment != null ? !!row.has_attachment : (row.channel === 'fax'),
    thread_id,
    response_time_hours,
    channel_preference,
    sentiment_score: null,
  };

  try {
    await fetch(SB_URL + '/rest/v1/twilio_communications', {
      method: 'POST',
      headers: { ...H, Prefer: 'return=minimal' },
      body: JSON.stringify(full),
    });
  } catch { /* logging is best-effort */ }
  return full;
}
