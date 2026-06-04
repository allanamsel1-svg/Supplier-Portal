// ============================================================
// /api/audit-cert-expiry-cron.js
// Weekly (Mon 09:00). Recomputes certification status and raises tenant action
// items for expiring/expired certs.
//
//   GET/POST → { checked, expired, expiring_soon, items_created }
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// ============================================================
export const config = { runtime: 'nodejs' };

const SB_URL = process.env.SUPABASE_URL || 'https://mjkjubctswjwjihxjpnd.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
const H = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' };

async function sbGet(path) { const r = await fetch(SB_URL + '/rest/v1/' + path, { headers: H }); if (!r.ok) return []; const d = await r.json(); return Array.isArray(d) ? d : []; }
async function sbPatch(path, body) { return (await fetch(SB_URL + '/rest/v1/' + path, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(body) })).ok; }
async function sbPost(path, body) { return (await fetch(SB_URL + '/rest/v1/' + path, { method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(body) })).ok; }
function logMetric(metric_type, metric_value, cohort) {
  fetch(SB_URL + '/rest/v1/platform_metrics_log', { method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
    body: JSON.stringify({ metric_type, metric_value, cohort, recorded_at: new Date().toISOString() }) }).catch(() => {});
}
function daysUntil(dateStr) { if (!dateStr) return null; const t = new Date(); t.setHours(0, 0, 0, 0); const d = new Date(dateStr + 'T00:00:00'); if (isNaN(d)) return null; return Math.round((d - t) / 864e5); }

export default async function handler(req, res) {
  if (!SB_KEY) return res.status(500).json({ error: 'Supabase service key not set.' });
  let checked = 0, expired = 0, expiringSoon = 0, itemsCreated = 0;
  try {
    const certs = await sbGet('factory_certifications?expiry_date=not.is.null&select=id,factory_id,tenant_id,certification_name,expiry_date,status&limit=1000');
    for (const c of certs) {
      checked++;
      const days = daysUntil(c.expiry_date);
      let newStatus;
      if (days != null && days <= 0) { newStatus = 'expired'; expired++; }
      else if (days != null && days <= 90) { newStatus = 'expiring_soon'; expiringSoon++; }
      else newStatus = 'active';

      if (newStatus !== c.status) await sbPatch('factory_certifications?id=eq.' + c.id, { status: newStatus, updated_at: new Date().toISOString() });

      if ((newStatus === 'expiring_soon' || newStatus === 'expired') && c.tenant_id) {
        const fac = await sbGet('factories?id=eq.' + encodeURIComponent(c.factory_id) + '&select=factory_name_english&limit=1');
        const facName = (fac[0] && fac[0].factory_name_english) || 'factory';
        const existing = await sbGet('tenant_action_items?type=eq.cert_expiring&reference_id=eq.' + encodeURIComponent(c.id) + '&status=eq.open&select=id&limit=1');
        if (!existing.length) {
          const title = c.certification_name + ' ' + (days <= 0 ? 'EXPIRED' : 'expiring in ' + days + ' days') + ' — ' + facName;
          await sbPost('tenant_action_items', { tenant_id: c.tenant_id, type: 'cert_expiring', reference_id: c.id, reference_type: 'factory_certification',
            priority: days <= 30 ? 'critical' : 'high', title, description: 'Schedule re-audit to maintain certification. Current status: ' + newStatus, due_date: c.expiry_date, status: 'open' });
          itemsCreated++;
        }
      }
    }
    logMetric('cert_expiry_check', expired, 'expired');
    logMetric('cert_expiry_check', expiringSoon, 'expiring_soon');
    return res.status(200).json({ checked, expired, expiring_soon: expiringSoon, items_created: itemsCreated });
  } catch (err) {
    console.error('audit-cert-expiry-cron error:', err);
    return res.status(500).json({ error: String(err.message || err), checked, expired, expiring_soon: expiringSoon, items_created: itemsCreated });
  }
}
