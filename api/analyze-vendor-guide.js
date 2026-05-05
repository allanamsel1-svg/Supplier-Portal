export const config = { maxDuration: 60 };

const SB = 'https://mjkjubctswjwjihxjpnd.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1qa2p1YmN0c3dqd2ppaHhqcG5kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczNjQxNjcsImV4cCI6MjA5Mjk0MDE2N30.cZrD_ymrDsRPyfX_g3hUui5_JXuW6BgE77QkIoGpqHo';

const TAXONOMY = [
  'packaging',
  'labeling',
  'routing_shipping',
  'edi_invoicing',
  'compliance_legal',
  'sustainability',
  'rfid_barcoding',
  'hazmat_safety',
  'quality_qa',
  'payment_terms',
  'returns_chargebacks',
  'product_data',
  'testing_certifications'
];

const SYSTEM_PROMPT = `You are analyzing retailer vendor guides for a sourcing and manufacturing company. Read the document carefully, then produce a structured analysis.

Respond with VALID JSON only — no markdown, no commentary, no code fences. The JSON must have exactly this shape:

{
  "summary": "2-3 sentence summary of what this document covers and why it matters to a vendor.",
  "tags": ["tag_from_fixed_list", "another_tag_from_fixed_list"],
  "freeform_tags": ["snake_case_topic"]
}

The "tags" array must contain ONLY values from this fixed taxonomy (use only the ones that apply, omit those that don't):
- packaging — boxes, cartons, polybags, palletization, dunnage
- labeling — UPC, SKU labels, master carton labels, language requirements
- routing_shipping — carrier rules, routing portals, ASN, ship windows, delivery windows
- edi_invoicing — EDI documents required, invoice format, billing
- compliance_legal — Prop 65, CPSIA, FDA, customs documentation, country of origin
- sustainability — ESG, recycled content, carbon reporting, FSC, packaging reduction
- rfid_barcoding — RFID tags, GS1, GTIN, barcode formats
- hazmat_safety — DOT classifications, MSDS/SDS, lithium batteries, aerosol restrictions
- quality_qa — inspection, AQL, testing, defect rates
- payment_terms — Net 30/60/90, discount terms, vendor finance programs
- returns_chargebacks — RTV policies, defective allowance, fines, deductions
- product_data — item setup, attribute requirements, image specs, GS1 data
- testing_certifications — UL, ETL, FCC, CE, third-party testing requirements

The "freeform_tags" array is for important topics that don't fit the fixed taxonomy. Use snake_case. Keep it short — usually 0 to 2 entries. Skip if nothing applies.

Examples of good freeform_tags: "pallet_specs", "minority_supplier_program", "dropship_only", "fixture_requirements".

Be precise. If the document is short or only covers one topic, return only the relevant tags.`;

