// ============================================================
// /api/finalize-po-signature.js
//
// Factory uploads their signed/chopped PDF directly to Supabase storage
// (browser → storage), then calls this endpoint with the resulting URL.
//
// We validate the PO is in 'accepted' state, lock the PDF, fire scorecard
// event, and email the admin.
//
// POST { purchase_order_id, signed_pdf_url, uploaded_by? }
//   → { success: true, purchase_order: {...} }
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
  const signed_pdf_url = body.signed_pdf_url;
  const uploaded_by = (body.uploaded_by || '').trim() || null;

  if (!purchase_order_id) return res.status(400).json({ error: 'Missing purchase_order_id.' });
  if (!signed_pdf_url)    return res.status(400).json({ error: 'Missing signed_pdf_url.' });
  if (!/^https?:\/\//i.test(signed_pdf_url)) {
    return res.status(400).json({ error: 'signed_pdf_url must be an absolute URL.' });
  }

  try {
    // Load the PO
    const poRows = await sb(
      `purchase_orders?id=eq.${purchase_order_id}` +
      `&select=*,factories(factory_name_english,sales_email,sales_contact_name),rfqs(item_description,project_number)`
    );
    if (!poRows || !poRows.length) return res.status(404).json({ error: 'Purchase order not found.' });
    const po = poRows[0];

    if (po.signing_status !== 'accepted') {
      return res.status(400).json({
        error: 'PO must be in "accepted" state before uploading signed PDF. Current: ' + po.signing_status
      });
    }
    if (po.signed_pdf_locked) {
      return res.status(400).json({ error: 'Signed PDF is already locked. Contact admin to unlock if you need to replace.' });
    }

    // Record signed PDF and lock
    const signedAt = new Date().toISOString();
    await sb(`purchase_orders?id=eq.${purchase_order_id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        signing_status: 'signed',
        signed_pdf_url,
        signed_pdf_uploaded_at: signedAt,
        signed_pdf_uploaded_by: uploaded_by,
        signed_pdf_locked: true,
        updated_at: signedAt
      })
    });

    // Scorecard event
    try {
      await sb('factory_events', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          factory_id: po.factory_id,
          event_type: 'po_signed',
          event_data: {
            po_id: purchase_order_id,
            po_number: po.po_number,
            time_to_sign_hours: po.factory_accepted_at
              ? Math.round((new Date(signedAt) - new Date(po.factory_accepted_at)) / 3600000)
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
      const subject = `PO ${po.po_number} FULLY EXECUTED by ${factory.factory_name_english || 'factory'}`;
      const emailBody =
        `${factory.factory_name_english || 'A factory'} has uploaded the signed/chopped PDF for PO ${po.po_number}.\n\n` +
        `Item: ${rfq.item_description || ''}\n` +
        `Project: ${rfq.project_number || ''}\n` +
        `Signed PDF: ${signed_pdf_url}\n\n` +
        `This PO is now fully executed. Production milestone tracking should begin.`;
      await sendEmail(ADMIN_EMAIL, 'Admin', subject, emailBody);
    } catch (emailErr) {
      console.log('admin notification failed (non-fatal):', emailErr.message);
    }

    return res.status(200).json({
      success: true,
      purchase_order: {
        ...po,
        signing_status: 'signed',
        signed_pdf_url,
        signed_pdf_uploaded_at: signedAt,
        signed_pdf_locked: true
      }
    });
  } catch (err) {
    console.error('finalize-po-signature error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}

module.exports = handler;
module.exports.default = handler;
