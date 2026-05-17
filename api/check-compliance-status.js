// ============================================================
// /api/check-compliance-status.js
//
// The unified compliance checker. Called from both:
//   - Factory portal (for visibility — banner, RFQ panels, quote panels)
//   - Admin (before PO issuance — blocks if any red flag)
//
// POST { factory_id, rfq_id?, quote_id? }
//   → {
//       success: true,
//       status: {
//         overall: 'green' | 'yellow' | 'red',
//         blocks_po: boolean,
//         layers: {
//           layer_1_factory:   { status, red_flags: [], warnings: [] },
//           layer_2_rfq:       { status, red_flags: [], warnings: [] } | null,
//           layer_3_product:   { status, red_flags: [], warnings: [] } | null
//         }
//       }
//     }
//
// Red flags block POs. Warnings do not.
// Layer 1 = factory baseline (per category). Blocks on missing/expired required certs.
// Layer 2 = RFQ-specific requirements. Blocks on missing/expired RFQ-required certs.
// Layer 3 = product-level docs for THIS quote (INCI, Formulation, etc).
//           v1: warn-only (does not block), to avoid surprising blocks before factories know.
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text || !text.trim()) return null;
  try { return JSON.parse(text); }
  catch (e) { throw new Error(`Supabase non-JSON: ${text.slice(0, 200)}`); }
}

// Days until a date (ISO yyyy-mm-dd or full timestamp)
function daysUntil(dateStr, today) {
  if (!dateStr) return null;
  const d = new Date(dateStr.slice(0, 10) + 'T00:00:00Z');
  const t = today || new Date();
  return Math.ceil((d.getTime() - t.getTime()) / 86400000);
}

// Determine whether a given cert name has a current, non-expired matching doc in the factory's set.
// factoryDocs: array of { document_type, document_type_other, is_current, expiry_date }
// certName:    e.g. 'ISO 22716', 'Business License'
// Returns: { ok: bool, status: 'current'|'expired'|'expiring_soon'|'missing'|'no_expiry', doc: <row or null>, days_to_expiry: int|null }
function checkCertCoverage(factoryDocs, certName) {
  // Match by either document_type or document_type_other (case-insensitive)
  const matches = (factoryDocs || []).filter(d => {
    if (!d.is_current) return false;
    const dt = (d.document_type || '').toLowerCase();
    const dto = (d.document_type_other || '').toLowerCase();
    const target = certName.toLowerCase();
    return dt === target || dto === target;
  });
  if (!matches.length) {
    return { ok: false, status: 'missing', doc: null, days_to_expiry: null };
  }
  // Pick the doc that's most current (latest issue_date or uploaded_at)
  matches.sort((a, b) => {
    const ad = a.uploaded_at || a.issue_date || '';
    const bd = b.uploaded_at || b.issue_date || '';
    return bd.localeCompare(ad);
  });
  const doc = matches[0];

  // If there's no expiry, treat as current with no expiry warning
  if (!doc.expiry_date) {
    return { ok: true, status: 'no_expiry', doc, days_to_expiry: null };
  }

  const days = daysUntil(doc.expiry_date);
  if (days < 0) {
    return { ok: false, status: 'expired', doc, days_to_expiry: days };
  }
  if (days <= 30) {
    return { ok: true, status: 'expiring_soon', doc, days_to_expiry: days };
  }
  return { ok: true, status: 'current', doc, days_to_expiry: days };
}

// Format expiry status into a readable flag
function flagForCertStatus(certName, coverage, blockingSeverity = 'blocker') {
  if (coverage.status === 'missing') {
    return {
      code: 'cert_missing',
      label: `${certName} — not uploaded`,
      severity: blockingSeverity,
      detail: 'Factory has not uploaded this certification. Required for compliance.',
      cert_name: certName
    };
  }
  if (coverage.status === 'expired') {
    return {
      code: 'cert_expired',
      label: `${certName} — expired ${Math.abs(coverage.days_to_expiry)} day(s) ago`,
      severity: blockingSeverity,
      detail: `Certificate ${coverage.doc.certificate_number || ''} expired on ${coverage.doc.expiry_date}. Must be renewed.`,
      cert_name: certName,
      doc_id: coverage.doc.id
    };
  }
  if (coverage.status === 'expiring_soon') {
    return {
      code: 'cert_expiring_soon',
      label: `${certName} — expires in ${coverage.days_to_expiry} day(s)`,
      severity: 'warning',
      detail: `Renew before ${coverage.doc.expiry_date} to avoid disruption.`,
      cert_name: certName,
      doc_id: coverage.doc.id
    };
  }
  return null;
}

