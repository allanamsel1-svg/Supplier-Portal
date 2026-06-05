// tenant-shared.js — shared auth, Supabase access, and sidebar for tenant portal pages.
// Loaded by tenant-factories.html / tenant-rfq.html / tenant-skus.html.

// ── Supabase (anon, read-only) ──
const SUPA_URL = 'https://mjkjubctswjwjihxjpnd.supabase.co';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1qa2p1YmN0c3dqd2ppaHhqcG5kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczNjQxNjcsImV4cCI6MjA5Mjk0MDE2N30.cZrD_ymrDsRPyfX_g3hUui5_JXuW6BgE77QkIoGpqHo';

async function supa(path) {
  try {
    const res = await fetch(SUPA_URL + '/rest/v1/' + path, {
      headers: { 'apikey': SUPA_KEY, 'Authorization': 'Bearer ' + SUPA_KEY }
    });
    // Global auth guard: any 401/403 clears the session and bounces to login.
    if (res.status === 401 || res.status === 403) {
      console.warn('[supa] auth rejected (' + res.status + ') — clearing session', path);
      localStorage.removeItem('tenant_token');
      localStorage.removeItem('tenant_user');
      window.location.href = 'tenant-login.html';
      return [];
    }
    if (!res.ok) {
      console.error('[supa] query failed', res.status, path, await res.text().catch(() => ''));
      return [];
    }
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.error('[supa] network error', path, e);
    return [];
  }
}

// ── Auth ── (validate token from localStorage; redirect to login if invalid)
async function tenantAuth() {
  const token = localStorage.getItem('tenant_token');
  if (!token) return window.location.href = 'tenant-login.html';
  let res;
  try {
    res = await fetch('/api/tenant-auth?action=validate', { headers: { 'Authorization': 'Bearer ' + token } });
  } catch (e) {
    console.error('[tenantAuth] network error', e);
    document.body.innerHTML = '<div style="color:#fca5a5;font-family:sans-serif;padding:40px;">Could not reach the server. Refresh to retry — you have not been signed out.</div>';
    return null;
  }
  if (!res.ok) { localStorage.removeItem('tenant_token'); return window.location.href = 'tenant-login.html'; }
  const data = await res.json();
  if (!data.valid) { localStorage.removeItem('tenant_token'); return window.location.href = 'tenant-login.html'; }
  return data.user;
}

function doLogout() {
  const token = localStorage.getItem('tenant_token');
  if (token) {
    fetch('/api/tenant-auth?action=logout', { method: 'POST', headers: { 'Authorization': 'Bearer ' + token } }).catch(() => {});
  }
  localStorage.removeItem('tenant_token');
  localStorage.removeItem('tenant_user');
  window.location.href = 'tenant-login.html';
}

// ── Theme (dark default; persisted to localStorage 'tenant_theme') ──
function applySavedTheme() {
  const theme = localStorage.getItem('tenant_theme') || 'dark';
  document.body.classList.toggle('light-mode', theme === 'light');
  const btn = document.getElementById('themeToggleBtn');
  if (btn) btn.textContent = theme === 'light' ? '🌙' : '☀️';
}
function toggleTheme() {
  const isLight = document.body.classList.toggle('light-mode');
  localStorage.setItem('tenant_theme', isLight ? 'light' : 'dark');
  const btn = document.getElementById('themeToggleBtn');
  if (btn) btn.textContent = isLight ? '🌙' : '☀️';
}
// Apply the saved theme as early as possible (script loads at end of <body>).
try { if (document.body) applySavedTheme(); } catch (e) {}

