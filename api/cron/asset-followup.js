// ════════════════════════════════════════════════════════════════════
// /api/cron/asset-followup.js
// Daily follow-up for artwork projects stuck in 'waiting_for_assets'.
// For each project that has been waiting >= 1 day, emails the factory the
// list of still-missing assets, logs the email to the inbox (email_threads +
// email_messages), and raises/refreshes a tenant_action_item.
// Runs every day until the assets arrive or the project leaves
// 'waiting_for_assets' (both of which stop the project matching the query).
// ════════════════════════════════════════════════════════════════════

export const config = { runtime: 'nodejs' };
export const maxDuration = 60;

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://mjkjubctswjwjihxjpnd.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const SG_KEY = process.env.SENDGRID_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const AI_MODEL = process.env.SARAH_CRON_MODEL || 'claude-sonnet-4-6';

const FROM_EMAIL = 'sourcing@tbgsourcing.net';
const FROM_NAME = 'Sarah Lindburg';

const H = () => ({ apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' });

async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: H() });
  if (!r.ok) { console.error('sbGet failed', r.status, path, await r.text().catch(() => '')); return []; }
  return r.json();
}
async function sbPost(table, body, prefer = 'return=minimal') {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST', headers: { ...H(), Prefer: prefer }, body: JSON.stringify(body)
  });
  if (!r.ok) { console.error('sbPost failed', r.status, table, await r.text().catch(() => '')); return null; }
  return prefer.includes('representation') ? r.json() : true;
}
async function sbPatch(path, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH', headers: { ...H(), Prefer: 'return=minimal' }, body: JSON.stringify(body)
  });
  if (!r.ok) console.error('sbPatch failed', r.status, path, await r.text().catch(() => ''));
  return r.ok;
}

async function sendEmail(toEmail, toName, subject, body) {
  if (!SG_KEY) return { ok: false, error: 'SENDGRID_API_KEY not set' };
  const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + SG_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: toEmail, name: toName || '' }] }],
      from: { email: FROM_EMAIL, name: FROM_NAME },
      reply_to: { email: FROM_EMAIL, name: FROM_NAME },
      subject,
      content: [{ type: 'text/plain', value: body }]
    })
  });
  if (r.ok) return { ok: true, email_to: toEmail, subject, body };
  return { ok: false, error: 'sendgrid ' + r.status + ' ' + (await r.text().catch(() => '')) };
}

// Log an outbound email to the shared inbox (email_threads + email_messages),
// grouping by factory + subject like the other crons do.
async function logToInbox(send, factoryId, tenantId) {
  if (!send || !send.ok) return;
  const now = new Date().toISOString();
  try {
    let threadId = null;
    if (factoryId) {
      const clean = send.subject.replace(/^(Re:|Fwd:|RE:|FW:)\s*/gi, '').trim();
      const rows = await sbGet(`email_threads?factory_id=eq.${factoryId}&subject=eq.${encodeURIComponent(clean)}&order=created_at.desc&limit=1`);
      if (rows && rows[0]) threadId = rows[0].id;
    }
    if (threadId) {
      await sbPatch(`email_threads?id=eq.${threadId}`, { last_message_at: now, status: 'read', direction: 'outbound', from_email: FROM_EMAIL, from_name: FROM_NAME });
    } else {
      const created = await sbPost('email_threads', {
        subject: send.subject, from_email: FROM_EMAIL, from_name: FROM_NAME, to_email: send.email_to,
        direction: 'outbound', status: 'read', department: 'sourcing', last_message_at: now,
        factory_id: factoryId || null, tenant_id: tenantId || null
      }, 'return=representation');
      if (created && created[0]) threadId = created[0].id;
    }
    if (threadId) {
      await sbPost('email_messages', {
        thread_id: threadId, from_email: FROM_EMAIL, from_name: FROM_NAME, to_email: send.email_to,
        subject: send.subject, body_text: send.body, direction: 'outbound', is_read: true, sent_at: now,
        tenant_id: tenantId || null
      });
    }
  } catch (e) { console.log('logToInbox error:', e.message); }
}

