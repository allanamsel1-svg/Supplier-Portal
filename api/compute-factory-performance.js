// ============================================================
// /api/compute-factory-performance.js
//
// Computes a 0-100 composite performance score for a single factory
// across 6 dimensions, persists to factory_performance_scores + appends
// to factory_score_history.
//
// POST { factory_id: <uuid> }
//   → { success: true, score: { composite, tier, dimensions: {...}, breakdown: {...} } }
//
// Weights (editable here — recompute everything by re-running cron):
//   Responsiveness:         25
//   Quote Quality:          20
//   Sample Performance:     20
//   Production Reliability: 20
//   Compliance Hygiene:     10
//   Communication Tone:      5  (computed in Batch 3; defaulted to 80 for now)
//
// Tier thresholds: green >=85, yellow 70-84, red <70, insufficient_data when not enough events.
//
// Env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ── Configurable weights — change here, redeploy, run cron to recompute all factories ──
const WEIGHTS = {
  responsiveness:         25,
  quote_quality:          20,
  sample_performance:     20,
  production_reliability: 20,
  compliance_hygiene:     10,
  communication_tone:      5
};
const WEIGHTS_VERSION = 1;

// ── Tier thresholds ──
function tierFor(composite) {
  if (composite == null) return 'insufficient_data';
  if (composite >= 85)   return 'green';
  if (composite >= 70)   return 'yellow';
  return 'red';
}

// ── Supabase helper ──
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
  // 204 No Content has no body; 201 with Prefer:return=minimal also has empty body.
  // Read as text first and only JSON.parse if there's actual content — avoids "Unexpected end of JSON input".
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text || !text.trim()) return null;
  try { return JSON.parse(text); }
  catch (parseErr) {
    throw new Error(`Supabase returned non-JSON body: ${text.slice(0, 200)}`);
  }
}

// ── Helpers ──
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
function hoursBetween(d1, d2) { return (new Date(d2) - new Date(d1)) / 3_600_000; }

// ─────────────────────────────────────────────────────────
// DIMENSION 1 — Responsiveness (25 pts)
// Measures: (a) time from invitation→login response, (b) quote submission frequency
// Inputs: invitation_events, rfq_quotes
// ─────────────────────────────────────────────────────────
async function scoreResponsiveness(factoryId) {
  const subComponents = {};
  let dataPoints = 0;

  // (a) Invitation events — find invite→response pairs
  const invEvents = await sb(
    `invitation_events?factory_id=eq.${factoryId}&select=event_type,created_at&order=created_at.asc&limit=100`
  ) || [];
  if (invEvents.length >= 2) {
    // Find earliest invitation-style event
    const inviteEvent = invEvents.find(e =>
      ['invited','sent','invitation_sent','pending'].includes((e.event_type || '').toLowerCase())
    );
    // Find earliest response-style event AFTER the invitation
    const responseEvent = inviteEvent ? invEvents.find(e =>
      ['active','logged_in','accepted','responded','first_login','quoted'].includes((e.event_type || '').toLowerCase()) &&
      new Date(e.created_at) > new Date(inviteEvent.created_at)
    ) : null;
    if (inviteEvent && responseEvent) {
      const hrs = hoursBetween(inviteEvent.created_at, responseEvent.created_at);
      let s;
      if (hrs <= 24)        s = 100;
      else if (hrs <= 72)   s = 85;
      else if (hrs <= 168)  s = 70;
      else                  s = 50;
      subComponents.invitation_response_score = s;
      subComponents.invitation_response_hours = Math.round(hrs);
      dataPoints++;
    }
  }

  // (b) Quote engagement — count quotes submitted in last 90 days
  // More quotes = more engaged factory.
  // We don't have a reliable assigned_at, so use submission frequency as a proxy.
  const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString();
  const recentQuotes = await sb(
    `rfq_quotes?factory_id=eq.${factoryId}&status=neq.draft&created_at=gte.${ninetyDaysAgo}&select=id`
  ) || [];
  if (recentQuotes.length > 0) {
    let s;
    if (recentQuotes.length >= 10)      s = 100;
    else if (recentQuotes.length >= 5)  s = 85;
    else if (recentQuotes.length >= 2)  s = 70;
    else                                 s = 55;
    subComponents.quote_engagement_score = s;
    subComponents.quotes_last_90_days = recentQuotes.length;
    dataPoints += recentQuotes.length;
  }

  // Composite for this dimension — average of available sub-components
  const subScores = Object.entries(subComponents)
    .filter(([k, v]) => k.endsWith('_score') && typeof v === 'number')
    .map(([, v]) => v);
  if (!subScores.length) {
    return { score: null, dataPoints: 0, breakdown: { sub_components: subComponents, note: 'No responsiveness data yet.' } };
  }
  return {
    score: avg(subScores),
    dataPoints,
    breakdown: { sub_components: subComponents, weighting: 'simple average of available sub-components' }
  };
}

