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
      window.location.href = '/tenant-login.html';
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
  if (!token) return window.location.href = '/tenant-login.html';
  let res;
  try {
    res = await fetch('/api/tenant-auth?action=validate', { headers: { 'Authorization': 'Bearer ' + token } });
  } catch (e) {
    console.error('[tenantAuth] network error', e);
    document.body.innerHTML = '<div style="color:#fca5a5;font-family:sans-serif;padding:40px;">Could not reach the server. Refresh to retry — you have not been signed out.</div>';
    return null;
  }
  if (!res.ok) { localStorage.removeItem('tenant_token'); return window.location.href = '/tenant-login.html'; }
  const data = await res.json();
  if (!data.valid) { localStorage.removeItem('tenant_token'); return window.location.href = '/tenant-login.html'; }
  return data.user;
}

function doLogout() {
  const token = localStorage.getItem('tenant_token');
  if (token) {
    fetch('/api/tenant-auth?action=logout', { method: 'POST', headers: { 'Authorization': 'Bearer ' + token } }).catch(() => {});
  }
  localStorage.removeItem('tenant_token');
  localStorage.removeItem('tenant_user');
  window.location.href = '/tenant-login.html';
}

// ── Sidebar definition ──
const TENANT_NAV = [
  { section: 'Overview', items: [
    { icon: '⊞', label: 'Dashboard', href: '/tenant-dashboard.html' },
    { icon: '💰', label: 'Financials', href: '/financials.html' },
    { icon: '🧠', label: 'Intel', href: '/tenant-intel.html' },
    { icon: '📰', label: 'Daily Intel', href: '/tenant-intel-daily.html' },
  ]},
  { section: 'Operations', items: [
    { icon: '📦', label: 'Open Orders', href: '/tenant-operations.html#orders' },
    { icon: '🏬', label: 'Warehouse', beta: true },
    { icon: '📒', label: 'Accounting', beta: true },
    { icon: '🔔', label: 'Credit Watch', href: '/tenant-operations.html#credit' },
    { icon: '📈', label: 'Forecasting', beta: true },
  ]},
  { section: 'Factories', items: [
    { icon: '🏭', label: 'All Factories', href: '/tenant-factories.html' },
    { icon: '⏳', label: 'Pending', href: '/tenant-factories.html#pending' },
    { icon: '📇', label: 'Card Scanner', href: '/scanner.html' },
    { icon: '🔍', label: 'Pending Reviews', href: '/tenant-factories.html#reviews' },
    { icon: '✉️', label: 'Invitations', href: '/tenant-factories.html#invitations' },
    { icon: '📌', label: 'RFQ Follow-ups', href: '/tenant-factories.html#followups' },
    { icon: '⚠️', label: 'Compliance Alerts', href: '/tenant-factories.html#compliance' },
    { icon: '📋', label: 'Compliance Rules', href: '/compliance-rules.html' },
  ]},
  { section: 'Communications', items: [
    { icon: '💬', label: 'Messages', href: '/tenant-communications.html' },
    { icon: '🎥', label: 'Zoom', href: '/zoom.html' },
    { icon: '👤', label: 'Allan', href: '/tenant-communications.html?tab=allan' },
    { icon: '🔎', label: 'Sourcing', href: '/tenant-communications.html?tab=sourcing' },
    { icon: '🛒', label: 'Sales', href: '/tenant-communications.html?tab=sales' },
    { icon: '🎨', label: 'Graphics', href: '/tenant-communications.html?tab=graphics' },
    { icon: '🧾', label: 'Accounting', href: '/tenant-communications.html?tab=accounting' },
    { icon: '🚚', label: 'Logistics', href: '/tenant-communications.html?tab=logistics' },
    { icon: '✅', label: 'Compliance', href: '/tenant-communications.html?tab=compliance' },
  ]},
  { section: 'RFQ & Products', items: [
    { icon: '📋', label: 'RFQs', href: '/tenant-rfq.html' },
    { icon: '🧪', label: 'Product Development', href: '/tenant-rfq.html#pd' },
    { icon: '📦', label: 'SKU Library', href: '/tenant-skus.html' },
  ]},
];

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Build + mount the sidebar. `user` is the validated user object.
function renderSidebar(user) {
  const tenantName = (user && user.tenant && user.tenant.name) || 'Tenant';
  const who = (user && (user.full_name || user.email)) || '—';

  const nav = TENANT_NAV.map(sec => {
    const items = sec.items.map(it => {
      if (it.beta) {
        return `<a class="nav-item beta" data-beta="1" href="#"><span class="icon">${it.icon}</span>${esc(it.label)}<span class="beta-tag">BETA</span></a>`;
      }
      return `<a class="nav-item" data-href="${esc(it.href)}" href="${esc(it.href)}"><span class="icon">${it.icon}</span>${esc(it.label)}</a>`;
    }).join('');
    return `<div class="nav-section">${esc(sec.section)}</div>${items}`;
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

  document.querySelectorAll('.nav-item.beta').forEach(el => {
    el.addEventListener('click', e => { e.preventDefault(); alert('Coming Soon — this module is in beta.'); });
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