// Raise a tenant action item, or refresh the existing open one (avoids piling
// up a new row every single day the project stays overdue).
async function raiseActionItem(ap, days, missing) {
  if (!ap.tenant_id) return;
  const title = 'Factory assets overdue: ' + (ap.product_name || 'product');
  const description = days + ' day(s) overdue. Missing: ' + (missing.length ? missing.join(', ') : 'none');
  const existing = await sbGet(`tenant_action_items?reference_id=eq.${ap.id}&type=eq.asset_request&status=eq.open&select=id,reminder_count&limit=1`);
  if (existing && existing[0]) {
    await sbPatch(`tenant_action_items?id=eq.${existing[0].id}`, {
      title, description, priority: 'critical',
      last_reminded_at: new Date().toISOString(),
      reminder_count: (existing[0].reminder_count || 0) + 1
    });
  } else {
    await sbPost('tenant_action_items', {
      tenant_id: ap.tenant_id, type: 'asset_request', reference_id: ap.id, reference_type: 'artwork_project',
      title, description, priority: 'critical', status: 'open'
    });
  }
}

// Draft ONE consolidated email (as Sarah) covering all of a factory's open action items.
// Uses the Anthropic API directly; falls back to a plain template if AI is unavailable.
async function draftConsolidatedEmail(factoryName, items) {
  const itemsText = items
    .map(it => `- ${it.title}${it.description ? ': ' + it.description : ''}`)
    .join('\n');
  const system =
    'You are Sarah Lindburg, Sourcing Manager at TBG Sourcing. Write a single professional email ' +
    'that naturally covers all open items for this factory. Do not use bullet point lists of issues — ' +
    'weave them into natural paragraphs. Be warm but direct. Never mention AI. Sign as Sarah Lindburg, ' +
    'Sourcing Manager, TBG Sourcing.';
  const user =
    `Factory: ${factoryName}. Open items to address:\n${itemsText}\n\n` +
    'Write one email covering all of these naturally.';

  if (ANTHROPIC_KEY) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: AI_MODEL, max_tokens: 800, system, messages: [{ role: 'user', content: user }] })
      });
      if (r.ok) {
        const d = await r.json();
        const text = (d && d.content && d.content[0] && d.content[0].text || '').trim();
        if (text) return text;
      } else {
        console.error('anthropic draft failed', r.status, await r.text().catch(() => ''));
      }
    } catch (e) { console.error('anthropic draft error', e.message); }
  }

  // Fallback when AI is unavailable — still a single, natural paragraph (no bullet list of issues).
  const summary = items.map(it => it.title).filter(Boolean).join('; ');
  return `Hi ${factoryName} team,\n\n` +
    `I wanted to check in on a few open items on our side${summary ? ' — ' + summary : ''}. ` +
    `When you have a moment, could you help us close these out so we can keep everything moving? ` +
    `Just reply to this email with any updates or questions and I'll take it from there.\n\n` +
    `Best regards,\nSarah Lindburg\nSourcing Manager, TBG Sourcing\n${FROM_EMAIL}`;
}

