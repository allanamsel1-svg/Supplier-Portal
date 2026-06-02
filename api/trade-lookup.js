// /api/trade-lookup.js
//
// Server-side proxy for the Trade Intelligence module (trade_intelligence.html).
// The USITC HTS REST API sends no CORS headers, so it cannot be called from the
// browser directly; CBP CROSS is also proxied here for one consistent surface.
//
//   GET /api/trade-lookup?source=hts&q=<keyword|hts code>
//        → { source:'hts', query, results:[{ htsno, description, units,
//                                            general, special, other }] }
//
//   GET /api/trade-lookup?source=cross&q=<keyword|hts code>[&page=1]
//        → { source:'cross', query, totalHits,
//            results:[{ rulingNumber, rulingDate, subject, categories,
//                       collection, tariffs:[...], url }] }
//
// Notes:
//  - USITC: /reststop/search?keyword= returns description + units but no duty;
//    /reststop/exportList?from=&to=&format=JSON returns general/special/other
//    duty + units. The documented .../details/htsno/ path 404s, so we use these
//    two working endpoints (keyword → search + per-code enrichment; code →
//    exportList).
//  - CROSS: /api/search?term=&collection=ALL&pageSize=&page=&sortBy=RELEVANCE.

export const config = { runtime: 'nodejs' };

const HTS_BASE = 'https://hts.usitc.gov/reststop';
const CROSS_BASE = 'https://rulings.cbp.gov/api';
const MAX_HTS_ENRICH = 12; // cap parallel duty look-ups on keyword search

function fetchJson(url, ms = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } })
    .then(async (r) => {
      if (!r.ok) throw new Error('upstream ' + r.status);
      return r.json();
    })
    .finally(() => clearTimeout(t));
}

// A query is an HTS code if it is only digits and dots (e.g. 3304, 3304.10.00.00)
function looksLikeCode(q) {
  return /^[0-9][0-9.]{2,}$/.test(q.trim());
}
function normCode(q) {
  // keep digits/dots, collapse stray separators
  return q.trim().replace(/[^0-9.]/g, '');
}

async function htsByCode(code) {
  // to = code + '.99.99.99' is lexically >= the code and all of its children,
  // so a chapter heading returns its subtree and a full code returns one row.
  const url = `${HTS_BASE}/exportList?from=${encodeURIComponent(code)}&to=${encodeURIComponent(code + '.99.99.99')}&format=JSON&styles=true`;
  const rows = await fetchJson(url);
  return (Array.isArray(rows) ? rows : []).map((r) => ({
    htsno: r.htsno || '',
    description: r.description || '',
    units: Array.isArray(r.units) ? r.units : [],
    general: r.general || '',
    special: r.special || '',
    other: r.other || '',
  }));
}

async function htsByKeyword(keyword) {
  const url = `${HTS_BASE}/search?keyword=${encodeURIComponent(keyword)}`;
  const hits = await fetchJson(url);
  const list = (Array.isArray(hits) ? hits : [])
    .filter((h) => h && h.htsno)
    .slice(0, 25)
    .map((h) => ({
      htsno: h.htsno,
      description: h.description || '',
      units: Array.isArray(h.units) ? h.units : [],
      general: '',
      special: '',
      other: '',
    }));

  // Enrich the first N rows with duty rates via per-code exportList (parallel).
  const toEnrich = list.slice(0, MAX_HTS_ENRICH);
  await Promise.all(
    toEnrich.map(async (row) => {
      try {
        const url2 = `${HTS_BASE}/exportList?from=${encodeURIComponent(row.htsno)}&to=${encodeURIComponent(row.htsno)}&format=JSON&styles=true`;
        const rows = await fetchJson(url2, 15000);
        const match = (Array.isArray(rows) ? rows : []).find((r) => r.htsno === row.htsno) || (rows && rows[0]);
        if (match) {
          row.general = match.general || '';
          row.special = match.special || '';
          row.other = match.other || '';
          if ((!row.units || !row.units.length) && Array.isArray(match.units)) row.units = match.units;
        }
      } catch { /* leave duty blank on enrichment failure */ }
    })
  );
  return list;
}

async function crossSearch(term, page) {
  const url = `${CROSS_BASE}/search?term=${encodeURIComponent(term)}&collection=ALL&pageSize=30&page=${page || 1}&sortBy=RELEVANCE`;
  const data = await fetchJson(url, 25000);
  const rulings = (data && Array.isArray(data.rulings)) ? data.rulings : [];
  return {
    totalHits: (data && data.totalHits) || rulings.length,
    results: rulings.map((r) => ({
      rulingNumber: r.rulingNumber || '',
      rulingDate: r.rulingDate ? String(r.rulingDate).slice(0, 10) : '',
      subject: r.subject || '',
      categories: r.categories || '',
      collection: r.collection || '',
      tariffs: Array.isArray(r.tariffs) ? r.tariffs.map((t) => String(t).replace(/^:/, '')) : [],
      url: r.rulingNumber ? `https://rulings.cbp.gov/ruling/${encodeURIComponent(r.rulingNumber)}` : '',
    })),
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const source = (req.query.source || '').toString().toLowerCase();
  const q = (req.query.q || '').toString().trim();
  if (!q) return res.status(400).json({ error: 'Missing q' });

  try {
    if (source === 'hts') {
      const results = looksLikeCode(q) ? await htsByCode(normCode(q)) : await htsByKeyword(q);
      return res.status(200).json({ source: 'hts', query: q, results });
    }
    if (source === 'cross') {
      const page = parseInt(req.query.page, 10) || 1;
      const { totalHits, results } = await crossSearch(q, page);
      return res.status(200).json({ source: 'cross', query: q, totalHits, results });
    }
    return res.status(400).json({ error: "source must be 'hts' or 'cross'" });
  } catch (e) {
    return res.status(502).json({ error: 'Upstream lookup failed', detail: String(e && e.message || e) });
  }
}