// ── LAYER 1: Factory baseline (per-category) ──
// Factory may operate in multiple categories. We check Layer 1 against
// each unique top-level category they claim, deduplicating flags.
async function checkLayer1Factory(factory, factoryDocs) {
  const result = { status: 'green', red_flags: [], warnings: [] };

  function finalize(r) {
    if (r.red_flags.length)      r.status = 'red';
    else if (r.warnings.length)  r.status = 'yellow';
    else                         r.status = 'green';
    return r;
  }

  // ── Resolve factory's categories ──
  // Try the factory_categories join table first (canonical source).
  // Fall back to factories.categories array column if join table is empty.
  let categories = [];
  try {
    const fcRows = await sb(
      `factory_categories?factory_id=eq.${factory.id}&select=category`
    );
    if (Array.isArray(fcRows) && fcRows.length) {
      categories = [...new Set(fcRows.map(r => r.category).filter(Boolean))];
    }
  } catch (e) {
    // table query failed — fall back to array column
  }
  if (!categories.length && Array.isArray(factory.categories)) {
    categories = factory.categories.filter(Boolean);
  }

  if (!categories.length) {
    result.warnings.push({
      code: 'no_category',
      label: 'Factory has no category assigned',
      severity: 'warning',
      detail: 'Cannot determine which compliance baseline applies. Assign a category in factory details.'
    });
    return finalize(result);
  }

  // ── Fetch all compliance rules for the factory's categories ──
  const categoryFilter = categories.map(c => encodeURIComponent(c)).join(',');
  const rules = await sb(
    `compliance_requirements?category=in.(${categoryFilter})&select=*`
  ) || [];

  if (!rules.length) {
    result.warnings.push({
      code: 'no_rules_for_category',
      label: `No compliance rules configured for ${categories.join(', ')}`,
      severity: 'warning',
      detail: 'Admin should configure compliance_requirements for these categories.'
    });
    return finalize(result);
  }

  // ── Aggregate required and preferred certs across all matching rules ──
  // De-duplicate by cert name. Required wins over preferred (stricter).
  const requiredCerts = new Set();
  const preferredCerts = new Set();
  rules.forEach(rule => {
    (rule.required_factory_certs || []).forEach(c => requiredCerts.add(c));
    (rule.preferred_factory_certs || []).forEach(c => preferredCerts.add(c));
  });
  // Remove from preferred any that are also required
  requiredCerts.forEach(c => preferredCerts.delete(c));

  // ── Required certs → red flags on miss/expired ──
  for (const certName of requiredCerts) {
    const cov = checkCertCoverage(factoryDocs, certName);
    const flag = flagForCertStatus(certName, cov, 'blocker');
    if (flag) {
      if (flag.severity === 'warning') result.warnings.push(flag);
      else                              result.red_flags.push(flag);
    }
  }

  // ── Preferred certs → warnings only ──
  for (const certName of preferredCerts) {
    const cov = checkCertCoverage(factoryDocs, certName);
    if (cov.status === 'missing') {
      result.warnings.push({
        code: 'preferred_cert_missing',
        label: `${certName} — preferred but not uploaded`,
        severity: 'warning',
        detail: 'Nice-to-have for this category. Not blocking.',
        cert_name: certName
      });
    } else if (cov.status === 'expired') {
      result.warnings.push({
        code: 'preferred_cert_expired',
        label: `${certName} — preferred cert is expired`,
        severity: 'warning',
        detail: `Expired on ${cov.doc.expiry_date}. Not blocking but should be renewed.`,
        cert_name: certName
      });
    } else if (cov.status === 'expiring_soon') {
      result.warnings.push({
        code: 'preferred_cert_expiring_soon',
        label: `${certName} — preferred cert expires in ${cov.days_to_expiry} day(s)`,
        severity: 'warning',
        detail: `Renew before ${cov.doc.expiry_date}.`,
        cert_name: certName
      });
    }
  }

  // ── Factory's compliance_status field (if present on the row) ──
  if (factory.compliance_status === 'non_compliant' || factory.compliance_status === 'blocked') {
    result.red_flags.push({
      code: 'factory_compliance_status',
      label: `Factory flagged ${factory.compliance_status} in master record`,
      severity: 'blocker',
      detail: factory.compliance_notes || 'Resolve factory-level compliance issues before ordering.'
    });
  }

  return finalize(result);
}