// ── Fixed top header ──
function renderHeader(user) {
  if (document.getElementById('tenantHeader')) return;
  const tenantName = (user && user.tenant && user.tenant.name) || 'Tenant';
  // "← Dashboard" link, hidden when we're already on the dashboard page.
  const onDashboard = window.location.pathname.includes('tenant-dashboard.html');
  const dashLink =
    '<a class="th-dashlink" href="tenant-dashboard.html" style="' +
      'margin-left:24px;color:var(--text2);font-size:13px;text-decoration:none;white-space:nowrap;' +
      (onDashboard ? 'display:none;' : '') +
      '" onmouseover="this.style.textDecoration=\'underline\'" ' +
      'onmouseout="this.style.textDecoration=\'none\'">← Dashboard</a>';
  const html =
    '<div class="tenant-header" id="tenantHeader">' +
      '<div class="th-left" style="display:flex;align-items:center;">' +
        '<div class="th-logo">TBG Sourcing</div>' +
        dashLink +
      '</div>' +
      '<div class="th-right">' +
        '<button class="th-btn" id="themeToggleBtn" title="Toggle light/dark">☀️</button>' +
        '<span class="th-tenant">' + esc(tenantName) + '</span>' +
        '<button class="th-signout" id="headerSignOut">Sign Out</button>' +
      '</div>' +
    '</div>' +
    '<div class="gauge-sticky" id="gaugeStickyBar">' +
      '<div class="gauge-sticky-fill" id="gaugeStickyFill"></div>' +
      '<span class="gauge-sticky-tooltip" id="gaugeStickyTip"></span>' +
    '</div>';
  document.body.insertAdjacentHTML('afterbegin', html);
  document.getElementById('themeToggleBtn').addEventListener('click', toggleTheme);
  document.getElementById('headerSignOut').addEventListener('click', doLogout);
  applySavedTheme();
}

// ── Sidebar definition ──
// All hrefs are RELATIVE (no domain, no leading slash) — internal nav only.
// Each item carries a `feature` key matched against the tenant's features JSONB.
// feature:null = always shown (Dashboard). Intel is intentionally absent (admin-only for now).
const TENANT_NAV = [
  { section: 'Overview', items: [
    { icon: '⊞', label: 'Dashboard', href: 'tenant-dashboard.html', feature: null },
    { icon: '💰', label: 'Financials', href: 'tenant-financials.html', feature: 'financials' },
  ]},
  { section: 'Operations', items: [
    { icon: '📦', label: 'Open Orders', href: 'tenant-operations.html#orders', feature: 'po_management' },
    { icon: '🏬', label: 'Warehouse', href: 'tenant-operations.html#warehouse', badge: 'BETA', feature: 'warehouse' },
    { icon: '📒', label: 'Accounting', href: 'tenant-operations.html#accounting', badge: 'BETA', feature: 'accounting' },
    { icon: '🔔', label: 'Credit Watch', href: 'tenant-operations.html#credit', feature: 'credit_watch' },
    { icon: '🔍', label: 'Inspections', href: 'tenant-operations.html#inspections', feature: 'inspections' },
    { icon: '📜', label: 'Certifications', href: 'tenant-operations.html#certifications', feature: 'factory_portal' },
    { icon: '📈', label: 'Forecasting', href: 'tenant-operations.html#forecasting', badge: 'BETA', feature: 'forecasting' },
  ]},
  { section: 'Factories', items: [
    { icon: '🏭', label: 'All Factories', href: 'tenant-factories.html', feature: 'factory_portal' },
    { icon: '🗂', label: 'Factory Audits', href: 'tenant-factories.html#audits', feature: 'factory_portal' },
    { icon: '🎨', label: 'Artwork', href: 'tenant-operations.html#artwork', feature: 'factory_portal' },
    { icon: '⏳', label: 'Pending', href: 'tenant-factories.html#pending', feature: 'factory_pending' },
    { icon: '📇', label: 'Card Scanner', href: 'tenant-factories.html#scanner', feature: 'card_scanner' },
    { icon: '🔍', label: 'Pending Reviews', href: 'tenant-factories.html#reviews', feature: 'factory_reviews' },
    { icon: '✉️', label: 'Invitations', href: 'tenant-factories.html#invitations', feature: 'factory_invitations' },
    { icon: '📌', label: 'RFQ Follow-ups', href: 'tenant-factories.html#followups', feature: 'rfq_followups' },
    { icon: '⚠️', label: 'Compliance Alerts', href: 'tenant-factories.html#compliance', feature: 'compliance' },
    { icon: '📋', label: 'Compliance Rules', href: 'tenant-factories.html#compliance-rules', feature: 'compliance' },
  ]},
  { section: 'Communications', items: [
    { icon: '💬', label: 'Messages', href: 'tenant-communications.html', feature: 'communications' },
    { icon: '🎥', label: 'Zoom', href: 'tenant-communications.html#zoom', feature: 'zoom' },
    { icon: '👤', label: 'Allan', href: 'tenant-communications.html?tab=allan', feature: 'communications' },
    { icon: '🔎', label: 'Sourcing', href: 'tenant-communications.html?tab=sourcing', feature: 'communications' },
    { icon: '🛒', label: 'Sales', href: 'tenant-communications.html?tab=sales', feature: 'communications' },
    { icon: '🎨', label: 'Graphics', href: 'tenant-communications.html?tab=graphics', feature: 'communications' },
    { icon: '🧾', label: 'Accounting', href: 'tenant-communications.html?tab=accounting', feature: 'communications' },
    { icon: '🚚', label: 'Logistics', href: 'tenant-communications.html?tab=logistics', feature: 'communications' },
    { icon: '✅', label: 'Compliance', href: 'tenant-communications.html?tab=compliance', feature: 'communications' },
  ]},
  { section: 'RFQ & Products', items: [
    { icon: '📋', label: 'RFQs', href: 'tenant-rfq.html#rfq', feature: 'rfq' },
    { icon: '🧪', label: 'Product Development', href: 'tenant-rfq.html#pd', feature: 'product_development' },
    { icon: '📦', label: 'SKU Library', href: 'tenant-rfq.html#skus', feature: 'sku_library' },
  ]},
];

