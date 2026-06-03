// api/wadiag.js — TEMPORARY diagnostic. Inspects the Twilio account's WhatsApp /
// messaging configuration so we can find where the inbound WhatsApp webhook
// must be set. Remove after diagnosis.
export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if ((req.query && req.query.run) !== 'wadiag') return res.status(400).json({ error: 'add ?run=wadiag' });

  const SID = process.env.TWILIO_ACCOUNT_SID, TOKEN = process.env.TWILIO_AUTH_TOKEN;
  if (!SID || !TOKEN) return res.status(500).json({ error: 'Twilio env not configured' });
  const auth = 'Basic ' + Buffer.from(SID + ':' + TOKEN).toString('base64');
  const get = async (url) => {
    try { const r = await fetch(url, { headers: { Authorization: auth } }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { status: r.status, body: j || t }; }
    catch (e) { return { error: e.message }; }
  };

  const out = {};
  // Messaging Services (production WhatsApp senders attach here, each has an inbound_request_url)
  const svc = await get('https://messaging.twilio.com/v1/Services?PageSize=20');
  out.messagingServices = (svc.body && svc.body.services) ? svc.body.services.map((s) => ({ sid: s.sid, friendly_name: s.friendly_name, inbound_request_url: s.inbound_request_url, inbound_method: s.inbound_method, use_inbound_webhook_on_number: s.use_inbound_webhook_on_number })) : svc;
  // Incoming phone numbers + their SMS webhook
  const nums = await get('https://api.twilio.com/2010-04-01/Accounts/' + SID + '/IncomingPhoneNumbers.json?PageSize=20');
  out.numbers = (nums.body && nums.body.incoming_phone_numbers) ? nums.body.incoming_phone_numbers.map((n) => ({ phone: n.phone_number, sms_url: n.sms_url, sms_method: n.sms_method, voice_url: n.voice_url })) : nums;
  // WhatsApp senders (production)
  out.whatsappSenders = await get('https://messaging.twilio.com/v2/Channels/Senders?PageSize=20');

  return res.status(200).json(out);
}
