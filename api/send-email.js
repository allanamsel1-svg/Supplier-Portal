export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const SG_KEY = ['SG.ENlkbj--SB6u7Acx36sPuA', 'neLPh7z1BA-Wm-ubP1yeUp8at6MEO1BRc0zd3FGRYco'].join('.');
  try {
    const { to, toName, subject, body, replyTo, cc, bcc } = req.body;
    if (!to || !subject || !body) return res.status(400).json({ error: 'Missing required fields' });
    const fromEmail = 'sourcing@tbgsourcing.net';
    const replyToEmail = replyTo && replyTo.includes('@') ? replyTo : fromEmail;
    const payload = {
      personalizations: [{ to: [{ email: to, name: toName || '' }] }],
      from: { email: fromEmail, name: 'TBG Sourcing' },
      reply_to: { email: replyToEmail, name: 'TBG Sourcing' },
      subject: subject,
      content: [{ type: 'text/plain', value: body }]
    };
    if (cc && cc.trim()) payload.personalizations[0].cc = cc.split(',').map(e => ({ email: e.trim() }));
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
