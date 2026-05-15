// ============================================================
// /api/accept-po.js
//
// Factory clicks "Accept" on the PO contract in their portal.
// Captures digital acceptance audit trail (timestamp, IP, user agent,
// who clicked, what version of the PO).
//
// POST { purchase_order_id, accepted_by_name }
//   → { success: true, purchase_order: {...} }
//
// Validates:
//   - PO exists
//   - signing_status is 'sent_to_factory' (not already accepted/signed)
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SG_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'sourcing@tbgsourcing.net';
const FROM_NAME = 'Tyler Durden';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'sourcing@tbgsourcing.net';

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Supabase ${res.status}: ${txt}`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text || !text.trim()) return null;
  try { return JSON.parse(text); }
  catch (e) { throw new Error(`Supabase non-JSON: ${text.slice(0, 200)}`); }
}

async function sendEmail(toEmail, toName, subject, body) {
  if (!SG_KEY) return { ok: false, error: 'SENDGRID_API_KEY not set' };
  try {
    const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + SG_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: toEmail, name: toName || '' }] }],
        from: { email: FROM_EMAIL, name: FROM_NAME },
        reply_to: { email: FROM_EMAIL, name: FROM_NAME },
        subject,
        content: [{ type: 'text/plain', value: body }]
      })
    });
    if (r.ok) return { ok: true };
    const e = await r.json().catch(() => ({}));
    return { ok: false, error: (e.errors && e.errors[0] && e.errors[0].message) || 'HTTP ' + r.status };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const purchase_order_id = body.purchase_order_id;
  const accepted_by_name = (body.accepted_by_name || '').trim();

  if (!purchase_order_id) return res.status(400).json({ error: 'Missing purchase_order_id.' });
  if (!accepted_by_name)  return res.status(400).json({ error: 'Missing accepted_by_name (factory contact who is accepting).' });

  try {
    // Load the PO
    const poRows = await sb(
      `purchase_orders?id=eq.${purchase_order_id}` +
      `&select=*,factories(factory_name_english,sales_email,sales_contact_name),rfqs(item_description,project_number)`
    );
    if (!poRows || !poRows.length) return res.status(404).json({ error: 'Purchase order not found.' });
    const po = poRows[0];

    // Validate signing state
    if (po.signing_status !== 'sent_to_factory') {
      return res.status(400).json({
        error: 'PO cannot be accepted in current state (' + po.signing_status + '). Expected: sent_to_factory.'
      });
    }

    // Capture audit trail
    const acceptedAt = new Date().toISOString();
    const ipFromHeaders = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '';
    const ip = (Array.isArray(ipFromHeaders) ? ipFromHeaders[0] : ipFromHeaders.split(',')[0]).trim() || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';

    await sb(`purchase_orders?id=eq.${purchase_order_id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        signing_status: 'accepted',
        factory_accepted_at: acceptedAt,
        factory_accepted_by_name: accepted_by_name,
        factory_accepted_ip: ip,
        factory_accepted_user_agent: userAgent.slice(0, 500),
        factory_accepted_pdf_version: po.po_template_version || 'v1-placeholder',
        updated_at: acceptedAt
      })
    });

    // Scorecard event
    try {
      await sb('factory_events', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          factory_id: po.factory_id,
          event_type: 'po_accepted',
          event_data: {
            po_id: purchase_order_id,
            po_number: po.po_number,
            accepted_by_name,
            time_to_accept_hours: po.sent_to_factory_at
              ? Math.round((new Date(acceptedAt) - new Date(po.sent_to_factory_at)) / 3600000)
              : null
          },
          actor_type: 'factory'
        })
      });
    } catch (eventErr) {
      console.log('factory_events log failed (non-fatal):', eventErr.message);
    }

    // Notify admin
    try {
      const factory = po.factories || {};
      const rfq = po.rfqs || {};
      const subject = `PO ${po.po_number} accepted by ${factory.factory_name_english || 'factory'}`;
      const emailBody =
        `${factory.factory_name_english || 'A factory'} has accepted PO ${po.po_number}.\n\n` +
        `Item: ${rfq.item_description || ''}\n` +
        `Accepted by: ${accepted_by_name}\n` +
        `Accepted at: ${acceptedAt}\n\n` +
        `Awaiting upload of signed/chopped PDF.\n\n` +
        `Project: ${rfq.project_number || ''}`;
      await sendEmail(ADMIN_EMAIL, 'Admin', subject, emailBody);
    } catch (emailErr) {
      console.log('admin notification failed (non-fatal):', emailErr.message);
    }

    return res.status(200).json({
      success: true,
      purchase_order: {
        ...po,
        signing_status: 'accepted',
        factory_accepted_at: acceptedAt,
        factory_accepted_by_name: accepted_by_name
      }
    });
  } catch (err) {
    console.error('accept-po error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}

module.exports = handler;
module.exports.default = handler;
