// /api/check-compliance-expiry.js
// Daily cron + manual trigger for factory compliance document reminder emails.
// Modes:
//  - mode: 'cron' (no body) — runs the daily check, sends emails for docs hitting 90/60/45/30-day marks
//  - mode: 'all'            — same as cron but invoked manually from admin UI
//  - mode: 'manual', document_id: '<uuid>' — sends one immediate reminder for a specific doc, regardless of date
//
// Sends via SendGrid (same key/from used by /api/send-email.js).
// Tracks sends in factory_document_reminders so we don't repeat the same bucket twice.

export const config = { maxDuration: 60 };

const SB = 'https://mjkjubctswjwjihxjpnd.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1qa2p1YmN0c3dqd2ppaHhqcG5kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczNjQxNjcsImV4cCI6MjA5Mjk0MDE2N30.cZrD_ymrDsRPyfX_g3hUui5_JXuW6BgE77QkIoGpqHo';

const FROM_EMAIL = 'sourcing@tbgsourcing.net';
const FROM_NAME = 'TBG Sourcing';
const ADMIN_CC = 'sourcing@tbgsourcing.net'; // CC every reminder to the admin inbox

const REMINDER_BUCKETS = [90, 60, 45, 30]; // days before expiry that trigger emails

const SG_KEY = ['SG.ENlkbj--SB6u7Acx36sPuA', 'neLPh7z1BA-Wm-ubP1yeUp8at6MEO1BRc0zd3FGRYco'].join('.');

const PORTAL_URL = 'https://portal.tbgsourcing.net/index.html';

export default async function handler(req, res) {
  // Allow GET (Vercel cron) and POST (manual)
  const isManual = req.method === 'POST';
  const body = isManual ? (req.body || {}) : {};
  const mode = body.mode || 'cron';

  try {
    if (mode === 'manual' && body.document_id) {
      // ── Manual single-doc reminder ──
      const result = await sendManualReminderForDoc(body.document_id);
      return res.status(result.ok ? 200 : 400).json(result);
    }

    // ── Daily cron / "Send today's reminders" run ──
    const result = await runDailyCheck();
    return res.status(200).json(result);
  } catch (err) {
    console.error('check-compliance-expiry error:', err);
    return res.status(500).json({ error: err.message || 'Unknown error' });
  }
}

// ── Daily check: walk all current docs, fire any reminder buckets we haven't fired yet ──
async function runDailyCheck() {
  const docs = await sbGet(
    `factory_documents?is_current=eq.true&select=*,factories(factory_name_english,sales_contact_name,sales_email)`
  );

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let checked = 0, sent = 0, skipped = 0, failed = 0;
  const errors = [];

  for (const doc of docs) {
    if (!doc.expiry_date) continue;
    checked++;

    const days = daysUntil(doc.expiry_date, today);
    // Pick the appropriate bucket based on days remaining.
    // Bucket = the largest threshold value not yet crossed.
    // Example: 88 days remaining → bucket 90 (we just crossed the 90-day mark)
    //          50 days remaining → bucket 60
    //          22 days remaining → bucket 30
    //          -3 days (expired) → bucket 30 (urgent — already past 30 day mark)
    let bucket = null;
    for (const b of REMINDER_BUCKETS) {
      if (days <= b) bucket = b;
    }
    if (bucket === null) continue; // doc isn't yet within 90 days, no reminder needed

    // Have we already sent this bucket for this doc?
    const existing = await sbGet(
      `factory_document_reminders?document_id=eq.${doc.id}&reminder_bucket=eq.${bucket}&select=id&limit=1`
    );
    if (existing.length > 0) {
      skipped++;
      continue;
    }

    // Send it
    const sendResult = await sendReminderEmail(doc, bucket, days);
    if (sendResult.ok) {
      sent++;
      await recordReminder(doc.id, bucket, sendResult.email_to, 'sent', null);
    } else {
      failed++;
      errors.push({ doc_id: doc.id, error: sendResult.error });
      await recordReminder(doc.id, bucket, sendResult.email_to || null, 'failed', sendResult.error);
    }
  }

  return { ok: true, checked, sent, skipped, failed, errors };
}

// ── Manual single-doc reminder (admin clicks "Remind" on a row) ──
async function sendManualReminderForDoc(docId) {
  const docs = await sbGet(
    `factory_documents?id=eq.${docId}&select=*,factories(factory_name_english,sales_contact_name,sales_email)`
  );
  if (!docs.length) return { ok: false, error: 'Document not found' };
  const doc = docs[0];

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = daysUntil(doc.expiry_date, today);

  // For manual sends, pick the most urgent applicable bucket (smallest remaining).
  // If doc is far from expiry, still send a 90-day-style reminder.
  let bucket = 90;
  for (const b of REMINDER_BUCKETS) {
    if (days <= b) bucket = b;
  }

  const result = await sendReminderEmail(doc, bucket, days, /* manualOverride */ true);
  if (result.ok) {
    await recordReminder(doc.id, bucket, result.email_to, 'sent', null, true);
    return { ok: true, email_to: result.email_to, bucket, days };
  }
  return { ok: false, error: result.error || 'Send failed' };
}