// ── LAYER 2: RFQ-specific requirements ──
async function checkLayer2Rfq(rfq, factoryDocs) {
  const result = { status: 'green', red_flags: [], warnings: [] };

  // Must-have RFQ certs
  for (const certName of (rfq.certifications_required || [])) {
    const cov = checkCertCoverage(factoryDocs, certName);
    const flag = flagForCertStatus(certName, cov, 'blocker');
    if (flag) {
      if (flag.severity === 'warning') result.warnings.push(flag);
      else                              result.red_flags.push(flag);
    }
  }

  // Nice-to-have RFQ certs
  for (const certName of (rfq.certifications_preferred || [])) {
    const cov = checkCertCoverage(factoryDocs, certName);
    if (cov.status === 'missing') {
      result.warnings.push({
        code: 'rfq_preferred_cert_missing',
        label: `${certName} — preferred for this RFQ but not on file`,
        severity: 'warning',
        detail: 'Nice-to-have for this project.',
        cert_name: certName
      });
    }
  }

  if (result.red_flags.length)      result.status = 'red';
  else if (result.warnings.length)  result.status = 'yellow';
  return result;
}

// ── LAYER 3: Per-quote / per-PD product documents and dimensions ──
// Carton dimensions are blocking (freight calc requires them).
// Product docs are warn-only in v1.
async function checkLayer3Product(rfq, quote, categoryRules, pdItem) {
  const result = { status: 'green', red_flags: [], warnings: [] };

  // ── A. Carton dimensions (from product_development_items if present) ──
  // Only checked when we have a PD record — i.e., the quote has been accepted
  // and the factory is in the PD workspace flow.
  if (pdItem) {
    const masterMissing = !pdItem.master_case_pack_units ||
                          !pdItem.master_length_cm ||
                          !pdItem.master_width_cm ||
                          !pdItem.master_height_cm ||
                          !pdItem.master_weight_kg;
    if (masterMissing) {
      result.red_flags.push({
        code: 'master_carton_missing',
        label: 'Master case dimensions not confirmed',
        severity: 'blocker',
        detail: 'Factory must confirm units-per-master-case + master case L/W/H and weight before PO can issue. Required for freight calculation.'
      });
    }
    const innerIncomplete = !pdItem.inner_case_pack_units ||
                            !pdItem.inner_length_cm ||
                            !pdItem.inner_width_cm ||
                            !pdItem.inner_height_cm;
    if (innerIncomplete) {
      result.warnings.push({
        code: 'inner_carton_missing',
        label: 'Inner case dimensions not confirmed',
        severity: 'warning',
        detail: 'Recommended — helps with inventory planning and order picking.'
      });
    }
  }

  // ── B. Required and preferred product docs ──
  // Determine required product docs:
  //   1. RFQ-level overrides if set
  //   2. Otherwise category default
  const requiredDocs = (rfq.product_docs_required && rfq.product_docs_required.length)
    ? rfq.product_docs_required
    : ((categoryRules && categoryRules.required_product_docs) || []);
  const preferredDocs = (rfq.product_docs_preferred && rfq.product_docs_preferred.length)
    ? rfq.product_docs_preferred
    : ((categoryRules && categoryRules.preferred_product_docs) || []);

  // Fetch uploaded product docs — look both by quote_id AND by pd_id
  // (PD workspace uploads are tagged with product_development_id)
  let productDocs = [];
  if (quote && quote.id) {
    const qDocs = await sb(
      `product_documents?rfq_quote_id=eq.${quote.id}&is_current=eq.true&select=document_type,document_type_other,uploaded_at,file_name`
    ) || [];
    productDocs = productDocs.concat(qDocs);
  }
  if (pdItem && pdItem.id) {
    const pDocs = await sb(
      `product_documents?product_development_id=eq.${pdItem.id}&is_current=eq.true&select=document_type,document_type_other,uploaded_at,file_name`
    ) || [];
    productDocs = productDocs.concat(pDocs);
  }

  function hasDoc(docName) {
    return productDocs.some(d =>
      (d.document_type || '').toLowerCase() === docName.toLowerCase() ||
      (d.document_type_other || '').toLowerCase() === docName.toLowerCase()
    );
  }

  // Required → warnings (v1 — not yet promoted to blocker)
  for (const docName of requiredDocs) {
    if (!hasDoc(docName)) {
      result.warnings.push({
        code: 'product_doc_missing',
        label: `${docName} — not uploaded`,
        severity: 'warning',
        detail: 'Required product document missing. Factory should upload before production starts.',
        doc_name: docName
      });
    }
  }
  // Preferred
  for (const docName of preferredDocs) {
    if (!hasDoc(docName)) {
      result.warnings.push({
        code: 'product_doc_preferred_missing',
        label: `${docName} — preferred document not uploaded`,
        severity: 'warning',
        detail: 'Nice-to-have for this product.',
        doc_name: docName
      });
    }
  }

  // ── C. Product images (warn if none uploaded post-acceptance) ──
  if (pdItem) {
    const hasImage = productDocs.some(d =>
      (d.document_type || '').toLowerCase() === 'product image'
    );
    if (!hasImage) {
      result.warnings.push({
        code: 'product_image_missing',
        label: 'No product images uploaded',
        severity: 'warning',
        detail: 'At least one product photo is recommended for downstream use (catalog, customer presentations).',
        doc_name: 'Product Image'
      });
    }
  }

  if (result.red_flags.length)      result.status = 'red';
  else if (result.warnings.length)  result.status = 'yellow';
  else                              result.status = 'green';
  return result;
}

