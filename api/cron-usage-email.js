// api/cron-usage-email.js
// Vercel cron (Mondays 09:00 UTC). Once we're past day 21 of the month, emails
// each active tenant's admin a usage update when projected month-end spend is
// trending above 70% of their cap.
//
//   GET /api/cron-usage-email  → { sent, skipped }
export const config = { runtime: 'nodejs' };

const SB_URL = process.env.SUPABASE_URL || 'https://mjkjubctswjwjihxjpnd.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const H = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' };

async function sb(path) {
  try {
    const r = await fetch(SB_URL + '/rest/v1/' + path, { headers: H });
    if (!r.ok) { console.error('cron-usage-email: query failed', path, r.status); return []; }
    const j = await r.json();
    return Array.isArray(j) ? j : [];
  } catch (e) { console.error('cron-usage-email: fetch threw', path, e); return []; }
}

async function sendEmail(to, toName, subject, html) {
  const SG_KEY = process.env.SENDGRID_API_KEY;
  if (!SG_KEY) { console.error('cron-usage-email: SENDGRID_API_KEY not set'); return false; }
  const payload = {
    personalizations: [{ to: [{ email: to, name: toName || '' }] }],
    from: { email: 'sourcing@tbgsourcing.net', name: 'TBG Sourcing' },
    reply_to: { email: 'sourcing@tbgsourcing.net', name: 'TBG Sourcing' },
    subject,
    content: [{ type: 'text/html', value: html }],
  };
  try {
    const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + SG_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) console.error('cron-usage-email: sendgrid failed', r.status, await r.text().catch(() => ''));
    return r.ok;
  } catch (e) { console.error('cron-usage-email: sendgrid threw', e); return false; }
}

export default async function handler(req, res) {
  const now = new Date();
  const dayOfMonth = now.getUTCDate();

  // ── Only run during week 3 (day 21+) of the calendar month ──
  if (dayOfMonth < 21) return res.status(200).json({ skipped: 'not week 3' });

  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const monthStart = new Date(Date.UTC(year, month, 1)).toISOString();
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const monthLabel = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const NEW_TENANT_MS = 21 * 864e5;

  const tenants = await sb('tenants?billing_status=eq.active&select=id,name,api_cost_cap_usd,created_at');

  let sent = 0, skipped = 0;
  for (const t of tenants) {
    try {
      // a. Skip brand-new tenants (< 21 days old — first month).
      if (t.created_at && (now.getTime() - new Date(t.created_at).getTime()) < NEW_TENANT_MS) { skipped++; continue; }

      const cap = Number(t.api_cost_cap_usd) || 0;
      if (cap <= 0) { skipped++; continue; }

      // b. Month-to-date spend.
      const rows = await sb('api_cost_log?tenant_id=eq.' + t.id + '&created_at=gte.' + encodeURIComponent(monthStart) + '&select=cost_usd_marked_up');
      const spent = rows.reduce((s, x) => s + (Number(x.cost_usd_marked_up) || 0), 0);

      // c. Tenant admin email.
      const admins = await sb('tenant_users?tenant_id=eq.' + t.id + '&role=eq.admin&select=email,full_name&limit=1');
      const admin = admins[0];
      if (!admin || !admin.email) { skipped++; continue; }

      // d/e. Projected month-end spend + pct of cap.
      const projected = (spent / dayOfMonth) * daysInMonth;
      const pct = (projected / cap) * 100;

      // f/g. Only email when trending above 70%.
      if (pct <= 70) { skipped++; continue; }

      const name = (admin.full_name || '').split(' ')[0] || 'there';
      const recommendation = pct > 90
        ? 'We recommend adding to your cap to avoid any service interruption. Log in to your dashboard to add $25 increments anytime.'
        : "You're using your plan well. If you expect heavier usage, you can add to your cap from your dashboard.";

      const html =
        '<div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:14px;line-height:1.6;color:#1a1a2e;">' +
        '<p>Hi ' + name + ',</p>' +
        '<p>Here\'s your AI usage update for ' + monthLabel + ':</p>' +
        '<p>📊 Current spend: <strong>$' + spent.toFixed(2) + '</strong><br>' +
        '📈 Projected by month end: <strong>$' + projected.toFixed(2) + '</strong><br>' +
        '📋 Your current cap: <strong>$' + cap.toFixed(2) + '/month</strong></p>' +
        "<p>You're on track to use <strong>" + pct.toFixed(0) + '%</strong> of your cap this month.</p>' +
        '<p>' + recommendation + '</p>' +
        '<p>Log in: <a href="https://portal.tbgsourcing.net/tenant-login.html">https://portal.tbgsourcing.net/tenant-login.html</a></p>' +
        '<p>— TBG Sourcing</p>' +
        '</div>';

      const ok = await sendEmail(admin.email, admin.full_name || '', 'Your AI usage update — ' + t.name, html);
      if (ok) sent++; else skipped++;
    } catch (e) {
      console.error('cron-usage-email: tenant loop threw', t && t.id, e);
      skipped++;
    }
  }

  return res.status(200).json({ sent, skipped });
}
