// ============================================================
// /api/inspection-confirm-request.js
// Emails the factory a confirmation request for an upcoming inspection and
// records the send in inspection_confirmations.
// Called by the admin page (manual "Send Now") and by cron-inspection-reminders.
//
// POST { inspection_id, days_before }
//   → { sent: true, to: email }
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SENDGRID_API_KEY, PUBLIC_BASE_URL (optional)
// ============================================================
export const config = { runtime: 'nodejs' };

const SB_URL = process.env.SUPABASE_URL || 'https://mjkjubctswjwjihxjpnd.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
const SG_KEY = process.env.SENDGRID_API_KEY;
const BASE = process.env.PUBLIC_BASE_URL || 'https://portal.tbgsourcing.net';
const FROM = 'sourcing@tbgsourcing.net';
const SBH = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' };

function readBody(req) {
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
  return b || {};
}
async function sbGet(path) {
  const r = await fetch(SB_URL + '/rest/v1/' + path, { headers: SBH });
  if (!r.ok) return [];
  const d = await r.json();
  return Array.isArray(d) ? d : [];
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

async function sendEmail(to, subject, html) {
  if (!SG_KEY) throw new Error('SENDGRID_API_KEY not set');
  const payload = {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: FROM, name: 'TBG Sourcing' },
    reply_to: { email: FROM, name: 'TBG Sourcing' },
    subject,
    content: [{ type: 'text/html', value: html }],
  };
  const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST', headers: { Authorization: 'Bearer ' + SG_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error('SendGrid ' + r.status + ': ' + (await r.text()).slice(0, 200));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!SB_KEY) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not set.' });

  const { inspection_id, days_before } = readBody(req);
  if (!inspection_id) return res.status(400).json({ error: 'Missing inspection_id.' });

  try {
    const rows = await sbGet('inspections?id=eq.' + encodeURIComponent(inspection_id) +
      '&select=id,scheduled_date,inspection_type,inspector_company,aql_level,inspection_level,po_id,factory_id,purchase_orders(po_number),factories(factory_name_english,sales_email,sales_contact_name)&limit=1');
    if (!rows.length) return res.status(404).json({ error: 'Inspection not found.' });
    const insp = rows[0];
    const factory = insp.factories || {};
    const po = insp.purchase_orders || {};
    const email = factory.sales_email;
    if (!email) return res.status(400).json({ error: 'Factory has no contact email (factories.sales_email).' });

    const poNum = po.po_number || insp.po_id || '—';
    const confirmUrl = BASE + '/factory-inspection-confirm.html?inspection_id=' + encodeURIComponent(insp.id);
    const subject = `Inspection Confirmation Required — PO ${poNum} — ${days_before != null ? days_before + ' days' : 'upcoming'}`;
    const html = `
      <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;color:#1a1a2e;">
        <h2 style="font-size:18px;">Inspection Confirmation Required</h2>
        <p>Dear ${esc((factory.sales_contact_name || '').split(' ')[0] || 'Partner')},</p>
        <p>An inspection is scheduled for the following order. Please confirm whether the goods will be ready.</p>
        <table style="font-size:14px;border-collapse:collapse;margin:14px 0;">
          <tr><td style="padding:4px 12px 4px 0;color:#888;">PO Number</td><td style="padding:4px 0;font-weight:600;">${esc(poNum)}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#888;">Factory</td><td style="padding:4px 0;">${esc(factory.factory_name_english || '—')}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#888;">Type</td><td style="padding:4px 0;">${esc(insp.inspection_type || '—')}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#888;">Scheduled Date</td><td style="padding:4px 0;font-weight:600;">${esc(insp.scheduled_date || '—')}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#888;">Inspector</td><td style="padding:4px 0;">${esc(insp.inspector_company || 'TBD')}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#888;">AQL Level</td><td style="padding:4px 0;">${esc(insp.aql_level != null ? insp.aql_level : '—')}${insp.inspection_level ? ' / Level ' + esc(insp.inspection_level) : ''}</td></tr>
        </table>
        <p style="margin:18px 0;">
          <a href="${confirmUrl}" style="display:inline-block;background:#1a7a1a;color:#fff;text-decoration:none;padding:11px 22px;border-radius:8px;font-weight:600;">✓ Confirm — Goods will be ready</a>
          &nbsp;
          <a href="${confirmUrl}" style="display:inline-block;background:#b00;color:#fff;text-decoration:none;padding:11px 22px;border-radius:8px;font-weight:600;">⚠ Flag an Issue</a>
        </p>
        <p style="font-size:12px;color:#888;">Or open the confirmation page: <a href="${confirmUrl}">${confirmUrl}</a></p>
        <p style="font-size:12px;color:#888;">— TBG Sourcing</p>
      </div>`;

    await sendEmail(email, subject, html);

    // Record the send.
    await fetch(SB_URL + '/rest/v1/inspection_confirmations', {
      method: 'POST', headers: { ...SBH, Prefer: 'return=minimal' },
      body: JSON.stringify({ inspection_id: insp.id, sent_at: new Date().toISOString(), days_before: days_before != null ? days_before : null }),
    }).catch(() => {});

    return res.status(200).json({ sent: true, to: email });
  } catch (err) {
    console.error('inspection-confirm-request error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