// ── Roll up the layers into an overall status ──
function rollupStatus(layers) {
  const present = Object.values(layers).filter(l => l !== null);
  const anyRed    = present.some(l => l.red_flags.length > 0);
  const anyYellow = present.some(l => l.warnings.length > 0);
  const overall = anyRed ? 'red' : (anyYellow ? 'yellow' : 'green');
  // PO is blocked iff any layer has red flags.
  // Layer 1: missing/expired required factory certs
  // Layer 2: missing/expired RFQ-required certs
  // Layer 3: missing master carton dimensions (others are warnings only)
  const blocks_po = anyRed;
  return { overall, blocks_po };
}

// ─────────────────────────────────────────────────────────
// MAIN HANDLER
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
  const rfq_id     = body.rfq_id || null;
  const quote_id   = body.quote_id || null;

  if (!factory_id) return res.status(400).json({ error: 'Missing factory_id.' });

  try {
    // Load factory + its documents in one pair of fetches
    // Use select=* to be resilient to missing columns; we'll access fields defensively
    const factoryRows = await sb(
      `factories?id=eq.${factory_id}&select=*&limit=1`
    );
    if (!factoryRows || !factoryRows.length) {
      return res.status(404).json({ error: 'Factory not found.' });
    }
    const factory = factoryRows[0];

    const factoryDocs = await sb(
      `factory_documents?factory_id=eq.${factory_id}&is_current=eq.true&select=*`
    ) || [];

    // Run Layer 1 always
    const layer_1_factory = await checkLayer1Factory(factory, factoryDocs);

    // Run Layer 2 if rfq_id given
    let layer_2_rfq = null;
    let rfq = null;
    let categoryRules = null;
    if (rfq_id) {
      const rfqRows = await sb(
        `rfqs?id=eq.${rfq_id}&select=id,project_number,item_description,category,is_cosmetic,certifications_required,certifications_preferred,product_docs_required,product_docs_preferred&limit=1`
      );
      if (rfqRows && rfqRows.length) {
        rfq = rfqRows[0];
        layer_2_rfq = await checkLayer2Rfq(rfq, factoryDocs);
        if (rfq.category) {
          const ruleRows = await sb(
            `compliance_requirements?category=eq.${encodeURIComponent(rfq.category)}&select=*&limit=1`
          );
          if (ruleRows && ruleRows.length) categoryRules = ruleRows[0];
        }
      }
    }

    // Run Layer 3 if quote_id given.
    // Also try to find the corresponding PD record so we can check carton
    // dimensions and PD-uploaded assets, not just quote-tagged docs.
    let layer_3_product = null;
    if (quote_id && rfq) {
      const quoteRows = await sb(
        `rfq_quotes?id=eq.${quote_id}&select=id,factory_id,rfq_id&limit=1`
      );
      if (quoteRows && quoteRows.length) {
        const quote = quoteRows[0];

        // Find the PD item linked to this quote (may not exist yet if
        // quote hasn't been accepted)
        let pdItem = null;
        const pdRows = await sb(
          `product_development_items?accepted_quote_id=eq.${quote_id}&select=*&limit=1`
        );
        if (pdRows && pdRows.length) pdItem = pdRows[0];

        layer_3_product = await checkLayer3Product(rfq, quote, categoryRules, pdItem);
      }
    }

    const layers = { layer_1_factory, layer_2_rfq, layer_3_product };
    const { overall, blocks_po } = rollupStatus(layers);

    return res.status(200).json({
      success: true,
      status: {
        overall,
        blocks_po,
        layers
      },
      meta: {
        factory_id,
        rfq_id,
        quote_id,
        checked_at: new Date().toISOString()
      }
    });
  } catch (err) {
    console.error('check-compliance-status error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}

module.exports = handler;
module.exports.default = handler;