const DIFF_SYSTEM_PROMPT = `You are comparing two versions of a retailer vendor guide for a sourcing and manufacturing company. The vendor sent an updated version and you must analyze BOTH the new version (current) and the old version (previous), then produce a structured analysis.

Respond with VALID JSON only — no markdown, no commentary, no code fences. The JSON must have exactly this shape:

{
  "summary": "2-3 sentence summary of what the NEW version covers and why it matters to a vendor.",
  "tags": ["tag_from_fixed_list", "another_tag_from_fixed_list"],
  "freeform_tags": ["snake_case_topic"],
  "change_summary": "2-3 sentence plain-English summary of what changed between the old and new versions."
}

The "tags" and "freeform_tags" rules are the SAME as for a single document — analyze the NEW version's content. Use this fixed taxonomy for tags only:
- packaging, labeling, routing_shipping, edi_invoicing, compliance_legal, sustainability, rfid_barcoding, hazmat_safety, quality_qa, payment_terms, returns_chargebacks, product_data, testing_certifications

For "change_summary": focus on MEANINGFUL operational changes a vendor needs to act on. Keep it short — 2-3 sentences MAX. Lead with what was added, then what was removed, then what changed in scope/values. Examples:
- "Adds new RFID requirement for all SKUs over $25 retail. Routing portal URL updated. ASN deadline tightened from 24 to 12 hours before delivery."
- "Removes prior 30-day return window. Adds Prop 65 warning requirement on packaging."
- "No substantive operational changes — formatting and contact updates only."

If the documents appear identical or near-identical, say so. Do not invent changes. Be precise.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { guideId } = req.body || {};
  if (!guideId) return res.status(400).json({ error: 'Missing guideId' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY env var not set' });

  try {
    // 1. Mark as processing so the UI can show a spinner
    await sbPatch(`customer_vendor_guides?id=eq.${guideId}`, { processing_status: 'processing' });

    // 2. Fetch the guide row to get file_path and metadata
    const guides = await sbGet(`customer_vendor_guides?id=eq.${guideId}&select=file_path,file_name,version,previous_version_id`);
    if (!guides.length) {
      return res.status(404).json({ error: 'Guide not found' });
    }
    const guide = guides[0];

    // 3a. If this is a new version, fetch the previous version's file too
    let previousPdfBase64 = null;
    let previousFileName = null;
    if (guide.previous_version_id) {
      try {
        const prevGuides = await sbGet(`customer_vendor_guides?id=eq.${guide.previous_version_id}&select=file_path,file_name`);
        if (prevGuides.length) {
          const prev = prevGuides[0];
          previousFileName = prev.file_name;
          const prevSignR = await fetch(`${SB}/storage/v1/object/sign/vendor-guides/${prev.file_path}`, {
            method: 'POST',
            headers: {
              'apikey': SB_KEY,
              'Authorization': `Bearer ${SB_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ expiresIn: 300 })
          });
          if (prevSignR.ok) {
            const prevSignData = await prevSignR.json();
            const prevPdfR = await fetch(`${SB}/storage/v1${prevSignData.signedURL}`);
            if (prevPdfR.ok) {
              const prevBuf = await prevPdfR.arrayBuffer();
              if (prevBuf.byteLength > 100) {
                previousPdfBase64 = Buffer.from(prevBuf).toString('base64');
              }
            }
          }
        }
      } catch (prevErr) {
        // Don't fail the whole job — just fall back to single-document analysis
        console.log('Previous version fetch failed:', prevErr.message);
      }
    }

    // 3b. Generate signed URL for the new (current) PDF
    const signR = await fetch(`${SB}/storage/v1/object/sign/vendor-guides/${guide.file_path}`, {
      method: 'POST',
      headers: {
        'apikey': SB_KEY,
        'Authorization': `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ expiresIn: 300 })
    });
    if (!signR.ok) throw new Error(`Could not sign storage URL: HTTP ${signR.status}`);
    const signData = await signR.json();
    const pdfUrl = `${SB}/storage/v1${signData.signedURL}`;

    // 4. Download the new PDF
    const pdfR = await fetch(pdfUrl);
    if (!pdfR.ok) throw new Error(`PDF download failed: HTTP ${pdfR.status}`);
    const pdfBuffer = await pdfR.arrayBuffer();
    const pdfBytes = pdfBuffer.byteLength;
    if (pdfBytes < 100) throw new Error('PDF appears empty or corrupted');
    const pdfBase64 = Buffer.from(pdfBuffer).toString('base64');

    // 5. Send to Anthropic for analysis (single doc OR version diff)
    const result = previousPdfBase64
      ? await analyzeDiff(previousPdfBase64, previousFileName, pdfBase64, guide.file_name, ANTHROPIC_KEY)
      : await analyzePDF(pdfBase64, guide.file_name, ANTHROPIC_KEY);

    // 6. Validate and sanitize the response
    const tags = Array.isArray(result.tags)
      ? result.tags.filter(t => typeof t === 'string' && TAXONOMY.indexOf(t) !== -1)
      : [];
    const freeformTags = Array.isArray(result.freeform_tags)
      ? result.freeform_tags
          .filter(t => typeof t === 'string' && t.length > 0 && t.length < 50)
          .slice(0, 5)
      : [];
    const summary = (typeof result.summary === 'string' ? result.summary : '').slice(0, 1500);
    const changeSummary = (typeof result.change_summary === 'string' ? result.change_summary : '').slice(0, 1500) || null;

    // 7. Save results to DB
    const updatePayload = {
      ai_summary: summary,
      ai_tags: tags,
      ai_freeform_tags: freeformTags,
      processing_status: 'complete',
      analyzed_at: new Date().toISOString()
    };
    if (changeSummary) updatePayload.ai_change_summary = changeSummary;
    await sbPatch(`customer_vendor_guides?id=eq.${guideId}`, updatePayload);

    return res.status(200).json({
      success: true,
      summary,
      tags,
      freeform_tags: freeformTags,
      change_summary: changeSummary
    });
  } catch (err) {
    // Mark as failed so the UI shows the error
    try {
      await sbPatch(`customer_vendor_guides?id=eq.${guideId}`, {
        processing_status: 'failed',
        ai_summary: 'Analysis failed: ' + (err.message || 'Unknown error')
      });
    } catch (_) {
      // ignore
    }
    return res.status(500).json({ error: err.message });
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

async function sbPatch(path, body) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: {
      'apikey': SB_KEY,
      'Authorization': `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(`Supabase PATCH failed: ${e.message || 'HTTP ' + r.status}`);
  }
}

async function analyzePDF(pdfBase64, fileName, apiKey) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: pdfBase64
              }
            },
            {
              type: 'text',
              text: `Filename: ${fileName}\n\nAnalyze this vendor guide and respond with ONLY the JSON described above.`
            }
          ]
        }
      ]
    })
  });

  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(`Anthropic API: ${e.error?.message || 'HTTP ' + r.status}`);
  }

  const data = await r.json();
  const text = (data.content && data.content[0] && data.content[0].text) || '';

  // Strip code fences if Claude added them
  let jsonText = text.trim();
  if (jsonText.indexOf('```') === 0) {
    jsonText = jsonText.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }

  try {
    return JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`Could not parse Anthropic response as JSON: ${e.message}`);
  }
}

async function analyzeDiff(oldPdfBase64, oldFileName, newPdfBase64, newFileName, apiKey) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: DIFF_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `OLD VERSION (filename: ${oldFileName || 'previous'}):`
            },
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: oldPdfBase64
              }
            },
            {
              type: 'text',
              text: `NEW VERSION (filename: ${newFileName}):`
            },
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: newPdfBase64
              }
            },
            {
              type: 'text',
              text: 'Analyze the NEW version for summary/tags, AND describe what changed from OLD to NEW. Respond with ONLY the JSON described above.'
            }
          ]
        }
      ]
    })
  });

  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(`Anthropic API (diff): ${e.error?.message || 'HTTP ' + r.status}`);
  }

  const data = await r.json();
  const text = (data.content && data.content[0] && data.content[0].text) || '';

  let jsonText = text.trim();
  if (jsonText.indexOf('```') === 0) {
    jsonText = jsonText.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }

  try {
    return JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`Could not parse Anthropic diff response as JSON: ${e.message}`);
  }
}