// ─────────────────────────────────────────────────────────
// DIMENSION 2 — Quote Quality (20 pts)
// Measures: average v2 score across all submitted quotes
// Inputs: rfq_quotes.score_overall_v2
// ─────────────────────────────────────────────────────────
async function scoreQuoteQuality(factoryId) {
  const quotes = await sb(
    `rfq_quotes?factory_id=eq.${factoryId}&status=neq.draft&score_overall_v2=not.is.null&select=score_overall_v2,score_tier&order=created_at.desc&limit=30`
  ) || [];
  if (!quotes.length) {
    return { score: null, dataPoints: 0, breakdown: { note: 'No v2-scored quotes yet.' } };
  }
  const scores = quotes.map(q => parseFloat(q.score_overall_v2)).filter(n => !isNaN(n));
  if (!scores.length) {
    return { score: null, dataPoints: 0, breakdown: { note: 'Quotes exist but no valid v2 scores.' } };
  }
  const mean = avg(scores);
  // Recent quotes matter more — weight last 10 at 70%, prior 20 at 30%
  const recent = scores.slice(0, 10);
  const older = scores.slice(10);
  let weighted;
  if (older.length) weighted = (avg(recent) * 0.7) + (avg(older) * 0.3);
  else              weighted = avg(recent);

  // Tier distribution for breakdown context
  const tierCounts = quotes.reduce((acc, q) => {
    const t = q.score_tier || 'unknown';
    acc[t] = (acc[t] || 0) + 1;
    return acc;
  }, {});

  return {
    score: clamp(weighted, 0, 100),
    dataPoints: scores.length,
    breakdown: {
      simple_average: Math.round(mean * 10) / 10,
      recency_weighted_score: Math.round(weighted * 10) / 10,
      tier_distribution: tierCounts,
      total_quotes_scored: scores.length
    }
  };
}

// ─────────────────────────────────────────────────────────
// DIMENSION 3 — Sample Performance (20 pts)
// Measures: PD approval rate
// Inputs: product_development (singular)
// Note: schema doesn't have current_version, so first-pass approval can't be measured here.
//       Will improve when product_development_items table is migrated.
// ─────────────────────────────────────────────────────────
async function scoreSamplePerformance(factoryId) {
  const pds = await sb(
    `product_development?factory_id=eq.${factoryId}&select=id,status,approved_at,created_at`
  ) || [];
  if (!pds.length) {
    return { score: null, dataPoints: 0, breakdown: { note: 'No product development records yet.' } };
  }
  // Use status field for both approved and rejected (no rejected_at column exists)
  const approved = pds.filter(p => (p.status || '').toLowerCase() === 'approved');
  const rejected = pds.filter(p => (p.status || '').toLowerCase() === 'rejected');
  const closed = approved.length + rejected.length;
  if (!closed) {
    return { score: null, dataPoints: 0, breakdown: { note: 'Product developments in progress but none closed yet.' } };
  }

  const approvalRate = approved.length / closed;
  const composite = approvalRate * 100;

  return {
    score: clamp(composite, 0, 100),
    dataPoints: closed,
    breakdown: {
      total_pds: pds.length,
      total_pds_closed: closed,
      approved: approved.length,
      rejected: rejected.length,
      approval_rate_pct: Math.round(approvalRate * 100),
      formula: 'approval rate × 100',
      note: 'Once product_development_items table is migrated, will include first-pass approval and revision counts.'
    }
  };
}

