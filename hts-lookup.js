// hts-lookup.js — shared client-side HTS / USITC service.
//
// Loaded via <script src="hts-lookup.js"> by admin.html and setup.html. There is
// ONE USITC engine — the server proxy api/trade-lookup.js?source=hts — and these
// functions are the single client wrapper around it. All entry points use them:
//   • Manual: the Setup → HTS Lookup tab (htsUsitcSearch)
//   • Automatic AI cross-checks (usitcVerify):
//       - admin.html suggestDutyTariff  (RFQ / Margin Calculator)
//       - admin.html aiSuggestHTSPD     (PD costing sheet)
//       - setup.html aiSuggestHTS       (SKU costing)
// Same engine, same data source — no separate implementations.

// Valid HTS format: 4.2 (3304.10), 4.2.4 (3304.10.0000) or full 4.2.2.2
// (3304.10.00.00). Empty is allowed (the field is optional at entry points).
function isValidHts(v) {
  if (v == null) return true;
  var s = String(v).trim();
  if (!s) return true;
  return /^\d{4}\.\d{2}(\.\d{4}|\.\d{2}(\.\d{2})?)?$/.test(s);
}

// Parse a USITC "general" duty string into a numeric percent ("Free"→0, "3.4%"→3.4).
function parseDutyPct(general) {
  if (general == null) return null;
  var s = String(general).trim();
  if (!s) return null;
  if (/free/i.test(s)) return 0;
  var m = s.match(/([0-9]+(?:\.[0-9]+)?)\s*%/);
  return m ? parseFloat(m[1]) : null;
}

// Full manual HTS search (keyword or code). Returns the normalized results array
// from the proxy: [{ htsno, description, units, general, special, other }].
async function htsUsitcSearch(query) {
  var r = await fetch('/api/trade-lookup?source=hts&q=' + encodeURIComponent(query));
  var d = await r.json().catch(function () { return {}; });
  if (!r.ok) throw new Error((d && d.error) || ('HTTP ' + r.status));
  return d.results || [];
}

// CBP CROSS rulings search (keyword or HTS code) via the same proxy.
// Returns { totalHits, results:[{ rulingNumber, rulingDate, subject, categories,
// collection, tariffs, url }] }.
async function htsCrossSearch(query, page) {
  var r = await fetch('/api/trade-lookup?source=cross&q=' + encodeURIComponent(query) + (page ? '&page=' + page : ''));
  var d = await r.json().catch(function () { return {}; });
  if (!r.ok) throw new Error((d && d.error) || ('HTTP ' + r.status));
  return { totalHits: d.totalHits || (d.results || []).length, results: d.results || [] };
}

// A query looks like an HTS code if it is only digits and dots.
function looksLikeHts(q) { return /^[0-9][0-9.]{2,}$/.test((q || '').trim()); }

// Log a manual search to trade_intelligence_searches (fire-and-forget).
// fields: { hts_code?, keyword?, ruling_number? }
function logTradeSearch(fields) {
  try {
    var SB_URL = (typeof SB !== 'undefined' && SB) || 'https://mjkjubctswjwjihxjpnd.supabase.co';
    var SB_KEY = (typeof KEY !== 'undefined' && KEY) || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1qa2p1YmN0c3dqd2ppaHhqcG5kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczNjQxNjcsImV4cCI6MjA5Mjk0MDE2N30.cZrD_ymrDsRPyfX_g3hUui5_JXuW6BgE77QkIoGpqHo';
    var admin = 'admin'; try { admin = localStorage.getItem('admin_user') || 'admin'; } catch (e) {}
    fetch(SB_URL + '/rest/v1/trade_intelligence_searches', { method: 'POST', headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(Object.assign({ admin_id: admin }, fields)) }).catch(function () {});
  } catch (e) {}
}

// Cross-check an AI-estimated HTS code against real USITC data. Returns
// { ok, matched, row, msg }.
async function usitcVerify(htsCode) {
  var out = { ok: false, matched: false, row: null, msg: '' };
  if (!htsCode) return out;
  try {
    var r = await fetch('/api/trade-lookup?source=hts&q=' + encodeURIComponent(htsCode));
    var d = await r.json().catch(function () { return {}; });
    if (!r.ok) { out.msg = 'USITC check unavailable'; return out; }
    out.ok = true;
    var rows = d.results || [];
    var norm = function (s) { return String(s || '').replace(/[^0-9]/g, ''); };
    var nq = norm(htsCode);
    var hit = rows.filter(function (x) { return norm(x.htsno); }).find(function (x) { return norm(x.htsno) === nq; })
      || rows.find(function (x) { var nx = norm(x.htsno); return nx && (nx.indexOf(nq) === 0 || nq.indexOf(nx) === 0); });
    if (hit) {
      out.matched = true; out.row = hit;
      out.msg = '✓ USITC verified — ' + hit.htsno + ': ' + hit.description + ' · Duty (General): ' + (hit.general || 'n/a') + ((hit.units && hit.units.length) ? ' · Unit: ' + hit.units.join('/') : '');
    } else {
      out.msg = '⚠ HTS ' + htsCode + ' not found in USITC — unverified';
    }
  } catch (e) { out.msg = 'USITC check failed'; }
  return out;
}

function usitcColor(uv) { return uv.matched ? '#1a7a1a' : (uv.ok ? '#b00' : '#886600'); }
