// ============================================================
// /api/cron-inspection-reminders.js
// Daily cron (08:00). Sends factory confirmation requests at 10/7/3 days out.
//
//   GET/POST  → { processed, sent, skipped }
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PUBLIC_BASE_URL (optional)
// ============================================================
export const config = { runtime: 'nodejs' };

const SB_URL = process.env.SUPABASE_URL || 'https://mjkjubctswjwjihxjpnd.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
const BASE = process.env.PUBLIC_BASE_URL || 'https://portal.tbgsourcing.net';
const SBH = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' };
const REMINDER_DAYS = [10, 7, 3];

async function sbGet(path) {
  const r = await fetch(SB_URL + '/rest/v1/' + path, { headers: SBH });
  if (!r.ok) return [];
  const d = await r.json();
  return Array.isArray(d) ? d : [];
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr + 'T00:00:00');
  if (isNaN(target)) return null;
  return Math.round((target.getTime() - today.getTime()) / 864e5);
}

export default async function handler(req, res) {
  if (!SB_KEY) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not set.' });

  const today = new Date().toISOString().slice(0, 10);
  let processed = 0, sent = 0, skipped = 0;

  try {
    const inspections = await sbGet(
      'inspections?status=in.(scheduled,factory_confirmed)&scheduled_date=gte.' + today +
      '&select=id,scheduled_date&order=scheduled_date.asc'
    );

    for (const insp of inspections) {
      processed++;
      const du = daysUntil(insp.scheduled_date);
      if (du == null || !REMINDER_DAYS.includes(du)) { skipped++; continue; }

      // Skip if a confirmation for this days_before was already sent.
      const existing = await sbGet(
        'inspection_confirmations?inspection_id=eq.' + encodeURIComponent(insp.id) +
        '&days_before=eq.' + du + '&select=id&limit=1'
      );
      if (existing.length) { skipped++; continue; }

      try {
        const r = await fetch(BASE + '/api/inspection-confirm-request', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ inspection_id: insp.id, days_before: du }),
        });
        if (r.ok) sent++; else skipped++;
      } catch { skipped++; }
    }

    return res.status(200).json({ processed, sent, skipped });
  } catch (err) {
    console.error('cron-inspection-reminders error:', err);
    return res.status(500).json({ error: String(err.message || err), processed, sent, skipped });
  }
}