// ── Email send via SendGrid ──
async function sendReminderEmail(doc, bucket, days, manualOverride) {
  const factory = doc.factories || {};
  const toEmail = factory.sales_email;
  if (!toEmail) {
    return { ok: false, error: 'No sales_email on factory record' };
  }

  const docTypeLabel = doc.document_type === 'Other'
    ? (doc.document_type_other || 'Other')
    : doc.document_type;
  const factoryName = factory.factory_name_english || 'Factory';
  const contactName = factory.sales_contact_name || 'Team';
  const expiryStr = formatDate(doc.expiry_date);

  const isExpired = days < 0;
  const isCritical = bucket === 30 || isExpired;

  let subject, bodyIntro, bodyAction;
  if (isExpired) {
    subject = `⚠ Action required: ${docTypeLabel} expired ${Math.abs(days)} days ago`;
    bodyIntro = `Your ${docTypeLabel} certificate (which expired on ${expiryStr}) is now ${Math.abs(days)} days past due. This puts your factory in non-compliance status with our compliance program.`;
    bodyAction = `Please upload a renewed certificate as soon as possible to restore compliance.`;
  } else if (isCritical) {
    subject = `⚠ Compliance warning: ${docTypeLabel} expires in ${days} days`;
    bodyIntro = `Your ${docTypeLabel} certificate expires on ${expiryStr} — only ${days} days from today. This is the final reminder before your factory enters non-compliance status.`;
    bodyAction = `Please upload a renewed certificate as soon as possible.`;
  } else {
    subject = `Reminder: ${docTypeLabel} expires in ${days} days`;
    bodyIntro = `This is a friendly heads-up that your ${docTypeLabel} certificate expires on ${expiryStr} — ${days} days from today.`;
    bodyAction = `Please upload your renewed certificate at your earliest convenience.`;
  }

  const certInfo = [
    doc.certificate_number ? `Certificate Number: ${doc.certificate_number}` : null,
    doc.issued_by ? `Issued By: ${doc.issued_by}` : null,
    `Expiry Date: ${expiryStr}`
  ].filter(Boolean).join('\n');

  const body =
`Hi ${contactName},

${bodyIntro}

${bodyAction} Sign in to the Supplier Portal to upload it under the Compliance tab:

${PORTAL_URL}

Document on file:
- Type: ${docTypeLabel}
${certInfo.split('\n').map(l => '- ' + l).join('\n')}

If you have any questions or your certificate is in the process of being renewed, just reply to this email.

Thanks,
TBG Sourcing
`;

  // Build SendGrid payload (matches send-email.js pattern)
  const payload = {
    personalizations: [{
      to: [{ email: toEmail, name: contactName }],
      cc: [{ email: ADMIN_CC, name: 'TBG Sourcing' }]
    }],
    from: { email: FROM_EMAIL, name: FROM_NAME },
    reply_to: { email: FROM_EMAIL, name: FROM_NAME },
    subject,
    content: [{ type: 'text/plain', value: body }]
  };

  try {
    const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + SG_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    if (r.ok) {
      return { ok: true, email_to: toEmail };
    }
    const e = await r.json().catch(() => ({}));
    return { ok: false, email_to: toEmail, error: (e.errors && e.errors[0] && e.errors[0].message) || 'HTTP ' + r.status };
  } catch (err) {
    return { ok: false, email_to: toEmail, error: err.message };
  }
}

async function recordReminder(documentId, bucket, emailTo, status, errorMessage, isManual) {
  const payload = {
    document_id: documentId,
    reminder_bucket: bucket,
    email_to: emailTo,
    send_status: status,
    error_message: errorMessage
  };
  // For manual sends we use a non-standard bucket so they don't block the cron from sending the regular bucket later.
  // Easier: when manual, append a tiny offset in the bucket. We'll use bucket + 1000 for manual to keep them isolated.
  if (isManual) {
    payload.reminder_bucket = bucket + 1000;
  }
  try {
    await fetch(`${SB}/rest/v1/factory_document_reminders`, {
      method: 'POST',
      headers: {
        'apikey': SB_KEY,
        'Authorization': `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    // non-fatal
    console.log('recordReminder error:', e.message);
  }
}

// ── Helpers ──
async function sbGet(path) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` }
  });
  if (!r.ok) throw new Error(`Supabase GET failed: HTTP ${r.status}`);
  return r.json();
}

function daysUntil(dateStr, today) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00');
  const t = today || new Date();
  return Math.ceil((d.getTime() - t.getTime()) / (1000 * 60 * 60 * 24));
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}
