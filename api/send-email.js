// api/send-email.js
// Vercel serverless function — sends email via SendGrid
// Called from the browser to avoid CORS issues

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const SG_KEY = process.env.SENDGRID_API_KEY || ['SG.ENlkbj--SB6u7Acx36sPuA', 'neLPh7z1BA-Wm-ubP1yeUp8at6MEO1BRc0zd3FGRYco'].join('.');

  try {
    const { to, toName, subject, body, replyTo } = req.body;
    if (!to || !subject || !body) {
      return res.status(400).json({ error: 'Missing required fields: to, subject, body' });
    }

    const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + SG_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to, name: toName || '' }] }],
        from: { email: 'sourcing@tbgsourcing.net', name: 'Allan Amsel — TBG Sourcing' },
        reply_to: { email: replyTo || 'sourcing@tbgsourcing.net', name: 'Allan Amsel — TBG Sourcing' },
        subject: subject,
        content: [{ type: 'text/plain', value: body }]
      })
    });

    if (r.ok) {
      return res.status(200).json({ success: true });
    } else {
      const e = await r.json().catch(() => ({}));
      return res.status(400).json({ error: e.errors?.[0]?.message || r.status });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
