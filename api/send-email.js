export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const SG_KEY = process.env.SENDGRID_API_KEY;
  if (!SG_KEY) return res.status(500).json({ error: 'SENDGRID_API_KEY environment variable is not set' });
  try {
    const { to, toName, subject, body, from, replyTo, cc, bcc } = req.body;
    if (!to || !subject || !body) return res.status(400).json({ error: 'Missing required fields' });
    // Sender persona is derived from the sending mailbox:
    //   compliance@ → Tyler Durden (Compliance Manager); everything else → Sarah Lindburg (Sourcing).
    const fromEmail = (from && from.includes('@')) ? from
      : (replyTo && replyTo.includes('@')) ? replyTo
      : 'sourcing@tbgsourcing.net';
    const isCompliance = /compliance@/i.test(fromEmail);
    const fromName = isCompliance ? 'Tyler Durden' : 'Sarah Lindburg';
    const replyToEmail = replyTo && replyTo.includes('@') ? replyTo : fromEmail;
    const payload = {
      personalizations: [{ to: [{ email: to, name: toName || '' }] }],
      from: { email: fromEmail, name: fromName },
      reply_to: { email: replyToEmail, name: fromName },
      subject: subject,
      content: [{ type: 'text/plain', value: body }]
    };
    // CC list. Tyler (compliance) emails always CC Sarah (sourcing@).
    let ccList = (cc && cc.trim()) ? cc.split(',').map(e => e.trim()).filter(Boolean) : [];
    if (isCompliance && !ccList.some(e => /sourcing@tbgsourcing\.net/i.test(e))) {
      ccList.push('sourcing@tbgsourcing.net');
    }
    if (ccList.length) payload.personalizations[0].cc = ccList.map(email => ({ email }));
    if (bcc && bcc.trim()) payload.personalizations[0].bcc = bcc.split(',').map(e => ({ email: e.trim() }));
    const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + SG_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (r.ok) return res.status(200).json({ success: true });
    const e = await r.json().catch(() => ({}));
    return res.status(400).json({ error: e.errors?.[0]?.message || r.status });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