// Tenant feature flags (set in renderSidebar from the validated user).
let TENANT_FEATURES = {};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Build + mount the sidebar. `user` is the validated user object.
function renderSidebar(user) {
  renderHeader(user);
  const tenantName = (user && user.tenant && user.tenant.name) || 'Tenant';
  const who = (user && (user.full_name || user.email)) || '—';
  TENANT_FEATURES = (user && user.tenant && user.tenant.features) || {};

  // An item shows only if its feature is null (always-on) or enabled (=== true).
  const allowed = it => it.feature == null || TENANT_FEATURES[it.feature] === true;

  const nav = TENANT_NAV.map(sec => {
    const items = sec.items.filter(allowed).map(it => {
      const badge = it.badge ? `<span class="beta-tag">${esc(it.badge)}</span>` : '';
      return `<a class="nav-item" data-href="${esc(it.href)}" href="${esc(it.href)}"><span class="icon">${it.icon}</span>${esc(it.label)}${badge}</a>`;
    }).join('');
    // Hide the whole section if no items survived the feature filter.
    if (!items) return '';
    const code = sec.section.toLowerCase().replace(/\s*&\s*/g, '-').replace(/\s+/g, '-');
    return `<div class="nav-section collapsible" data-section="${esc(code)}">${esc(sec.section)} <span class="nav-collapse-icon">▾</span></div>${items}`;
  }).join('');

  const html = `
    <div class="sidebar">
      <div class="sidebar-logo">
        <div class="wordmark">TBG Sourcing</div>
        <div class="tenant-name">${esc(tenantName)}</div>
      </div>
      <nav class="sidebar-nav">${nav}</nav>
      <div class="sidebar-footer">
        <div class="user-info">Signed in as<br><span class="user-name">${esc(who)}</span></div>
        <button class="btn-logout" id="tenantLogoutBtn">Sign Out</button>
      </div>
    </div>`;

  const mount = document.getElementById('sidebar');
  if (mount) mount.outerHTML = html;
  else document.body.insertAdjacentHTML('afterbegin', html);

  document.getElementById('tenantLogoutBtn').addEventListener('click', doLogout);

  // Collapsible nav sections (mirrors the admin sidebar), persisted to localStorage.
  document.querySelectorAll('.nav-section.collapsible').forEach(function(sec) {
    sec.addEventListener('click', function() {
      var code = sec.dataset.section;
      var isCollapsed = sec.classList.toggle('collapsed');
      localStorage.setItem('nav_collapsed_' + code, isCollapsed ? '1' : '0');
      var icon = sec.querySelector('.nav-collapse-icon');
      if (icon) icon.textContent = isCollapsed ? '▸' : '▾';
      var el = sec.nextElementSibling;
      while (el && !el.classList.contains('nav-section')) {
        el.style.display = isCollapsed ? 'none' : '';
        el = el.nextElementSibling;
      }
    });
    // Restore saved state
    var code = sec.dataset.section;
    var saved = localStorage.getItem('nav_collapsed_' + code);
    if (saved === '1') {
      sec.classList.add('collapsed');
      var icon = sec.querySelector('.nav-collapse-icon');
      if (icon) icon.textContent = '▸';
      var el = sec.nextElementSibling;
      while (el && !el.classList.contains('nav-section')) {
        el.style.display = 'none';
        el = el.nextElementSibling;
      }
    }
  });

  highlightNav();
  window.addEventListener('hashchange', highlightNav);
}

