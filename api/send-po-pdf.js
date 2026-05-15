// ============================================================
// /api/send-po-pdf.js
//
// Called from admin.html after issuePOFromPdi() has created the PO row
// and milestone rows. Responsibilities:
//   1. Generate the PO contract PDF with variable interpolation
//   2. Upload to Supabase Storage (po-contracts bucket)
//   3. Update purchase_orders with pdf_url + signing_status='sent_to_factory'
//   4. Email the factory with portal link
//   5. Log scorecard event 'po_sent' to factory_events
//
// POST { purchase_order_id: <uuid> }
//   → { success: true, pdf_url, email_result }
// ============================================================

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SG_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'sourcing@tbgsourcing.net';
const FROM_NAME = 'Tyler Durden';
const PORTAL_URL = 'https://portal.tbgsourcing.net';

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

async function uploadToStorage(bucket, path, bytes, contentType) {
  const url = `${SUPABASE_URL}/storage/v1/object/${bucket}/${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': contentType || 'application/octet-stream',
      'x-upsert': 'true'
    },
    body: bytes
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Storage upload ${res.status}: ${txt}`);
  }
  return `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${path}`;
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

function fmt(n, decimals = 4) {
  if (n == null || isNaN(n)) return '—';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

// ─────────────────────────────────────────────────────────
// PDF GENERATION — placeholder contract template
// ─────────────────────────────────────────────────────────
async function generatePoPdf(po, pd, quote, rfq, factory, customer, brand) {
  const pdfDoc = await PDFDocument.create();
  const font   = await pdfDoc.embedFont(StandardFonts.TimesRoman);
  const bold   = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);
  const italic = await pdfDoc.embedFont(StandardFonts.TimesRomanItalic);

  const PAGE_W = 595, PAGE_H = 842;
  const MARGIN_L = 60, MARGIN_R = 60, MARGIN_T = 60, MARGIN_B = 60;
  const TEXT_WIDTH = PAGE_W - MARGIN_L - MARGIN_R;

  let page = pdfDoc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN_T;

  function newPage() { page = pdfDoc.addPage([PAGE_W, PAGE_H]); y = PAGE_H - MARGIN_T; }
  function checkPage(needed) { if (y - needed < MARGIN_B) newPage(); }
  function writeLine(text, opts = {}) {
    const f = opts.bold ? bold : (opts.italic ? italic : font);
    const size = opts.size || 11;
    const lineH = size * 1.4;
    checkPage(lineH);
    page.drawText(String(text), {
      x: MARGIN_L + (opts.indent || 0),
      y: y - size,
      size,
      font: f,
      color: opts.color || rgb(0, 0, 0)
    });
    y -= lineH;
  }
  function writeWrap(text, opts = {}) {
    const f = opts.bold ? bold : (opts.italic ? italic : font);
    const size = opts.size || 11;
    const lineH = size * 1.4;
    const indent = opts.indent || 0;
    const widthAvail = TEXT_WIDTH - indent;
    const words = String(text || '').split(/\s+/);
    let line = '';
    for (const w of words) {
      const tryLine = line ? line + ' ' + w : w;
      const width = f.widthOfTextAtSize(tryLine, size);
      if (width > widthAvail && line) {
        checkPage(lineH);
        page.drawText(line, { x: MARGIN_L + indent, y: y - size, size, font: f });
        y -= lineH;
        line = w;
      } else {
        line = tryLine;
      }
    }
    if (line) {
      checkPage(lineH);
      page.drawText(line, { x: MARGIN_L + indent, y: y - size, size, font: f });
      y -= lineH;
    }
  }
  function space(amount = 8) { y -= amount; checkPage(0); }
  function hrule() {
    checkPage(8);
    page.drawLine({ start: { x: MARGIN_L, y: y - 2 }, end: { x: PAGE_W - MARGIN_R, y: y - 2 }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) });
    y -= 8;
  }

  writeLine('PURCHASE ORDER & SUPPLY AGREEMENT', { size: 18, bold: true });
  writeLine('PO Number: ' + (po.po_number || '—'), { size: 11 });
  writeLine('Issue Date: ' + fmtDate(po.issued_at || new Date().toISOString()), { size: 11 });
  writeLine('Version: ' + (po.po_version || 1), { size: 11 });
  hrule();
  space(4);

  writeLine('PARTIES', { size: 13, bold: true });
  space(2);
  writeLine('Buyer:', { bold: true });
  writeLine('TBG Sourcing', { indent: 12 });
  writeLine('(Tomorrow Brand Group)', { indent: 12, italic: true });
  space(4);
  writeLine('Supplier:', { bold: true });
  writeLine(factory.factory_name_english || '—', { indent: 12 });
  if (factory.factory_name_local) writeLine(factory.factory_name_local, { indent: 12, italic: true });
  if (factory.address) writeWrap(factory.address, { indent: 12 });
  if (factory.country) writeLine(factory.country, { indent: 12 });
  space(6);
  hrule();
  space(4);

  writeLine('1. PRODUCT', { size: 13, bold: true });
  space(2);
  writeLine('Item Description:', { bold: true });
  writeWrap(rfq.item_description || pd.item_description || '—', { indent: 12 });
  space(2);
  writeLine('PD Number: ' + (pd.pd_number || '—'));
  writeLine('Project Number: ' + (rfq.project_number || '—'));
  writeLine('Category: ' + [rfq.category, rfq.sub_category, rfq.sub_sub_category].filter(Boolean).join(' / '));
  if (customer && customer.customer_name) writeLine('Customer: ' + customer.customer_name);
  if (brand && brand.brand_name)         writeLine('Brand: ' + brand.brand_name);
  space(6);
  hrule();
  space(4);

  writeLine('2. COMMERCIAL TERMS', { size: 13, bold: true });
  space(2);
  writeLine('Quantity: ' + (po.total_units ? Number(po.total_units).toLocaleString() + ' units' : '—'));
  writeLine('Unit FOB Price: ' + fmt(po.unit_fob_price));
  if (po.packaging_price_per_unit) writeLine('Packaging Cost (per unit): ' + fmt(po.packaging_price_per_unit));
  writeLine('Total Contract Value: ' + fmt(po.total_value_usd, 2), { bold: true });
  writeLine('Currency: ' + (po.currency || 'USD'));
  writeLine('Payment Terms: ' + (po.payment_terms || 'Per quote agreement'));
  writeLine('FOB Port: ' + (po.fob_port || '—'));
  space(6);
  hrule();
  space(4);

  writeLine('3. QUALITY & GOLDEN SAMPLE', { size: 13, bold: true });
  space(2);
  writeWrap('The Supplier shall manufacture the Products to conform exactly to the golden sample approved by the Buyer on ' + fmtDate(po.golden_sample_approved_at) + '. Any deviation in formulation, packaging, materials, dimensions, weight, or finish requires prior written approval from the Buyer.');
  space(4);
  writeWrap('Quality defects discovered upon receipt or during inspection that exceed Acceptable Quality Limits (AQL 2.5 for major, AQL 4.0 for minor defects) shall be at the Supplier\'s expense, including rework, replacement, and freight costs.');
  space(6);
  hrule();
  space(4);

  writeLine('4. PRE-SHIPMENT INSPECTION', { size: 13, bold: true });
  space(2);
  writeWrap('The Buyer reserves the right to conduct pre-shipment inspection at the Supplier\'s facility prior to cargo loading. The Supplier shall provide reasonable access, samples, and documentation for inspection. Shipment may not proceed without the Buyer\'s written release following inspection.');
  space(6);
  hrule();
  space(4);

  writeLine('5. REGULATORY COMPLIANCE', { size: 13, bold: true });
  space(2);
  writeWrap('The Supplier warrants that all Products comply with applicable laws and regulations in the destination market, including but not limited to product safety, labeling, packaging, ingredient restrictions, and chemical disclosure requirements (e.g., FDA, MoCRA, California Prop 65, EU Cosmetics Regulation 1223/2009, REACH, RoHS, Health Canada).');
  space(4);
  writeWrap('Supplier shall provide certificates of analysis, safety data sheets, and any third-party testing reports required by the Buyer or the destination market.');
  space(6);
  hrule();
  space(4);

  writeLine('6. INTELLECTUAL PROPERTY', { size: 13, bold: true });
  space(2);
  writeWrap('All product designs, formulations, packaging artwork, brand assets, trademarks, and related materials provided by the Buyer remain the sole and exclusive property of the Buyer. The Supplier shall not use, reproduce, distribute, or disclose any such materials except as strictly required to fulfill this Purchase Order.');
  space(4);
  writeWrap('The Supplier shall not manufacture similar or identical products for any third party using the Buyer\'s designs, formulations, or specifications without express written consent.');
  space(6);
  hrule();
  space(4);

  writeLine('7. CONFIDENTIALITY', { size: 13, bold: true });
  space(2);
  writeWrap('Both parties agree to maintain in confidence all proprietary information, trade secrets, pricing, customer information, and business strategies disclosed during the course of this agreement. This obligation survives termination.');
  space(6);
  hrule();
  space(4);

  writeLine('8. FORCE MAJEURE', { size: 13, bold: true });
  space(2);
  writeWrap('Neither party shall be liable for delays or failures to perform due to acts of God, war, terrorism, government action, pandemic, fire, flood, earthquake, or other circumstances beyond reasonable control. The affected party shall provide prompt written notice and use commercially reasonable efforts to mitigate impact.');
  space(6);
  hrule();
  space(4);

  writeLine('9. GOVERNING LAW & DISPUTE RESOLUTION', { size: 13, bold: true });
  space(2);
  writeWrap('This agreement shall be governed by the laws of [TO BE SPECIFIED]. The parties agree to attempt good-faith resolution of any dispute before pursuing formal proceedings.');
  space(6);

  newPage();
  writeLine('10. ACCEPTANCE', { size: 13, bold: true });
  space(2);
  writeWrap('By signing below and uploading this executed agreement to the Buyer\'s supplier portal, the Supplier confirms acceptance of all terms herein. This agreement becomes binding upon both digital acceptance via the portal and receipt of the physically signed and chopped contract.');
  space(20);

  writeWrap('[PLACEHOLDER NOTICE: This contract uses placeholder legal language for system development and review. Final binding contract terms to be drafted by legal counsel before commercial use.]', { italic: true, size: 9, color: rgb(0.5, 0.5, 0.5) });
  space(30);

  hrule();
  space(8);
  writeLine('SUPPLIER ACCEPTANCE', { size: 13, bold: true });
  space(8);
  writeLine('Company Name: ' + (factory.factory_name_english || ''));
  space(20);
  writeLine('Authorized Signatory:');
  page.drawLine({ start: { x: MARGIN_L, y: y - 4 }, end: { x: MARGIN_L + 300, y: y - 4 }, thickness: 0.5, color: rgb(0, 0, 0) });
  space(20);
  writeLine('Print Name: _________________________________');
  space(16);
  writeLine('Title: _________________________________');
  space(16);
  writeLine('Date: _________________________________');
  space(16);
  writeLine('Company Chop / Official Seal:');
  page.drawRectangle({ x: MARGIN_L, y: y - 80, width: 120, height: 75, borderColor: rgb(0.5, 0.5, 0.5), borderWidth: 0.5 });
  space(90);

  writeLine('BUYER ISSUED BY', { size: 12, bold: true });
  space(6);
  writeLine('TBG Sourcing — ' + (po.issued_by || 'Sourcing Manager'));
  writeLine('Date: ' + fmtDate(po.issued_at || new Date().toISOString()));

  return await pdfDoc.save();
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
  const purchase_order_id = body.purchase_order_id;

  if (!purchase_order_id) {
    return res.status(400).json({ error: 'Missing purchase_order_id.' });
  }

  try {
    const poRows = await sb(
      `purchase_orders?id=eq.${purchase_order_id}` +
      `&select=*,factories(*),rfqs(*,customers(*),brands(*)),product_development_items(*),rfq_quotes(*)`
    );
    if (!poRows || !poRows.length) {
      return res.status(404).json({ error: 'Purchase order not found.' });
    }
    const po = poRows[0];
    if (po.pdf_url && po.signing_status && po.signing_status !== 'draft') {
      return res.status(400).json({
        error: 'PO already has a PDF and signing has progressed. Current status: ' + po.signing_status,
        existing_pdf_url: po.pdf_url
      });
    }

    const factory = po.factories || {};
    const rfq     = po.rfqs || {};
    const pd      = po.product_development_items || {};
    const quote   = po.rfq_quotes || {};
    const customer = rfq.customers || null;
    const brand    = rfq.brands || null;

    let pdfBytes;
    try {
      pdfBytes = await generatePoPdf(po, pd, quote, rfq, factory, customer, brand);
    } catch (pdfErr) {
      console.error('PDF generation failed:', pdfErr);
      return res.status(500).json({ error: 'PDF generation failed: ' + pdfErr.message });
    }

    const storagePath = `${po.id}/${po.po_number}_v${po.po_version || 1}.pdf`;
    let pdf_url;
    try {
      pdf_url = await uploadToStorage('po-contracts', storagePath, Buffer.from(pdfBytes), 'application/pdf');
    } catch (storageErr) {
      console.error('Storage upload failed:', storageErr);
      return res.status(500).json({ error: 'Storage upload failed: ' + storageErr.message });
    }

    const sentAt = new Date().toISOString();
    await sb(`purchase_orders?id=eq.${po.id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        pdf_url,
        signing_status: 'sent_to_factory',
        sent_to_factory_at: sentAt,
        updated_at: sentAt
      })
    });

    let emailResult = { ok: false, error: 'not attempted' };
    if (factory.sales_email) {
      const firstName = (factory.sales_contact_name || 'Team').split(' ')[0];
      const subject = `Purchase Order ${po.po_number} — Action Required`;
      const emailBody =
        `Dear ${firstName},\n\n` +
        `A new Purchase Order has been issued for your acceptance:\n\n` +
        `PO Number: ${po.po_number}\n` +
        `Product: ${rfq.item_description || pd.item_description || ''}\n` +
        `Quantity: ${(po.total_units || 0).toLocaleString()} units\n` +
        `Total Value: ${fmt(po.total_value_usd, 2)}\n\n` +
        `Please log into the supplier portal to review and accept the contract:\n` +
        `${PORTAL_URL}\n\n` +
        `After accepting in the portal, you will need to:\n` +
        `1. Print the contract\n` +
        `2. Sign and apply your company chop\n` +
        `3. Upload the executed PDF back into the portal\n\n` +
        `Best regards,\n` +
        `${FROM_NAME}\n` +
        `Sourcing Manager, TBG Sourcing\n` +
        `${FROM_EMAIL}`;
      emailResult = await sendEmail(factory.sales_email, factory.sales_contact_name || 'Team', subject, emailBody);
    }

    try {
      await sb('factory_events', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          factory_id: po.factory_id,
          event_type: 'po_sent',
          event_data: { po_id: po.id, po_number: po.po_number, total_value: po.total_value_usd },
          actor_type: 'admin'
        })
      });
    } catch (eventErr) {
      console.log('factory_events log failed (non-fatal):', eventErr.message);
    }

    return res.status(200).json({
      success: true,
      pdf_url,
      sent_to_factory_at: sentAt,
      email_result: emailResult
    });
  } catch (err) {
    console.error('send-po-pdf fatal error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}

module.exports = handler;
module.exports.default = handler;
