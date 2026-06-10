// Last updated: 2026-06-09 — force redeploy
// admin-shared.js — fixed-position collapsible sidebar for all admin pages.
// position:fixed left rail + body padding-left:190px — no DOM manipulation.
(function () {
  'use strict';

  var CURRENT = (location.pathname.split('/').pop() || 'admin.html').toLowerCase();
  var IS_ADMIN_HOME = CURRENT === 'admin.html';
  var STORE_KEY = 'admin_sidebar_sections';

  var NAV = [
    // ============================================================
    // ⛔ CRITICAL — NEVER MODIFY THIS OVERVIEW SECTION ⛔
    // This section MUST always contain exactly these 7 items.
    // Any prompt that touches admin-shared.js MUST preserve this block verbatim.
    // DO NOT add, remove, or reorder items here under any circumstances.
    // ============================================================
    { section: 'Overview', items: [
      { icon: '▦',  label: 'Dashboard',    panel: 'dashboard' },
      { icon: '💰', label: 'Financials',   href: 'financials.html' },
      { icon: '🎯', label: 'Intel Daily',  href: 'intel_daily.html' },
      { icon: '👥', label: 'Tenants',      href: 'tenant-admin.html' },
      { icon: '📤', label: 'Upload Files', panel: 'upload' },
      { icon: '🗺', label: 'System',       href: 'roadmap.html' },
      { icon: '⚙',  label: 'Settings',     panel: 'settings' },
    ]},
    { section: 'Operations', items: [
      { icon: '📋', label: 'Open Orders',    href: 'tenant-operations.html#orders' },
      { icon: '🔍', label: 'Inspections',    href: 'tenant-operations.html#inspections' },
      { icon: '🗂', label: 'Factory Audits', href: 'tenant-operations.html#certifications' },
      { icon: '🎨', label: 'Artwork',        href: 'tenant-operations.html#artwork' },
      { icon: '📦', label: 'Warehouse',      href: 'tenant-operations.html#warehouse',  badge: 'BETA' },
      { icon: '💰', label: 'Accounting',     href: 'tenant-operations.html#accounting', badge: 'BETA' },
      { icon: '🔔', label: 'Credit Watch',   href: 'tenant-operations.html#credit' },
      { icon: '🔮', label: 'Forecasting',    href: 'tenant-operations.html#forecasting', badge: 'BETA' },
      { icon: '📊', label: 'Projections',    href: 'projections.html' },
    ]},
    { section: 'Factories', items: [
      { icon: '🏭', label: 'All Factories',    href: 'tenant-factories.html' },
      { icon: '⏳', label: 'Pending',          href: 'tenant-factories.html#pending' },
      { icon: '📇', label: 'Card Scanner',     href: 'tenant-factories.html#scanner' },
      { icon: '⚠',  label: 'Pending Reviews', href: 'tenant-factories.html#reviews' },
      { icon: '✉',  label: 'Invitations',      href: 'tenant-factories.html#invitations' },
      { icon: '⏰', label: 'RFQ Follow-ups',   href: 'tenant-factories.html#followups' },
      { icon: '🛡', label: 'Compliance Alerts',href: 'tenant-factories.html#compliance' },
      { icon: '📋', label: 'Compliance Rules', href: 'tenant-factories.html#compliance-rules' },
    ]},
    { section: 'Communications', items: [
      { icon: '💬', label: 'Messages',   href: 'tenant-communications.html' },
      { icon: '🎥', label: 'Zoom',       href: 'tenant-communications.html?tab=zoom' },
      { icon: '👤', label: 'Allan',      href: 'tenant-communications.html?tab=allan' },
      { icon: '📬', label: 'Sourcing',   href: 'tenant-communications.html?tab=sourcing' },
      { icon: '💼', label: 'Sales',      href: 'tenant-communications.html?tab=sales' },
      { icon: '🎨', label: 'Graphics',   href: 'tenant-communications.html?tab=graphics' },
      { icon: '💰', label: 'Accounting', href: 'tenant-communications.html?tab=accounting' },
      { icon: '🚚', label: 'Logistics',  href: 'tenant-communications.html?tab=logistics' },
      { icon: '✅', label: 'Compliance', href: 'tenant-communications.html?tab=compliance' },
    ]},
    { section: 'RFQ & Products', items: [
      { icon: '📋', label: 'RFQs',            href: 'tenant-rfq.html#rfq' },
      { icon: '🧪', label: 'Product Dev',     href: 'tenant-rfq.html#pd' },
      { icon: '🎨', label: 'Designer Queue',  href: '/designer-portal.html' },
      { icon: '📦', label: 'SKU Library',     href: 'tenant-rfq.html#skus' },
      { icon: '⚙', label: 'SKU Setup', href: 'tenant-rfq.html#skusetup' },
    ]},
    { section: 'System', items: [
      { icon: '⚙️', label: 'Setup', href: '/setup.html' },
      { icon: '🏆', label: 'Competitor Analysis', href: '/competitor-analysis.html' },
    ]},
  ];

  // Runtime assertion — fails loudly in the console if the locked Overview items ever go missing.
  // (Adapted to this file's actual sidebar array `NAV` / section name 'Overview'.)
  const _REQUIRED_ADMIN_OVERVIEW = ['Dashboard','Financials','Intel Daily','Tenants','Upload Files','System','Settings'];
  const _adminOverview = NAV.find(s => (s.section || s.title || '').toUpperCase() === 'OVERVIEW');
  if (_adminOverview) {
    const _missing = _REQUIRED_ADMIN_OVERVIEW.filter(l => !_adminOverview.items.some(i => i.label === l));
    if (_missing.length > 0) console.error('⛔ CRITICAL: Missing admin Overview items:', _missing);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var CSS = [
    '#admin-sidebar{position:fixed;top:0;left:0;bottom:0;width:190px;z-index:200;background:#fff;border-right:1px solid #e0e0d8;overflow-y:auto;padding:0 0 24px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-sizing:border-box;}',
    'body.admin-has-sidebar{padding-left:190px!important;box-sizing:border-box;}',
    '#admin-sidebar .sb-logo{padding:14px 16px 10px;}',
    '#admin-sidebar .sb-wordmark{font-size:14px;font-weight:700;color:#1a1a2e;letter-spacing:0.02em;}',
    '#admin-sidebar .sb-sub{font-size:11px;color:#aaa;margin-top:2px;}',
    '#admin-sidebar .sb-head{font-size:10px;font-weight:600;color:#bbb;text-transform:uppercase;letter-spacing:0.08em;padding:0 16px;margin:12px 0 3px;cursor:pointer;user-select:none;display:flex;align-items:center;}',
    '#admin-sidebar .sb-head:hover{color:#888;}',
    '#admin-sidebar .sb-chev{margin-left:auto;font-size:8px;color:#ccc;}',
    '#admin-sidebar .sb-items{overflow:hidden;transition:max-height 0.25s ease;max-height:600px;}',
    '#admin-sidebar .sb-sec.collapsed .sb-items{max-height:0;}',
    '#admin-sidebar .sb-item{display:flex;align-items:center;gap:8px;padding:7px 10px;margin:1px 6px;border-radius:7px;font-size:13px;color:#666;cursor:pointer;text-decoration:none;transition:background 0.1s,color 0.1s;}',
    '#admin-sidebar .sb-item:hover{background:#f5f5f0;color:#1a1a2e;}',
    '#admin-sidebar .sb-item.active,#admin-sidebar .sb-item.on{background:#e8f0ff;color:#2244cc;font-weight:600;}',
    '#admin-sidebar .sb-icon{font-size:13px;width:16px;text-align:center;flex-shrink:0;}',
    '#admin-sidebar .sb-label{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '#admin-sidebar .sb-badge{font-size:9px;padding:1px 5px;border-radius:8px;font-weight:600;flex-shrink:0;}',
    '#admin-sidebar .sb-beta{background:#fff8e0;color:#886600;border:1px solid #f0d860;}',
    '#admin-sidebar .sb-new{background:#e8f0ff;color:#2244cc;border:1px solid #b8ccf0;}',
    '#admin-sidebar .sb-count{margin-left:auto;font-size:11px;background:#e8e8e0;color:#888;padding:1px 6px;border-radius:10px;flex-shrink:0;min-width:18px;text-align:center;}',
    'body.admin-dark #admin-sidebar{background:#0d1424;border-color:#1e2d47;}',
    'body.admin-dark #admin-sidebar .sb-wordmark{color:#e2e8f0;}',
    'body.admin-dark #admin-sidebar .sb-sub{color:#475569;}',
    'body.admin-dark #admin-sidebar .sb-head{color:#475569;}',
    'body.admin-dark #admin-sidebar .sb-head:hover{color:#94a3b8;}',
    'body.admin-dark #admin-sidebar .sb-item{color:#94a3b8;}',
    'body.admin-dark #admin-sidebar .sb-item:hover{background:#0f1e35;color:#e2e8f0;}',
    'body.admin-dark #admin-sidebar .sb-item.active,body.admin-dark #admin-sidebar .sb-item.on{background:#14223c;color:#93c5fd;}',
    'body.admin-dark #admin-sidebar .sb-count{background:#1e2d47;color:#64748b;}',
  ].join('\n');

  function injectCss() {
    if (document.getElementById('admin-sidebar-css')) return;
    var st = document.createElement('style');
    st.id = 'admin-sidebar-css';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  function badgeHtml(b) {
    if (!b) return '';
    var cls = b === 'BETA' ? 'sb-badge sb-beta' : b === 'NEW' ? 'sb-badge sb-new' : 'sb-badge';
    return '<span class="' + cls + '">' + esc(b) + '</span>';
  }

  function countHtml(id) {
    if (!id) return '';
    return '<span class="sb-count scount" id="' + esc(id) + '">0</span>';
  }

  function itemHtml(it) {
    var inner =
      '<span class="sb-icon">' + it.icon + '</span>' +
      '<span class="sb-label">' + esc(it.label) + '</span>' +
      badgeHtml(it.badge) +
      countHtml(it.count);

    if (it.panel) {
      var loaders = (it.loaders || []).join(',');
      return '<a class="sb-item sitem" id="nav-' + esc(it.panel) + '"' +
        ' href="admin.html#panel=' + esc(it.panel) + '"' +
        ' data-panel="' + esc(it.panel) + '"' +
        ' data-loaders="' + esc(loaders) + '"' +
        ' onclick="return AdminSidebar.go(event,this)">' + inner + '</a>';
    }

    var attrs = 'class="sb-item" href="' + esc(it.href) + '" data-href="' + esc(it.href) + '"';
    if (it.newtab) attrs += ' target="_blank" rel="noopener"';
    return '<a ' + attrs + '>' + inner + '</a>';
  }

  function sectionHtml(sec) {
    var code = sec.section.toLowerCase().replace(/\s*&\s*/g, '-').replace(/\s+/g, '-');
    return '<div class="sb-sec" data-sec="' + esc(code) + '">' +
      '<div class="sb-head">' + esc(sec.section) + '<span class="sb-chev">▼</span></div>' +
      '<div class="sb-items">' + sec.items.map(itemHtml).join('') + '</div>' +
      '</div>';
  }

  function build() {
    var mount = document.getElementById('admin-sidebar');
    if (!mount) {
      mount = document.createElement('div');
      mount.id = 'admin-sidebar';
      document.body.insertBefore(mount, document.body.firstChild);
    }
    mount.innerHTML =
      '<div class="sb-logo"><div class="sb-wordmark">TBG Sourcing</div><div class="sb-sub">Admin</div></div>' +
      '<nav>' + NAV.map(sectionHtml).join('') + '</nav>';
    document.body.classList.add('admin-has-sidebar');
  }

  function runLoaders(str) {
    if (!str) return;
    str.split(',').forEach(function (fn) {
      fn = fn.trim();
      if (fn && typeof window[fn] === 'function') {
        try { window[fn](); } catch (e) {}
      }
    });
  }

  var AdminSidebar = {
    go: function (ev, el) {
      var panel = el.getAttribute('data-panel');
      if (IS_ADMIN_HOME && typeof window.showPanel === 'function' && document.getElementById('panel-' + panel)) {
        if (ev && ev.preventDefault) ev.preventDefault();
        window.showPanel(panel);
        runLoaders(el.getAttribute('data-loaders'));
        return false;
      }
      return true;
    }
  };
  window.AdminSidebar = AdminSidebar;

  function wireCollapse() {
    var saved = {};
    try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch (e) {}
    document.querySelectorAll('#admin-sidebar .sb-sec').forEach(function (sec) {
      var code = sec.getAttribute('data-sec');
      var head = sec.querySelector('.sb-head');
      var chev = sec.querySelector('.sb-chev');
      if (saved[code] === true) {
        sec.classList.add('collapsed');
        if (chev) chev.textContent = '▶';
      }
      head.addEventListener('click', function () {
        var now = sec.classList.toggle('collapsed');
        if (chev) chev.textContent = now ? '▶' : '▼';
        try {
          var st = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
          st[code] = now;
          localStorage.setItem(STORE_KEY, JSON.stringify(st));
        } catch (e) {}
      });
    });
  }

  function highlight() {
    document.querySelectorAll('#admin-sidebar .sb-item').forEach(function (el) {
      el.classList.remove('active');
    });
    if (IS_ADMIN_HOME) {
      var m = (location.hash || '').match(/panel=([\w-]+)/);
      var panel = m ? m[1] : 'dashboard';
      var item = document.getElementById('nav-' + panel);
      if (typeof window.showPanel === 'function' && document.getElementById('panel-' + panel)) {
        window.showPanel(panel);
        if (item) runLoaders(item.getAttribute('data-loaders'));
      } else if (item) {
        item.classList.add('on');
      }
      return;
    }
    var path = CURRENT;
    var suffix = location.hash || location.search || '';
    var items = Array.prototype.slice.call(document.querySelectorAll('#admin-sidebar .sb-item[data-href]'));
    var exact = null, pageDefault = null;
    items.forEach(function (el) {
      var href = el.getAttribute('data-href');
      var parts = href.split(/(?=[#?])/);
      var ip = (parts[0].split('/').pop() || '').toLowerCase();
      var sfx = parts[1] || '';
      if (ip !== path) return;
      if (sfx === suffix) exact = el;
      if (!sfx) pageDefault = pageDefault || el;
    });
    var best = exact || pageDefault;
    if (best) best.classList.add('active');
  }

  function init() {
    injectCss();
    build();
    wireCollapse();
    highlight();
    window.addEventListener('hashchange', highlight);
  }

  // Don't render the sidebar when this page is embedded inside the admin shell
  // (e.g. admin.html's Factory Audits / Inspections / Artwork iframe panels use
  // ?embed=1). Otherwise a second sidebar renders inside the iframe, overlapping
  // the shell's sidebar. embed=1 OR being in an iframe both suppress it.
  var IS_EMBEDDED = (function () {
    try { return new URLSearchParams(location.search).get('embed') === '1' || window.self !== window.top; }
    catch (e) { return false; }
  })();
  if (!IS_EMBEDDED) {
    if (document.body) init();
    else document.addEventListener('DOMContentLoaded', init);
  }
})();
