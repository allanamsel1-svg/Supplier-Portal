// api/_faxtest.js — TEMPORARY diagnostic. Tests Twilio Programmable Fax at the
// correct base URL (fax.twilio.com/v1/Faxes). Returns the exact Twilio response.
// Remove after diagnosis.
export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if ((req.query && req.query.run) !== 'faxtest') return res.status(400).json({ error: 'add ?run=faxtest' });

  const SID = process.env.TWILIO_ACCOUNT_SID, TOKEN = process.env.TWILIO_AUTH_TOKEN;
  const FROM = process.env.TWILIO_PHONE_NUMBER || '+19083125011';
  if (!SID || !TOKEN) return res.status(500).json({ error: 'Twilio env not configured', hasSID: !!SID, hasTOKEN: !!TOKEN });

  const params = new URLSearchParams({
    From: FROM,
    To: '+18596695748',
    MediaUrl: 'https://www.twilio.com/docs/documents/25/justthefaxmaam.pdf',
  });
  try {
    const r = await fetch('https://fax.twilio.com/v1/Faxes', {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(SID + ':' + TOKEN).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return res.status(200).json({
      requestFrom: FROM, requestTo: '+18596695748',
      httpStatus: r.status, ok: r.ok,
      response: json || text,
    });
  } catch (e) {
    return res.status(200).json({ fetchError: e.message });
  }
}
