// ============================================================
// /api/audit-report-received.js
// Called (no auth) after an inspector/tenant uploads a factory-audit report.
// Notifies sourcing, AI-extracts scores, updates the audit, upserts a
// certification when warranted, creates a tenant action item, logs a metric.
//
// POST { audit_id } → { success:true, extracted:boolean }
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY, SENDGRID_API_KEY
// ============================================================
export const config = { runtime: 'nodejs' };
export const maxDuration = 60;

const SB_URL = process.env.SUPABASE_URL || 'https://mjkjubctswjwjihxjpnd.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SG_KEY = process.env.SENDGRID_API_KEY;
const MODEL = 'claude-sonnet-4-6';
const FROM = 'sourcing@tbgsourcing.net';
const H = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' };

function readBody(req) { let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } } return b || {}; }
async function sbGet(path) { const r = await fetch(SB_URL + '/rest/v1/' + path, { headers: H }); if (!r.ok) return []; const d = await r.json(); return Array.isArray(d) ? d : []; }
async function sbPatch(path, body) { return (await fetch(SB_URL + '/rest/v1/' + path, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(body) })).ok; }
async function sbPost(path, body) { return (await fetch(SB_URL + '/rest/v1/' + path, { method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(body) })).ok; }
function extractJson(text) { let c = (text || '').trim().replace(/```json|```/g, '').trim(); const s = c.indexOf('{'), e = c.lastIndexOf('}'); if (s === -1 || e === -1) throw new Error('no json'); return JSON.parse(c.substring(s, e + 1)); }
function addMonths(dateStr, months) { if (!dateStr) return null; const d = new Date(dateStr + 'T00:00:00'); if (isNaN(d)) return null; d.setMonth(d.getMonth() + months); return d.toISOString().slice(0, 10); }
function logMetric(metric_type, metric_value, cohort) {
  fetch(SB_URL + '/rest/v1/platform_metrics_log', { method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
    body: JSON.stringify({ metric_type, metric_value: metric_value == null ? null : metric_value, cohort: cohort || null, recorded_at: new Date().toISOString() }) }).catch(() => {});
}
async function sendEmail(subject, body) {
  if (!SG_KEY) return;
  await fetch('https://api.sendgrid.com/v3/mail/send', { method: 'POST', headers: { Authorization: 'Bearer ' + SG_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ personalizations: [{ to: [{ email: FROM }] }], from: { email: FROM, name: 'TBG Sourcing' }, subject, content: [{ type: 'text/plain', value: body }] }) }).catch(() => {});
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!SB_KEY) return res.status(500).json({ error: 'Supabase service key not set.' });

  const { audit_id } = readBody(req);
  if (!audit_id) return res.status(400).json({ error: 'Missing audit_id.' });

  try {
    const rows = await sbGet('factory_audits?id=eq.' + encodeURIComponent(audit_id) +
      '&select=*,factories(factory_name_english,tenant_id),factory_audit_types(name,generates_certification,certification_name,default_validity_months)&limit=1');
    const audit = rows[0];
    if (!audit) return res.status(404).json({ error: 'Audit not found.' });
    const factory = audit.factories || {};
    const atype = audit.factory_audit_types || {};
    const facName = factory.factory_name_english || 'Factory';
    const tenantId = audit.tenant_id || factory.tenant_id || null;

    // 2. Notify sourcing.
    await sendEmail(
      `Factory Audit Report Received — ${facName} — ${atype.name || 'Audit'}`,
      `Factory: ${facName}\nAudit: ${atype.name || ''}\nReport: ${audit.report_url || ''}\n\nReview: https://portal.tbgsourcing.net/factory-audits.html`
    );

    // 3. AI extraction (best-effort).
    let extracted = false, color = audit.color_rating || null;
    if (ANTHROPIC_API_KEY && audit.report_url) {
      try {
        const docRes = await fetch(audit.report_url);
        if (docRes.ok) {
          const ct = (docRes.headers.get('content-type') || '').toLowerCase();
          const b64 = Buffer.from(await docRes.arrayBuffer()).toString('base64');
          const isPdf = ct.includes('pdf') || /\.pdf($|\?)/i.test(audit.report_url);
          const docBlock = isPdf
            ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
            : { type: 'image', source: { type: 'base64', media_type: ct.includes('png') ? 'image/png' : 'image/jpeg', data: b64 } };
          const r = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST', headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: MODEL, max_tokens: 1500,
              system: 'You are a factory audit report analyzer. Extract compliance scores and findings from this report. Return ONLY valid JSON, no other text.',
              messages: [{ role: 'user', content: [docBlock, { type: 'text', text: 'Extract this data and return as JSON: { "overall_pct": number|null, "color_rating": "green"|"yellow"|"orange"|"red"|null, "sections": [{"code": string, "name": string, "pct": number, "findings_count": number}]|null, "critical_count": number, "major_count": number, "minor_count": number }' }] }] }),
          });
          if (r.ok) {
            const d = await r.json();
            logMetric('factory_audit_ai_extract', (d.usage && d.usage.output_tokens) || 0, 'audit');
            const ext = extractJson((d.content && d.content[0] && d.content[0].text) || '');
            const sectionScores = {};
            (Array.isArray(ext.sections) ? ext.sections : []).forEach(s => { if (s && s.code) sectionScores[s.code] = { name: s.name, pct: s.pct, findings_count: s.findings_count }; });
            color = ext.color_rating || color;
            const reauditMonths = color === 'green' ? 24 : color === 'yellow' ? 12 : color === 'orange' ? 6 : color === 'red' ? 3 : (atype.default_validity_months || 12);
            const nextDue = addMonths(audit.conducted_date || new Date().toISOString().slice(0, 10), reauditMonths);
            await sbPatch('factory_audits?id=eq.' + encodeURIComponent(audit_id), {
              overall_pct: ext.overall_pct != null ? ext.overall_pct : null,
              color_rating: color,
              section_scores: Object.keys(sectionScores).length ? sectionScores : null,
              critical_count: ext.critical_count || 0, major_count: ext.major_count || 0, minor_count: ext.minor_count || 0,
              reaudit_months: reauditMonths, next_audit_due: nextDue, status: 'completed', updated_at: new Date().toISOString(),
            });
            audit.next_audit_due = nextDue;
            extracted = true;
          }
        }
      } catch (e) { console.error('audit extract failed:', e.message); }
    }

    // 4. Certification upsert (read-modify-write; green/yellow only).
    if (atype.generates_certification && (color === 'green' || color === 'yellow')) {
      const certName = atype.certification_name || atype.name || 'Certification';
      const existing = await sbGet('factory_certifications?factory_id=eq.' + encodeURIComponent(audit.factory_id) + '&certification_name=eq.' + encodeURIComponent(certName) + '&select=id&limit=1');
      const certBody = {
        factory_id: audit.factory_id, tenant_id: tenantId, audit_id,
        certification_name: certName, issued_by: audit.inspector_company || 'Third Party',
        issue_date: audit.conducted_date || null, expiry_date: audit.next_audit_due || null,
        status: 'active', updated_at: new Date().toISOString(),
      };
      if (existing[0]) await sbPatch('factory_certifications?id=eq.' + existing[0].id, certBody);
      else await sbPost('factory_certifications', certBody);
    }

    // 5. Tenant action item.
    if (tenantId) {
      await sbPost('tenant_action_items', { tenant_id: tenantId, type: 'audit_report_received', reference_id: audit_id, reference_type: 'factory_audit',
        title: 'Audit report received — ' + facName, description: 'Review extracted scores for ' + (atype.name || 'audit') + ' audit. Confirm findings are accurate.', priority: 'high', status: 'open' });
    }

    // 6. Platform metric (no tenant_id).
    logMetric('factory_audit_completed', audit.overall_pct || 0, color || 'unknown');

    return res.status(200).json({ success: true, extracted });
  } catch (err) {
    console.error('audit-report-received error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
