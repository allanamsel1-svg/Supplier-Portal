// ============================================================
// /api/check-po-milestone-reminders.js
// Daily cron — sends 3 distinct reminder patterns:
//   1. Factory sample submission: 10/3/0 days before committed date
//   2. Admin sample evaluation overdue: alerts admin when a sample
//      has been in 'awaiting_approval' status > 5 business days
//   3. Production milestones: 10/3/0 days to factory + admin
//
// Dedups via po_milestone_reminders table.
//
// Trigger via Vercel cron daily (e.g., 08:00 UTC).
// Manual trigger: POST with no body.
//
// Env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SENDGRID_API_KEY
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SG_KEY = process.env.SENDGRID_API_KEY;
const ADMIN_EMAIL = process.env.ADMIN_NOTIFICATION_EMAIL || 'sourcing@tbgsourcing.net';
const FROM_EMAIL = 'sourcing@tbgsourcing.net';
const FROM_NAME = 'Tyler Durden';
const PORTAL_URL = 'https://portal.tbgsourcing.net/index.html';
const ADMIN_PORTAL_URL = 'https://portal.tbgsourcing.net/admin.html';

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
  return res.status === 204 ? null : await res.json();
}

// Resolve the right factory contact for a given role from factory_contacts.
// role 'logistics' -> logistics contact if one exists, else the sales/primary
// contact. Falls back to the embedded factories.sales_* fields if the
// factory_contacts lookup returns nothing (so this can never lose a recipient).
async function contactFor(factoryId, role, fallback) {
  fallback = fallback || {};
  const fb = { email: fallback.sales_email || null, name: fallback.sales_contact_name || 'Team' };
  if (!factoryId) return fb;
  try {
    const rows = await sb(`factory_contacts?factory_id=eq.${factoryId}&select=contact_name,email,is_sales,is_logistics,is_principal,is_primary`);
    if (!rows || !rows.length) return fb;
    let pick = null;
    if (role === 'logistics') pick = rows.find(c => c.is_logistics && c.email);
    if (!pick) pick = rows.find(c => c.is_sales && c.email) || rows.find(c => c.is_primary && c.email);
    if (pick && pick.email) return { email: pick.email, name: pick.contact_name || 'Team' };
  } catch (e) { /* fall through to fallback */ }
  return fb;
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

function daysUntil(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return Math.round((d - today) / 86400000);
}

function businessDaysBetween(date1, date2) {
  // Approximation: divide by 7, multiply by 5
  const days = Math.abs((date2 - date1) / 86400000);
  return Math.round(days * 5 / 7);
}

function bucketFor(daysAway) {
  if (daysAway === 0) return 'day_of';
  if (daysAway === 3) return '3_day';
  if (daysAway === 10) return '10_day';
  if (daysAway < 0) return 'overdue';
  return null;
}

async function handler(req, res) {
  // Allow GET (cron) and POST (manual)
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Missing SUPABASE env vars' });
  }

  const summary = {
    sample_submission_reminders: 0,
    admin_evaluation_alerts: 0,
    production_milestone_reminders: 0,
    sent_emails: [],
    errors: []
  };

  try {
    // ─── PATTERN 1: Factory sample submission reminders ───
    // PD items in 'awaiting_initial_sample' or 'in_revision' with a committed sample date
    // We compute the expected submission date = accepted_at + quote_sample_submission_days
    const pdItems = await sb(
      'product_development_items?status=in.(awaiting_initial_sample,in_revision)' +
      '&select=id,factory_id,accepted_at,quote_sample_submission_days,rfqs(item_description),factories(factory_name_english,sales_email,sales_contact_name)'
    );
    for (const pd of (pdItems || [])) {
      if (!pd.quote_sample_submission_days || !pd.accepted_at) continue;
      const expectedDate = new Date(new Date(pd.accepted_at).getTime() + pd.quote_sample_submission_days * 86400000);
      const expectedStr = expectedDate.toISOString().slice(0, 10);
      const daysAway = daysUntil(expectedStr);
      const bucket = bucketFor(daysAway);
      if (!bucket) continue;

      const f = pd.factories || {};
      const rfq = pd.rfqs || {};
      if (!f.sales_email) continue;

      // Dedup: check we haven't already sent this exact bucket for this PD item
      // We reuse po_milestone_reminders by using pd-prefixed milestone IDs
      // Actually simpler: dedup by factory event log
      const dedupCheck = await sb(
        'factory_events?factory_id=eq.' + pd.factory_id +
        '&event_type=eq.invitation_reminder_sent' +
        "&event_data->>product_development_id=eq." + pd.id +
        "&event_data->>bucket=eq." + bucket +
        '&select=id&limit=1'
      );
      if (dedupCheck && dedupCheck.length) continue;

      const itemDesc = rfq.item_description || 'sample';
      const firstName = (f.sales_contact_name || 'Team').split(/\s+/)[0];
      const subj = bucket === 'overdue'
        ? `Sample submission overdue — ${itemDesc}`
        : `Sample submission due ${bucket === 'day_of' ? 'today' : 'in ' + daysAway + ' days'} — ${itemDesc}`;
      const body = `Dear ${firstName},

This is a reminder that you committed to ship samples for ${itemDesc} by ${expectedStr}${bucket === 'overdue' ? ' — that date has now passed' : ''}.

Please log in to the supplier portal to mark the sample as shipped once you have the tracking number:

${PORTAL_URL}

If circumstances have changed and you need to adjust the timeline, please log in and submit a timeline change request.

Best regards,
Tyler Durden
Sourcing Manager, TBG Sourcing
${FROM_EMAIL}`;

      const send = await sendEmail(f.sales_email, f.sales_contact_name || '', subj, body);
      if (send.ok) {
        summary.sample_submission_reminders++;
        summary.sent_emails.push({ to: f.sales_email, type: 'sample_submission_' + bucket });
        // Log dedup marker
        fetch(`${SUPABASE_URL}/rest/v1/factory_events`, {
          method: 'POST',
          headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({ factory_id: pd.factory_id, event_type: 'invitation_reminder_sent', event_data: { product_development_id: pd.id, bucket, days_away: daysAway }, actor_type: 'system' })
        }).catch(() => {});
      } else {
        summary.errors.push({ to: f.sales_email, error: send.error });
      }
    }

    // ─── PATTERN 2: Admin sample evaluation overdue alerts ───
    // PD items in 'awaiting_approval' status for > 5 business days, but only alert once per item per week
    const fiveBusinessDaysMs = 7 * 86400000;  // ~5 business days is 7 calendar days
    const evalQueue = await sb(
      'product_development_items?status=eq.awaiting_approval' +
      '&select=id,factory_id,updated_at,rfqs(item_description),factories(factory_name_english),sample_submissions(id,version_number,submitted_at)'
    );
    for (const pd of (evalQueue || [])) {
      const updatedAt = new Date(pd.updated_at);
      if (Date.now() - updatedAt.getTime() < fiveBusinessDaysMs) continue;
      // Dedup: only once per week per PD item
      const oneWeekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      const recentAlert = await sb(
        'factory_events?factory_id=eq.' + pd.factory_id +
        '&event_type=eq.system_warning' +
        "&event_data->>product_development_id=eq." + pd.id +
        '&occurred_at=gte.' + oneWeekAgo +
        '&select=id&limit=1'
      );
      if (recentAlert && recentAlert.length) continue;

      const f = pd.factories || {};
      const rfq = pd.rfqs || {};
      const itemDesc = rfq.item_description || 'item';
      const daysWaiting = Math.floor((Date.now() - updatedAt.getTime()) / 86400000);

      const body = `A sample has been awaiting your evaluation for ${daysWaiting} days:

Factory: ${f.factory_name_english || '(unknown)'}
Product: ${itemDesc}

Open the Product Development panel in admin to review:
${ADMIN_PORTAL_URL}

The factory is waiting for your decision (approve, revise, or reject).`;

      const send = await sendEmail(ADMIN_EMAIL, 'Admin', `Sample awaiting your decision (${daysWaiting} days) — ${itemDesc}`, body);
      if (send.ok) {
        summary.admin_evaluation_alerts++;
        summary.sent_emails.push({ to: ADMIN_EMAIL, type: 'admin_eval_overdue' });
        fetch(`${SUPABASE_URL}/rest/v1/factory_events`, {
          method: 'POST',
          headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({ factory_id: pd.factory_id, event_type: 'system_warning', event_data: { product_development_id: pd.id, type: 'eval_overdue', days_waiting: daysWaiting }, actor_type: 'system' })
        }).catch(() => {});
      } else {
        summary.errors.push({ to: ADMIN_EMAIL, error: send.error });
      }
    }

    // ─── PATTERN 3: Production milestone reminders ───
    // For each milestone in pending/at_risk status, send 10/3/0-day notices
    // to both factory AND admin
    const milestones = await sb(
      'po_milestones?status=in.(pending,at_risk)' +
      '&select=id,milestone_type,agreed_date,revised_date,purchase_order_id,purchase_orders(po_number,factories(factory_name_english,sales_email,sales_contact_name,id),rfqs(item_description))'
    );
    for (const m of (milestones || [])) {
      const dueDate = m.revised_date || m.agreed_date;
      if (!dueDate) continue;
      const daysAway = daysUntil(dueDate);
      const bucket = bucketFor(daysAway);
      if (!bucket || bucket === 'overdue') continue;

      const po = m.purchase_orders || {};
      const f = po.factories || {};
      const rfq = po.rfqs || {};
      const itemDesc = rfq.item_description || 'production';
      const msLabel = ({
        sample_submission: 'sample submission',
        materials_on_hand: 'materials on hand',
        mass_production_start: 'mass production start',
        mass_production_end: 'mass production end',
        inspection: 'pre-shipment inspection',
        cargo_ready: 'cargo ready'
      })[m.milestone_type] || m.milestone_type;

      // Dedup using po_milestone_reminders for factory recipient
      try {
        const dedupF = await sb('po_milestone_reminders?po_milestone_id=eq.' + m.id + '&reminder_type=eq.' + bucket + '&recipient_type=eq.factory&select=id&limit=1');
        if (!dedupF || !dedupF.length) {
          // Production/shipping milestone -> route to logistics contact if one exists, else sales.
          const recip = await contactFor(f.id, 'logistics', f);
          if (recip.email) {
            const firstName = (recip.name || 'Team').split(/\s+/)[0];
            const subj = bucket === 'day_of' ? `${msLabel} due today — ${itemDesc}` : `${msLabel} due in ${daysAway} days — ${itemDesc}`;
            const body = `Dear ${firstName},

The ${msLabel} milestone on PO ${po.po_number || ''} (${itemDesc}) is due ${bucket === 'day_of' ? 'today' : 'in ' + daysAway + ' days'} (${dueDate}).

Please log in to the supplier portal to confirm you are on schedule, or flag a delay if circumstances have changed:

${PORTAL_URL}

Best regards,
Tyler Durden
Sourcing Manager, TBG Sourcing
${FROM_EMAIL}`;
            const send = await sendEmail(recip.email, recip.name || '', subj, body);
            if (send.ok) {
              summary.production_milestone_reminders++;
              summary.sent_emails.push({ to: recip.email, type: 'milestone_' + bucket + '_factory' });
              fetch(`${SUPABASE_URL}/rest/v1/po_milestone_reminders`, {
                method: 'POST',
                headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
                body: JSON.stringify({ po_milestone_id: m.id, reminder_type: bucket, recipient_type: 'factory', recipient_email: recip.email, delivery_status: 'sent' })
              }).catch(() => {});
            } else {
              summary.errors.push({ to: recip.email, error: send.error });
            }
          }
        }
      } catch (e) { summary.errors.push({ milestone_id: m.id, error: e.message }); }

      // Admin reminder (day_of and 3_day only — skip 10_day to reduce noise)
      if (bucket === 'day_of' || bucket === 'overdue') {
        try {
          const dedupA = await sb('po_milestone_reminders?po_milestone_id=eq.' + m.id + '&reminder_type=eq.' + bucket + '&recipient_type=eq.admin&select=id&limit=1');
          if (!dedupA || !dedupA.length) {
            const subj = `${msLabel} ${bucket === 'day_of' ? 'due today' : 'overdue'} — PO ${po.po_number || ''}`;
            const body = `Milestone status check:

PO: ${po.po_number || ''}
Factory: ${f.factory_name_english || '(unknown)'}
Product: ${itemDesc}
Milestone: ${msLabel}
Due: ${dueDate}

Open the admin portal to review and follow up:
${ADMIN_PORTAL_URL}`;
            const send = await sendEmail(ADMIN_EMAIL, 'Admin', subj, body);
            if (send.ok) {
              summary.production_milestone_reminders++;
              summary.sent_emails.push({ to: ADMIN_EMAIL, type: 'milestone_' + bucket + '_admin' });
              fetch(`${SUPABASE_URL}/rest/v1/po_milestone_reminders`, {
                method: 'POST',
                headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
                body: JSON.stringify({ po_milestone_id: m.id, reminder_type: bucket, recipient_type: 'admin', recipient_email: ADMIN_EMAIL, delivery_status: 'sent' })
              }).catch(() => {});
            } else {
              summary.errors.push({ to: ADMIN_EMAIL, error: send.error });
            }
          }
        } catch (e) { summary.errors.push({ milestone_id: m.id, error: e.message }); }
      }
    }

    return res.status(200).json({ success: true, summary });
  } catch (err) {
    console.error('check-po-milestone-reminders error:', err);
    return res.status(500).json({ error: String(err.message || err), summary });
  }
}

module.exports = handler;
module.exports.default = handler;