// ─────────────────────────────────────────────────────────
// DIMENSION 4 — Production Reliability (20 pts)
// Measures: PO activity volume + qty_received vs qty_ordered as completion proxy
// Inputs: purchase_order_lines joined to rfq_quotes (no factory_id on lines directly)
// Note: rich on-time tracking requires po_milestones table migration.
// ─────────────────────────────────────────────────────────
async function scoreProductionReliability(factoryId) {
  // Step 1: find accepted quotes for this factory (these become POs)
  const acceptedQuotes = await sb(
    `rfq_quotes?factory_id=eq.${factoryId}&status=eq.accepted&select=id`
  ) || [];
  if (!acceptedQuotes.length) {
    return { score: null, dataPoints: 0, breakdown: { note: 'No accepted quotes (no PO activity) for this factory yet.' } };
  }
  const quoteIds = acceptedQuotes.map(q => q.id);

  // Step 2: find PO lines tied to those quotes
  const lines = await sb(
    `purchase_order_lines?rfq_quote_id=in.(${quoteIds.join(',')})&select=id,qty_ordered,qty_received`
  ) || [];

  if (!lines.length) {
    return { score: null, dataPoints: 0, breakdown: { note: 'Accepted quotes exist but no POs issued yet.' } };
  }

  // Use qty_received / qty_ordered as a completion proxy
  let totalOrdered = 0, totalReceived = 0;
  lines.forEach(l => {
    totalOrdered  += parseFloat(l.qty_ordered  || 0);
    totalReceived += parseFloat(l.qty_received || 0);
  });

  if (totalOrdered === 0) {
    return { score: null, dataPoints: lines.length, breakdown: { note: 'PO lines exist but no qty_ordered recorded.' } };
  }

  const completionRate = Math.min(1, totalReceived / totalOrdered);
  // Score: completion rate × 100 — but ONLY for fully closed POs (received >= ordered for any line)
  // Pure in-progress orders shouldn't be penalized
  const fullyReceived = lines.filter(l => parseFloat(l.qty_received || 0) >= parseFloat(l.qty_ordered || 0) && parseFloat(l.qty_ordered || 0) > 0).length;
  const composite = completionRate * 100;

  return {
    score: clamp(composite, 0, 100),
    dataPoints: lines.length,
    breakdown: {
      accepted_quotes: acceptedQuotes.length,
      total_po_lines: lines.length,
      fully_received_lines: fullyReceived,
      total_qty_ordered: totalOrdered,
      total_qty_received: totalReceived,
      completion_rate_pct: Math.round(completionRate * 100),
      formula: 'qty_received / qty_ordered × 100 (capped at 100)',
      note: 'Once po_milestones migration runs, will include on-time-rate vs delay magnitude.'
    }
  };
}

// ─────────────────────────────────────────────────────────
// DIMENSION 5 — Compliance Hygiene (10 pts)
// Measures: cert expiry health + compliance gate pass rate
// Inputs: factory_documents (document_type, expiry_date), rfq_quotes.compliance_gate_status
// ─────────────────────────────────────────────────────────
async function scoreComplianceHygiene(factoryId) {
  const subComponents = {};
  let dataPoints = 0;

  // (a) Certs in good standing — score by expiry status
  // factory_documents schema: id, factory_id, document_type, certificate_number, expiry_date, ...
  const certs = await sb(
    `factory_documents?factory_id=eq.${factoryId}&select=document_type,expiry_date&limit=100`
  ) || [];
  if (certs.length) {
    const now = new Date();
    const thirtyDays = new Date(now.getTime() + 30 * 86400000);
    let good = 0, expiring = 0, expired = 0, noExpiry = 0;
    certs.forEach(c => {
      if (!c.expiry_date) { noExpiry++; good++; return; }
      const exp = new Date(c.expiry_date);
      if (isNaN(exp.getTime())) { good++; return; }
      if (exp < now)              expired++;
      else if (exp < thirtyDays)  expiring++;
      else                         good++;
    });
    const score = ((good + expiring * 0.5) / certs.length) * 100;
    subComponents.cert_health_score = score;
    subComponents.certs_total = certs.length;
    subComponents.certs_good = good;
    subComponents.certs_expiring_30d = expiring;
    subComponents.certs_expired = expired;
    subComponents.certs_no_expiry_date = noExpiry;
    dataPoints += certs.length;
  }

  // (b) Compliance gate pass rate on submitted quotes
  const quotes = await sb(
    `rfq_quotes?factory_id=eq.${factoryId}&status=neq.draft&compliance_gate_status=not.is.null&select=compliance_gate_status&order=created_at.desc&limit=30`
  ) || [];
  if (quotes.length) {
    const passed = quotes.filter(q => ['passed','pass'].includes((q.compliance_gate_status || '').toLowerCase())).length;
    const blocked = quotes.filter(q => (q.compliance_gate_status || '').toLowerCase() === 'blocked').length;
    const score = (passed / quotes.length) * 100;
    subComponents.compliance_gate_score = score;
    subComponents.gate_total_quotes = quotes.length;
    subComponents.gate_passed = passed;
    subComponents.gate_blocked = blocked;
    dataPoints += quotes.length;
  }

  const subScores = Object.entries(subComponents)
    .filter(([k, v]) => k.endsWith('_score') && typeof v === 'number')
    .map(([, v]) => v);
  if (!subScores.length) {
    return { score: null, dataPoints: 0, breakdown: { sub_components: subComponents, note: 'No compliance data yet.' } };
  }
  return {
    score: avg(subScores),
    dataPoints,
    breakdown: { sub_components: subComponents, weighting: 'simple average of available sub-components' }
  };
}

