// ════════════════════════════════════════════════════════════════════
// /api/pull-retailer-edgar.js
//
// Pulls new SEC filings from EDGAR for tracked US retailers.
// Uses the public submissions JSON API — no auth, no key needed.
//
// POST body: { retailer_id?: uuid }  // omit to run for all active retailers
// Cron-friendly. Daily schedule recommended.
// ════════════════════════════════════════════════════════════════════

export const config = { runtime: 'nodejs' };
export const maxDuration = 300;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL = 'claude-sonnet-4-6';

// EDGAR requires a descriptive User-Agent with contact email per their fair-use policy
const EDGAR_USER_AGENT = 'TBG Sourcing Intel intel@tbgsourcing.net';

// Which form types to ingest and parse
const TARGET_FORMS = new Set(['10-K', '10-Q', '8-K', 'DEF 14A', 'DEFA14A', '20-F', '6-K']);

// Which form types are big enough to warrant Claude parsing
const PARSE_FORMS = new Set(['10-K', '10-Q', '8-K']);

async function sb(path, opts = {}) {
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...(opts.headers || {})
  };
  const r = await fetch(`${SUPABASE_URL}${path}`, { ...opts, headers });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Supabase ${r.status} ${path}: ${body}`);
  }
  if (r.status === 204) return null;
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

async function claudeMessage(messages, maxTokens = 2500) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: maxTokens, messages })
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${await r.text()}`);
  return r.json();
}

function extractJson(text) {
  let cleaned = text.trim().replace(/```json|```/g, '').trim();
  const fb = cleaned.indexOf('{') === -1 ? Infinity : cleaned.indexOf('{');
  const fbA = cleaned.indexOf('[') === -1 ? Infinity : cleaned.indexOf('[');
  const start = Math.min(fb, fbA);
  if (start === Infinity) throw new Error('No JSON');
  cleaned = cleaned.substring(start);
  const lb = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
  if (lb === -1) throw new Error('No closing brace');
  return JSON.parse(cleaned.substring(0, lb + 1));
}

// ────────────────────────────────────────────────────────────────────
// EDGAR fetch helpers
// ────────────────────────────────────────────────────────────────────

// EDGAR CIK must be 10 digits with leading zeros
function padCik(cik) {
  return String(cik || '').replace(/\D/g, '').padStart(10, '0');
}

// Fetch the submissions JSON for a company
async function fetchSubmissions(cik) {
  const url = `https://data.sec.gov/submissions/CIK${padCik(cik)}.json`;
  const r = await fetch(url, {
    headers: { 'User-Agent': EDGAR_USER_AGENT, 'Accept': 'application/json' }
  });
  if (!r.ok) throw new Error(`EDGAR submissions ${r.status} for CIK ${cik}`);
  return r.json();
}

// Parse the recent filings list into rows
function parseRecentFilings(subData) {
  const recent = subData.filings && subData.filings.recent;
  if (!recent) return [];
  const out = [];
  const len = (recent.accessionNumber || []).length;
  for (let i = 0; i < len; i++) {
    out.push({
      accession_number: recent.accessionNumber[i],
      form_type: recent.form[i],
      filing_date: recent.filingDate[i],
      report_date: recent.reportDate[i] || null,
      primary_document: recent.primaryDocument[i],
      primary_doc_description: recent.primaryDocDescription ? recent.primaryDocDescription[i] : null
    });
  }
  return out;
}

// Build URLs for a filing
function filingUrls(cik, filing) {
  const cikNoLead = String(parseInt(cik, 10));  // EDGAR URLs use cik without leading zeros
  const accNoDash = filing.accession_number.replace(/-/g, '');
  return {
    index_url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cikNoLead}&type=${filing.form_type}&dateb=&owner=include&count=40`,
    filing_url: `https://www.sec.gov/Archives/edgar/data/${cikNoLead}/${accNoDash}/`,
    primary_doc_url: `https://www.sec.gov/Archives/edgar/data/${cikNoLead}/${accNoDash}/${filing.primary_document}`
  };
}

// Fetch the primary document text for parsing
async function fetchFilingText(primaryDocUrl) {
  const r = await fetch(primaryDocUrl, {
    headers: { 'User-Agent': EDGAR_USER_AGENT }
  });
  if (!r.ok) throw new Error(`EDGAR doc ${r.status}: ${primaryDocUrl}`);
  return r.text();
}

