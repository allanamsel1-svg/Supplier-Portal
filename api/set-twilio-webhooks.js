// api/set-twilio-webhooks.js
//
// One-off admin utility: set the Voice + Messaging webhooks on the Twilio
// number using the server-side TWILIO_AUTH_TOKEN (the Console UI was erroring).
// Looks up the number SID, updates VoiceUrl/SmsUrl (POST), then fetches the
// number back to verify. Never returns the auth token.
//
//   GET /api/set-twilio-webhooks?confirm=set-webhooks
//
// Remove this route once the webhooks are confirmed.
export const config = { runtime: 'nodejs' };

const TARGET_NUMBER = '+19083125011';
const WEBHOOK_URL = 'https://portal.tbgsourcing.net/api/twilio-inbound';

export default async function handler(req, res) {
  if ((req.query && req.query.confirm) !== 'set-webhooks') {
    return res.status(400).json({ error: 'Add ?confirm=set-webhooks to run.' });
  }
  const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
  const TOKEN = process.env.TWILIO_AUTH_TOKEN;
  if (!ACCOUNT_SID || !TOKEN) return res.status(500).json({ error: 'TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not configured in Vercel env' });
  const auth = 'Basic ' + Buffer.from(ACCOUNT_SID + ':' + TOKEN).toString('base64');
  const base = 'https://api.twilio.com/2010-04-01/Accounts/' + ACCOUNT_SID;

  try {
    // 1. Find the phone-number SID for TARGET_NUMBER.
    const listR = await fetch(base + '/IncomingPhoneNumbers.json?PageSize=1000', { headers: { Authorization: auth } });
    const listD = await listR.json().catch(() => ({}));
    if (!listR.ok) return res.status(listR.status).json({ error: 'List failed', detail: listD && listD.message });
    const match = (listD.incoming_phone_numbers || []).find((n) => n.phone_number === TARGET_NUMBER);
    if (!match) return res.status(404).json({ error: 'Number ' + TARGET_NUMBER + ' not found on this account', available: (listD.incoming_phone_numbers || []).map((n) => n.phone_number) });
    const phoneSid = match.sid;

    // 2. Update Voice + SMS webhooks (POST).
    const params = new URLSearchParams({ VoiceUrl: WEBHOOK_URL, VoiceMethod: 'POST', SmsUrl: WEBHOOK_URL, SmsMethod: 'POST' });
    const upR = await fetch(base + '/IncomingPhoneNumbers/' + phoneSid + '.json', {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const upD = await upR.json().catch(() => ({}));
    if (!upR.ok) return res.status(upR.status).json({ error: 'Update failed', detail: upD && upD.message });

    // 3. Fetch back to verify.
    const verR = await fetch(base + '/IncomingPhoneNumbers/' + phoneSid + '.json', { headers: { Authorization: auth } });
    const v = await verR.json().catch(() => ({}));
    const ok = v.voice_url === WEBHOOK_URL && v.sms_url === WEBHOOK_URL && v.voice_method === 'POST' && v.sms_method === 'POST';
    return res.status(200).json({
      success: ok,
      phone_number: v.phone_number,
      phone_number_sid: phoneSid,
      voice_url: v.voice_url, voice_method: v.voice_method,
      sms_url: v.sms_url, sms_method: v.sms_method,
    });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}