// Highlight the nav item matching the current page (pathname) AND its hash/query.
// Suffix = the page's #hash if present, else its ?query (e.g. ?tab=sales), else ''.
function highlightNav() {
  const path = location.pathname.split('/').pop() || 'tenant-dashboard.html';
  const suffix = location.hash || location.search || '';
  const items = Array.from(document.querySelectorAll('.nav-item[data-href]'));
  items.forEach(el => el.classList.remove('active'));

  let exact = null, pageDefault = null;
  items.forEach(el => {
    const href = el.getAttribute('data-href');
    const parts = href.split(/(?=[#?])/);      // split before the first # or ?
    const itemPath = parts[0].split('/').pop();
    const itemSuffix = parts[1] || '';
    if (itemPath !== path) return;
    if (itemSuffix === suffix) exact = el;      // same page + same hash/query
    if (!itemSuffix) pageDefault = pageDefault || el; // hash/query-less item for this page
  });

  const best = exact || pageDefault;
  if (best) best.classList.add('active');
}

// ── Formatting helpers ──
function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d)) return '—';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}
function money(n) {
  if (n == null || n === '' || isNaN(Number(n))) return '—';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function pct(n) {
  if (n == null || n === '' || isNaN(Number(n))) return '—';
  return Number(n).toFixed(1) + '%';
}
function statusBadge(status) {
  const s = String(status || '').toLowerCase();
  let cls = 'badge-gray';
  if (/(approved|active|live|quoted|confirmed|resolved|accepted|complete)/.test(s)) cls = 'badge-green';
  else if (/(pending|draft|review|sent|submitted|open|in_progress|in progress)/.test(s)) cls = 'badge-amber';
  else if (/(rejected|expired|archived|cancelled|canceled|overdue|failed)/.test(s)) cls = 'badge-red';
  else if (s) cls = 'badge-blue';
  return `<span class="badge ${cls}">${esc(status || 'unknown')}</span>`;
}
function list(arr) {
  if (!Array.isArray(arr) || !arr.length) return '';
  return arr.filter(Boolean).join(', ');
}

// ── Detail panel helpers (expects #panelOverlay, #detailPanel, #panelTitle, #panelSub, #panelBody in the page) ──
function openPanel(title, sub, bodyHtml) {
  document.getElementById('panelTitle').innerHTML = esc(title);
  document.getElementById('panelSub').innerHTML = sub ? esc(sub) : '';
  document.getElementById('panelBody').innerHTML = bodyHtml;
  document.getElementById('panelOverlay').classList.add('open');
  document.getElementById('detailPanel').classList.add('open');
}
function closePanel() {
  document.getElementById('panelOverlay').classList.remove('open');
  document.getElementById('detailPanel').classList.remove('open');
}
function kv(pairs) {
  const rows = pairs.filter(p => p[1] != null && p[1] !== '' && p[1] !== '—')
    .map(p => `<dt>${esc(p[0])}</dt><dd>${p[2] ? p[1] : esc(p[1])}</dd>`).join('');
  return rows ? `<dl class="kv">${rows}</dl>` : '<div class="empty" style="padding:12px;">No details.</div>';
}