// Consolidated factory follow-up: one email per factory covering all of its open
// tenant_action_items that are due now (or by tomorrow). Returns summary stats.
async function consolidatedFactoryFollowUp() {
  let emailed = 0, factoriesProcessed = 0;
  const results = [];
  // due_date <= CURRENT_DATE + 1  (tomorrow, as a date); NULL due_dates are excluded by lte.
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const openItems = await sbGet(
    `tenant_action_items?status=eq.open&due_date=lte.${tomorrow}&reference_id=not.is.null` +
    `&select=id,tenant_id,reference_id,title,description,reminder_count&order=reference_id`
  );

  // Group by reference_id (factory_id).
  const byFactory = {};
  for (const it of (Array.isArray(openItems) ? openItems : [])) {
    (byFactory[it.reference_id] = byFactory[it.reference_id] || []).push(it);
  }
  const factoryIds = Object.keys(byFactory);
  if (!factoryIds.length) return { considered: 0, emailed, factoriesProcessed, results };

  // Resolve which reference_ids are real factories (skip ids that aren't, e.g. artwork projects).
  const facRows = await sbGet(`factories?id=in.(${factoryIds.join(',')})&select=id,factory_name_english,sales_email,sales_contact_name`);
  const facMap = {};
  for (const f of (Array.isArray(facRows) ? facRows : [])) facMap[f.id] = f;

  for (const fid of factoryIds) {
    const items = byFactory[fid];
    const fac = facMap[fid];
    if (!fac) { results.push({ factory_id: fid, items: items.length, skipped: 'not a factory' }); continue; }
    if (!fac.sales_email) { results.push({ factory_id: fid, items: items.length, skipped: 'no email' }); continue; }

    const factoryName = fac.factory_name_english || 'team';
    const body = await draftConsolidatedEmail(factoryName, items);
    const subject = `Following up on open items — ${factoryName}`;
    const send = await sendEmail(fac.sales_email, fac.sales_contact_name || 'Team', subject, body);
    factoriesProcessed++;

    if (send.ok) {
      emailed++;
      const tenantId = (items.find(i => i.tenant_id) || {}).tenant_id || null;
      await logToInbox(send, fid, tenantId);
      // Bump reminder_count + last_reminded_at for every item in this batch.
      const nowIso = new Date().toISOString();
      for (const it of items) {
        await sbPatch(`tenant_action_items?id=eq.${it.id}`, {
          reminder_count: (it.reminder_count || 0) + 1, last_reminded_at: nowIso
        });
      }
    }
    results.push({ factory_id: fid, factory: factoryName, items: items.length, sent: send.ok, error: send.error || null });
  }
  return { considered: factoryIds.length, emailed, factoriesProcessed, results };
}

export default async function handler(req, res) {
  if (!SB_KEY) return res.status(500).json({ ok: false, error: 'SUPABASE service key not set' });
  try {
    const sel = 'id,product_name,assets_required,created_at,tenant_id,pd_item_id,' +
      'product_development_items!artwork_projects_pd_item_id_fkey(factory_id,factories(factory_name_english,sales_email,sales_contact_name),rfqs(project_number,item_description))';
    const projects = await sbGet(`artwork_projects?status=eq.waiting_for_assets&order=created_at.asc&select=${encodeURIComponent(sel)}`);

    const now = Date.now();
    let emailed = 0, skipped = 0;
    const results = [];

    for (const ap of (Array.isArray(projects) ? projects : [])) {
      const days = Math.floor((now - new Date(ap.created_at).getTime()) / 86400000);
      if (days < 1) { skipped++; continue; }

      const pdi = ap.product_development_items || {};
      const fac = pdi.factories || {};
      const rfq = pdi.rfqs || {};
      const missing = (Array.isArray(ap.assets_required) ? ap.assets_required : [])
        .filter(a => a && a.received !== true).map(a => a.name);

      if (!missing.length) { skipped++; continue; }       // nothing outstanding
      if (!fac.sales_email) { skipped++; continue; }       // nowhere to send

      const productName = ap.product_name || rfq.item_description || 'your product';
      const projNo = rfq.project_number || 'PRJ-XXXX';
      const subject = `[${projNo}] Action Required: Outstanding Assets — ${productName}`;
      const firstName = (fac.factory_name_english || 'team');
      const body =
        `Hi ${firstName}, we are still waiting for the following assets for ${productName}:\n` +
        missing.map((a, i) => `${i + 1}. ${a}`).join('\n') +
        `\n\nPlease upload these through your portal or reply to this email. ` +
        `These are needed to proceed with production artwork.\n\n` +
        `Best regards,\nSarah Lindburg\nTBG Sourcing\n${FROM_EMAIL}`;

      const send = await sendEmail(fac.sales_email, fac.sales_contact_name || 'Team', subject, body);
      if (send.ok) {
        emailed++;
        await logToInbox(send, pdi.factory_id || null, ap.tenant_id || null);
      }
      await raiseActionItem(ap, days, missing);
      results.push({ id: ap.id, product: productName, days, missing: missing.length, sent: send.ok, error: send.error || null });
    }

    // ── Consolidated factory follow-up from open tenant_action_items ──
    let consolidated = { considered: 0, emailed: 0, factoriesProcessed: 0, results: [] };
    try {
      consolidated = await consolidatedFactoryFollowUp();
    } catch (e) {
      console.error('consolidatedFactoryFollowUp error', e.message);
    }

    return res.status(200).json({
      ok: true, considered: (projects || []).length, emailed, skipped, results,
      consolidated
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