// Strip HTML and collapse whitespace, then extract just the most relevant sections.
// 10-K and 10-Q filings can be 200-400 pages; we focus on Risk Factors, MD&A,
// Business segments, and Quantitative/Qualitative disclosures.
function extractRelevantSections(html, formType) {
  // Strip HTML tags
  let text = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#160;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (formType === '8-K') {
    // 8-Ks are short — return full text (cap at 80k chars to keep token cost reasonable)
    return text.substring(0, 80000);
  }

  // For 10-K/10-Q: find anchor headings and extract surrounding content
  const sections = [];
  const anchors = [
    { name: 'Risk Factors', patterns: [/risk\s+factors/i, /item\s+1a\.\s*risk\s+factors/i] },
    { name: 'MD&A', patterns: [/management['']s\s+discussion\s+and\s+analysis/i, /item\s+[27]\.\s*management/i] },
    { name: 'Business Overview', patterns: [/item\s+1\.\s*business/i, /business\s+overview/i] },
    { name: 'Quantitative and Qualitative Disclosures', patterns: [/quantitative\s+and\s+qualitative/i] },
    { name: 'Recent Developments', patterns: [/recent\s+developments/i, /subsequent\s+events/i] }
  ];

  for (const anchor of anchors) {
    for (const pat of anchor.patterns) {
      const m = text.match(pat);
      if (m) {
        const start = m.index;
        // Take ~15,000 chars from each anchor section
        const slice = text.substring(start, start + 15000);
        sections.push(`=== ${anchor.name} ===\n${slice}\n`);
        break;
      }
    }
  }

  if (sections.length === 0) {
    // Fallback: take first 40k chars
    return text.substring(0, 40000);
  }
  // Cap total at 60k chars
  return sections.join('\n\n').substring(0, 60000);
}

// ────────────────────────────────────────────────────────────────────
// AI parsing
// ────────────────────────────────────────────────────────────────────

async function parseFilingWithClaude(retailerName, formType, sectionsText) {
  const prompt = `You are reading an SEC filing for a US retailer that TBG (an off-price beauty/HBC sourcing company) sells into. Extract sourcing-relevant intel from the filing.

RETAILER: ${retailerName}
FORM TYPE: ${formType}

FILING SECTIONS:
${sectionsText}

Return ONLY valid JSON in this exact format:
{
  "summary": "2-3 sentence summary of what's most important in this filing for a sourcing-strategy reader at TBG",
  "signals": {
    "inventory_trend": "rising | falling | stable | not_mentioned — what direction is inventory moving?",
    "inventory_commentary": "1 sentence quote-style summary of inventory-related language, or null",
    "margin_pressure": "high | moderate | low | not_mentioned — what's the gross-margin pressure narrative?",
    "margin_commentary": "1 sentence, or null",
    "category_signals": ["array of category-level moves mentioned (e.g. 'expanding beauty assortment', 'exiting toys', 'private label growth in HBC')"],
    "private_label_intentions": "expanding | maintaining | shrinking | not_mentioned",
    "exec_moves": ["array of executive changes (e.g. 'CFO Jane Smith retiring', 'new Chief Merchant hired')"],
    "store_geography": "expanding | contracting | stable | not_mentioned",
    "new_store_count_mentioned": "if a specific number of new stores planned, list it; else null",
    "store_closure_count_mentioned": "if a specific number of closures, list it; else null",
    "capital_allocation_signals": ["array of mentions of capex, share buybacks, dividend changes, etc."],
    "supply_chain_commentary": "1 sentence on supply-chain language (freight, sourcing, tariffs, inventory turns), or null",
    "tariff_mentions": true | false,
    "macro_environment_view": "1 sentence on what management thinks about the consumer/economy, or null",
    "competitive_callouts": ["specific competitors named in the filing"]
  },
  "noteworthy_quotes": ["1-3 short direct quotes (max 25 words each) that are most useful for TBG"]
}

RULES:
- Use empty array [] or null when a signal isn't mentioned — do NOT invent
- Quotes should be exact short phrases, max 25 words each
- Be specific. "TJX expanding HomeGoods" is better than "expanding stores"
- Return only the JSON object, no preamble, no markdown`;

  const resp = await claudeMessage([{ role: 'user', content: prompt }], 2500);
  return extractJson(resp.content[0].text);
}