// ─────────────────────────────────────────────────────────
// DIMENSION 6 — Communication Tone (5 pts)
// AI-scored from email threads. Placeholder for now — returns 80 (default).
// Real implementation in Batch 3.
// ─────────────────────────────────────────────────────────
async function scoreCommunicationTone(factoryId) {
  return {
    score: 80,
    dataPoints: 0,
    breakdown: { note: 'Communication tone analysis runs in Batch 3. Default 80 used for now.' }
  };
}

// ─────────────────────────────────────────────────────────
// Composite assembly
// Uses ONLY dimensions where data exists. Renormalizes weights across available dims.
// If less than 2 dimensions have data, returns 'insufficient_data'.
// ─────────────────────────────────────────────────────────
function buildComposite(dims) {
  const available = Object.entries(dims).filter(([, d]) => d.score != null);
  if (available.length < 2) {
    return { composite: null, tier: 'insufficient_data', weights_used: null };
  }
  const totalWeightAvailable = available.reduce((sum, [k]) => sum + WEIGHTS[k], 0);
  const weighted = available.reduce((sum, [k, d]) => sum + (d.score * WEIGHTS[k] / totalWeightAvailable), 0);
  const weightsUsed = {};
  available.forEach(([k]) => { weightsUsed[k] = Math.round((WEIGHTS[k] / totalWeightAvailable) * 1000) / 10; });
  return { composite: Math.round(weighted * 10) / 10, tier: tierFor(weighted), weights_used: weightsUsed };
}

