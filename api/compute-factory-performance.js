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
  return res.status === 204 ? null : await res.json();
}

// ── Helpers ──
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
function hoursBetween(d1, d2) { return (new Date(d2) - new Date(d1)) / 3_600_000; }

// ─────────────────────────────────────────────────────────
// DIMENSION 1 — Responsiveness (25 pts)
// Measures: time to respond to invitations, RFQs, and admin info requests
// Inputs: factory_rfqs (assigned_at vs first quote submission)
//         rfq_quotes status transitions
// Output: 0-100 score + sub-components + data points used
// ─────────────────────────────────────────────────────────
async function scoreResponsiveness(factoryId) {
  const subComponents = {};
  let dataPoints = 0;

  // (a) Invitation-to-first-login responsiveness — from factory_events
  //     Score = how fast did factory log in after receiving an invite?
  //     Excellent: <24h = 100, Good: <72h = 85, OK: <7d = 70, Slow: >7d = 50
  const invitedEvents = await sb(
    `factory_events?factory_id=eq.${factoryId}&event_type=eq.invitation_sent&select=occurred_at&order=occurred_at.asc&limit=20`
  ) || [];
  const loginEvents = await sb(
    `factory_events?factory_id=eq.${factoryId}&event_type=eq.first_login&select=occurred_at&order=occurred_at.asc&limit=20`
  ) || [];
  if (invitedEvents.length && loginEvents.length) {
    const firstInvite = invitedEvents[0].occurred_at;
    const firstLogin = loginEvents[0].occurred_at;
    const hrs = hoursBetween(firstInvite, firstLogin);
    let s;
    if (hrs <= 24)        s = 100;
    else if (hrs <= 72)   s = 85;
    else if (hrs <= 168)  s = 70;
    else                  s = 50;
    subComponents.invitation_login_score = s;
    subComponents.invitation_login_hours = Math.round(hrs);
    dataPoints++;
  }

  // (b) Quote turnaround time — assigned_at → first rfq_quote created_at, per RFQ
  //     Excellent: <48h = 100, Good: <5d = 85, OK: <10d = 70, Slow: >10d = 55
  const assignments = await sb(
    `factory_rfqs?factory_id=eq.${factoryId}&select=rfq_id,assigned_at&order=assigned_at.desc&limit=30`
  ) || [];
  if (assignments.length) {
    const rfqIds = assignments.map(a => a.rfq_id).filter(Boolean);
    if (rfqIds.length) {
      const quotesRows = await sb(
        `rfq_quotes?factory_id=eq.${factoryId}&rfq_id=in.(${rfqIds.join(',')})&status=neq.draft&select=rfq_id,created_at&order=created_at.asc`
      ) || [];
      const firstQuotePerRfq = {};
      quotesRows.forEach(q => {
        if (!firstQuotePerRfq[q.rfq_id] || new Date(q.created_at) < new Date(firstQuotePerRfq[q.rfq_id])) {
          firstQuotePerRfq[q.rfq_id] = q.created_at;
        }
      });
      const turnaroundHours = [];
      for (const a of assignments) {
        if (!a.assigned_at) continue;
        const fq = firstQuotePerRfq[a.rfq_id];
        if (fq) turnaroundHours.push(hoursBetween(a.assigned_at, fq));
      }
      if (turnaroundHours.length) {
        const avgHrs = avg(turnaroundHours);
        let s;
        if (avgHrs <= 48)        s = 100;
        else if (avgHrs <= 120)  s = 85;
        else if (avgHrs <= 240)  s = 70;
        else                     s = 55;
        subComponents.quote_turnaround_score = s;
        subComponents.quote_turnaround_avg_hours = Math.round(avgHrs);
        subComponents.quote_turnaround_sample_size = turnaroundHours.length;
        dataPoints += turnaroundHours.length;
      }
    }
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
// Measures: golden-sample first-pass approval rate + average revisions
// Inputs: product_development_items + sample_evaluations
// ─────────────────────────────────────────────────────────
async function scoreSamplePerformance(factoryId) {
  const pds = await sb(
    `product_development_items?factory_id=eq.${factoryId}&select=id,status,current_version,approved_at,rejected_at`
  ) || [];
  if (!pds.length) {
    return { score: null, dataPoints: 0, breakdown: { note: 'No product development items yet.' } };
  }
  const closed = pds.filter(p => p.status === 'approved' || p.status === 'rejected');
  if (!closed.length) {
    return { score: null, dataPoints: 0, breakdown: { note: 'Samples in progress but none closed yet.' } };
  }
  const approved = closed.filter(p => p.status === 'approved');
  const firstPassApproved = approved.filter(p => (p.current_version || 1) === 1);
  const rejected = closed.filter(p => p.status === 'rejected');

  // First-pass approval rate is the headline metric — 100% = perfect, 0% = never on first try
  const firstPassRate = approved.length ? (firstPassApproved.length / approved.length) : 0;
  // Approval rate overall
  const approvalRate = closed.length ? (approved.length / closed.length) : 0;
  // Avg revisions (excluding rejects)
  const avgRevisions = approved.length ? avg(approved.map(p => Math.max(0, (p.current_version || 1) - 1))) : 0;

  // Score formula:
  //   60% from first-pass-approval rate (rewards getting it right the first time)
  //   30% from overall approval rate (penalize rejections)
  //   10% from revision count (fewer revisions = better; 0 revisions = 100, 4+ revisions = 0)
  const revisionScore = clamp(100 - (avgRevisions * 25), 0, 100);
  const composite = (firstPassRate * 100 * 0.6) + (approvalRate * 100 * 0.3) + (revisionScore * 0.1);

  return {
    score: clamp(composite, 0, 100),
    dataPoints: closed.length,
    breakdown: {
      total_samples_closed: closed.length,
      approved: approved.length,
      rejected: rejected.length,
      first_pass_approved: firstPassApproved.length,
      first_pass_approval_rate: Math.round(firstPassRate * 100),
      overall_approval_rate: Math.round(approvalRate * 100),
      avg_revisions_to_approval: Math.round(avgRevisions * 10) / 10,
      formula: '60% first-pass rate + 30% approval rate + 10% revision-count score'
    }
  };
}

// ─────────────────────────────────────────────────────────
// DIMENSION 4 — Production Reliability (20 pts)
// Measures: % of PO milestones hit on time vs delayed; magnitude of delays
// Inputs: po_milestones across all POs for this factory
// ─────────────────────────────────────────────────────────
async function scoreProductionReliability(factoryId) {
  // Get all POs for this factory
  const pos = await sb(
    `purchase_orders?factory_id=eq.${factoryId}&select=id`
  ) || [];
  if (!pos.length) {
    return { score: null, dataPoints: 0, breakdown: { note: 'No POs issued to this factory yet.' } };
  }
  const poIds = pos.map(p => p.id);
  if (!poIds.length) {
    return { score: null, dataPoints: 0, breakdown: { note: 'No PO ids found.' } };
  }

  const milestones = await sb(
    `po_milestones?purchase_order_id=in.(${poIds.join(',')})&status=in.(completed,confirmed_on_track,at_risk,delayed)&select=status,agreed_date,revised_date,completed_at,milestone_type`
  ) || [];

  if (!milestones.length) {
    return { score: null, dataPoints: 0, breakdown: { note: 'POs exist but no milestone data yet.' } };
  }

  let onTimeCount = 0;
  let delayedCount = 0;
  let atRiskCount = 0;
  let confirmedCount = 0;
  const delayDaysList = [];

  milestones.forEach(m => {
    const agreed = m.agreed_date;
    const revised = m.revised_date;
    const completed = m.completed_at;
    if (m.status === 'completed' && completed && agreed) {
      const slipDays = Math.round((new Date(completed) - new Date(agreed)) / 86400000);
      if (slipDays <= 0) onTimeCount++;
      else { delayedCount++; delayDaysList.push(slipDays); }
    } else if (m.status === 'delayed') {
      delayedCount++;
      if (revised && agreed) {
        const slipDays = Math.round((new Date(revised) - new Date(agreed)) / 86400000);
        if (slipDays > 0) delayDaysList.push(slipDays);
      }
    } else if (m.status === 'at_risk') {
      atRiskCount++;
    } else if (m.status === 'confirmed_on_track') {
      confirmedCount++;
    }
  });

  const total = onTimeCount + delayedCount + atRiskCount + confirmedCount;
  if (!total) {
    return { score: null, dataPoints: 0, breakdown: { note: 'No measurable milestones yet.' } };
  }

  // On-time rate = (on-time + confirmed-on-track) / total
  // At-risk counts as half-credit since it's a warning but not yet a miss
  const onTimeRate = (onTimeCount + confirmedCount + (atRiskCount * 0.5)) / total;
  // Avg delay magnitude (only for those that delayed) — used as a penalty
  const avgDelayDays = delayDaysList.length ? avg(delayDaysList) : 0;
  // Delay magnitude penalty: 0d = 0 penalty, 7d = 10 penalty, 14d = 20 penalty, capped at 30
  const delayPenalty = clamp(avgDelayDays * (10 / 7), 0, 30);

  const composite = clamp((onTimeRate * 100) - delayPenalty, 0, 100);

  return {
    score: composite,
    dataPoints: total,
    breakdown: {
      total_milestones_measured: total,
      on_time_count: onTimeCount,
      confirmed_on_track_count: confirmedCount,
      at_risk_count: atRiskCount,
      delayed_count: delayedCount,
      on_time_rate_pct: Math.round(onTimeRate * 100),
      avg_delay_days_when_late: Math.round(avgDelayDays * 10) / 10,
      delay_penalty_applied: Math.round(delayPenalty * 10) / 10,
      formula: '(on-time rate × 100) - (avg delay penalty)'
    }
  };
}

// ─────────────────────────────────────────────────────────
// DIMENSION 5 — Compliance Hygiene (10 pts)
// Measures: cert renewal timeliness, scope match, compliance gate pass rate
// Inputs: factory_documents (certs), rfq_quotes.compliance_gate_status
// ─────────────────────────────────────────────────────────
async function scoreComplianceHygiene(factoryId) {
  const subComponents = {};
  let dataPoints = 0;

  // (a) Certs in good standing — % of certs that are not expired or expiring within 30 days
  const certs = await sb(
    `factory_documents?factory_id=eq.${factoryId}&cert_status=eq.approved&select=cert_type,expiry_date`
  ) || [];
  if (certs.length) {
    const now = new Date();
    const thirtyDays = new Date(now.getTime() + 30 * 86400000);
    let good = 0, expiring = 0, expired = 0;
    certs.forEach(c => {
      if (!c.expiry_date) { good++; return; }
      const exp = new Date(c.expiry_date);
      if (exp < now)              expired++;
      else if (exp < thirtyDays)  expiring++;
      else                         good++;
    });
    const score = certs.length ? ((good + expiring * 0.5) / certs.length) * 100 : null;
    subComponents.cert_health_score = score;
    subComponents.certs_total = certs.length;
    subComponents.certs_good = good;
    subComponents.certs_expiring_30d = expiring;
    subComponents.certs_expired = expired;
    dataPoints += certs.length;
  }

  // (b) Compliance gate pass rate on submitted quotes
  const quotes = await sb(
    `rfq_quotes?factory_id=eq.${factoryId}&status=neq.draft&compliance_gate_status=not.is.null&select=compliance_gate_status&order=created_at.desc&limit=30`
  ) || [];
  if (quotes.length) {
    const passed = quotes.filter(q => q.compliance_gate_status === 'passed' || q.compliance_gate_status === 'pass').length;
    const blocked = quotes.filter(q => q.compliance_gate_status === 'blocked').length;
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