// ────────────────────────────────────────────────────────────────────
// MAIN HANDLER
// ────────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (!SUPABASE_URL || !SUPABASE_KEY || !ANTHROPIC_KEY) {
    return res.status(500).json({ error: 'Missing env vars' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const filterRetailerId = body && body.retailer_id;

  try {
    // Get list of retailers to process
    let retailersQuery = '/rest/v1/retailers?status=eq.active&cik=not.is.null';
    if (filterRetailerId) retailersQuery += `&id=eq.${filterRetailerId}`;
    const retailers = await sb(retailersQuery + '&select=*');

    if (!retailers || retailers.length === 0) {
      return res.status(200).json({ success: true, retailers_checked: 0, new_filings: 0 });
    }

    let totalNew = 0;
    const perRetailer = [];

    for (const r of retailers) {
      const runRows = await sb('/rest/v1/retailer_runs', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          retailer_id: r.id,
          run_type: 'edgar_filings',
          status: 'running',
          trigger_type: filterRetailerId ? 'manual' : 'scheduled'
        })
      });
      const runId = runRows[0].id;
      let newCountForRetailer = 0;

      try {
        // Get existing accession numbers so we only ingest new ones
        const existing = await sb(`/rest/v1/retailer_filings?retailer_id=eq.${r.id}&select=accession_number`);
        const existingAcc = new Set((existing || []).map(x => x.accession_number));

        // Fetch from EDGAR
        const subs = await fetchSubmissions(r.cik);
        const filings = parseRecentFilings(subs);

        // Filter to recent, target forms, and new (not already ingested)
        // Limit to last 90 days to avoid backfilling history
        const cutoff = new Date(Date.now() - 90 * 86400 * 1000);
        const toIngest = filings
          .filter(f => TARGET_FORMS.has(f.form_type))
          .filter(f => !existingAcc.has(f.accession_number))
          .filter(f => f.filing_date && new Date(f.filing_date) >= cutoff)
          .slice(0, 6);  // cap per retailer per run

        for (const f of toIngest) {
          const urls = filingUrls(r.cik, f);
          const row = {
            retailer_id: r.id,
            accession_number: f.accession_number,
            form_type: f.form_type,
            filing_date: f.filing_date,
            report_date: f.report_date,
            filing_url: urls.filing_url,
            primary_doc_url: urls.primary_doc_url,
            parse_status: 'pending'
          };

          // Parse with Claude if this form type warrants it
          if (PARSE_FORMS.has(f.form_type)) {
            try {
              const docText = await fetchFilingText(urls.primary_doc_url);
              const sections = extractRelevantSections(docText, f.form_type);
              const parsed = await parseFilingWithClaude(r.name, f.form_type, sections);
              row.ai_summary = parsed.summary || null;
              row.ai_extracted_signals = parsed.signals || null;
              row.parsed_sections = ['risk_factors', 'mda', 'business', 'recent_developments'];
              row.parse_status = 'success';
            } catch (parseErr) {
              row.parse_status = 'failed';
              row.parse_error = parseErr.message.substring(0, 500);
            }
          } else {
            row.parse_status = 'skipped';
          }

          await sb('/rest/v1/retailer_filings', {
            method: 'POST',
            body: JSON.stringify(row)
          });
          newCountForRetailer++;
        }

        totalNew += newCountForRetailer;

        await sb(`/rest/v1/retailer_runs?id=eq.${runId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            status: 'success',
            completed_at: new Date().toISOString(),
            new_filings_count: newCountForRetailer
          })
        });

        perRetailer.push({ retailer: r.name, new_filings: newCountForRetailer });

      } catch (err) {
        console.error(`EDGAR pull failed for ${r.name}:`, err);
        await sb(`/rest/v1/retailer_runs?id=eq.${runId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            status: 'failed',
            completed_at: new Date().toISOString(),
            error_message: err.message.substring(0, 500)
          })
        });
        perRetailer.push({ retailer: r.name, error: err.message });
      }
    }

    return res.status(200).json({
      success: true,
      retailers_checked: retailers.length,
      new_filings: totalNew,
      detail: perRetailer
    });

  } catch (err) {
    console.error('pull-retailer-edgar fatal:', err);
    return res.status(500).json({ error: err.message });
  }
}