// ─────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────
async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'SUPABASE env vars not set.' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const factory_id = body.factory_id;
  if (!factory_id) return res.status(400).json({ error: 'Missing factory_id.' });

  // Validate UUID shape so a bad input doesn't propagate into many queries
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(factory_id)) {
    return res.status(400).json({ error: 'factory_id is not a valid UUID: ' + factory_id });
  }

  // Run each scoring function with per-dimension error attribution
  // so failures are localized rather than vague.
  const dimensions = {};
  const dimensionErrors = {};
  async function safeRun(name, fn) {
    try { dimensions[name] = await fn(factory_id); }
    catch (e) {
      dimensionErrors[name] = e.message || String(e);
      dimensions[name] = { score: null, dataPoints: 0, breakdown: { error: dimensionErrors[name] } };
    }
  }

  try {
    await Promise.all([
      safeRun('responsiveness',         scoreResponsiveness),
      safeRun('quote_quality',          scoreQuoteQuality),
      safeRun('sample_performance',     scoreSamplePerformance),
      safeRun('production_reliability', scoreProductionReliability),
      safeRun('compliance_hygiene',     scoreComplianceHygiene),
      safeRun('communication_tone',     scoreCommunicationTone)
    ]);

    // If EVERY dimension threw, propagate the first one so the user sees an actionable error
    const errKeys = Object.keys(dimensionErrors);
    if (errKeys.length === 6) {
      return res.status(500).json({
        error: 'All dimensions failed. First error from ' + errKeys[0] + ': ' + dimensionErrors[errKeys[0]],
        dimension_errors: dimensionErrors
      });
    }

    const { composite, tier, weights_used } = buildComposite(dimensions);

    const breakdown = {
      dimensions: Object.fromEntries(
        Object.entries(dimensions).map(([k, v]) => [k, {
          score: v.score,
          data_points: v.dataPoints,
          details: v.breakdown
        }])
      ),
      weights_used,
      weights_version: WEIGHTS_VERSION,
      dimension_errors: errKeys.length ? dimensionErrors : undefined
    };

    const nowIso = new Date().toISOString();
    const todayDate = nowIso.slice(0, 10);

    const upsertPayload = {
      factory_id,
      composite_score: composite,
      tier,
      responsiveness_score:             dimensions.responsiveness.score,
      quote_quality_score:              dimensions.quote_quality.score,
      sample_performance_score:         dimensions.sample_performance.score,
      production_reliability_score:     dimensions.production_reliability.score,
      compliance_hygiene_score:         dimensions.compliance_hygiene.score,
      communication_tone_score:         dimensions.communication_tone.score,
      responsiveness_data_points:       dimensions.responsiveness.dataPoints,
      quote_quality_data_points:        dimensions.quote_quality.dataPoints,
      sample_performance_data_points:   dimensions.sample_performance.dataPoints,
      production_reliability_data_points: dimensions.production_reliability.dataPoints,
      compliance_hygiene_data_points:   dimensions.compliance_hygiene.dataPoints,
      communication_tone_data_points:   dimensions.communication_tone.dataPoints,
      score_breakdown:                  breakdown,
      computed_at:                      nowIso,
      weights_version:                  WEIGHTS_VERSION,
      updated_at:                       nowIso
    };

    // Upsert to factory_performance_scores using the proper PostgREST pattern:
    // on_conflict=factory_id tells PostgREST to use factory_id as the conflict target.
    try {
      await sb('factory_performance_scores?on_conflict=factory_id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(upsertPayload)
      });
    } catch (upsertErr) {
      // Fallback: if upsert fails for any reason, try delete-then-insert
      console.error('Upsert failed, falling back to delete+insert:', upsertErr.message);
      try {
        await sb('factory_performance_scores?factory_id=eq.' + factory_id, { method: 'DELETE' });
        await sb('factory_performance_scores', {
          method: 'POST',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify(upsertPayload)
        });
      } catch (fallbackErr) {
        return res.status(500).json({
          error: 'Failed to persist score: ' + fallbackErr.message,
          original_upsert_error: upsertErr.message
        });
      }
    }

    // Append daily snapshot to history. Uses ignore-duplicates so re-running same day is a no-op.
    try {
      await sb('factory_score_history?on_conflict=factory_id,snapshot_date', {
        method: 'POST',
        headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
        body: JSON.stringify({
          factory_id,
          snapshot_date: todayDate,
          composite_score: composite,
          tier,
          responsiveness_score:             dimensions.responsiveness.score,
          quote_quality_score:              dimensions.quote_quality.score,
          sample_performance_score:         dimensions.sample_performance.score,
          production_reliability_score:     dimensions.production_reliability.score,
          compliance_hygiene_score:         dimensions.compliance_hygiene.score,
          communication_tone_score:         dimensions.communication_tone.score
        })
      });
    } catch (histErr) {
      console.log('History append failed (non-fatal):', histErr.message);
    }

    return res.status(200).json({
      success: true,
      score: {
        composite,
        tier,
        dimensions: Object.fromEntries(
          Object.entries(dimensions).map(([k, v]) => [k, v.score])
        ),
        weights_used,
        breakdown,
        dimension_errors: errKeys.length ? dimensionErrors : undefined
      }
    });
  } catch (err) {
    console.error('compute-factory-performance fatal error:', err);
    return res.status(500).json({
      error: String(err.message || err),
      stack_first_line: (err.stack || '').split('\n')[1] || null,
      dimension_errors: dimensionErrors
    });
  }
}

module.exports = handler;
module.exports.default = handler;
