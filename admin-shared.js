// admin-shared.js — shared collapsible admin sidebar for every admin page.
// Mirrors the tenant portal nav (tenant-shared.js renderSidebar): collapsible sections
// with chevrons, icons, active highlight, smooth max-height animation, BETA/NEW/count
// badges, and dark-mode support.
//
// Layout: the sidebar is position:fixed on the left (190px) and every page's <body> gets
// padding-left:190px (class admin-has-sidebar) so content clears it. No DOM wrapping — login
// gates, display:none #main, and flex/grid layouts are all left untouched. Panel hooks on
// admin.html (showPanel/cnt-*) are preserved via the id="nav-<panel>" / class="sitem" contract.
//
// Item types:
//   • panel → SPA panel on admin.html (calls showPanel + optional loaders). From any other
//     page it falls back to navigating to admin.html#panel=<id>.
//   • nav   → plain navigation (href); newtab:true opens a new tab.
(function () {
  'use strict';

  var CURRENT = (location.pathname.split('/').pop() || 'admin.html').toLowerCase();
  var IS_ADMIN_HOME = CURRENT === 'admin.html';
  var STORE_KEY = 'admin_sidebar_sections';

  // ── Nav definition (exact sections/items/order from the spec) ──
  var NAV = [
    { section: 'Overview', items: [
      { icon: '▦', label: 'Dashboard', panel: 'dashboard' },
      { icon: '💰', label: 'Financials', href: 'financials.html' },
      { icon: '🎯', label: 'Intel Daily', href: 'intel_daily.html' },
      { icon: '🗺', label: 'System', href: 'roadmap.html' },
    ]},
    { section: 'Operations', items: [
      { icon: '📋', label: 'Open Orders', panel: 'orders', loaders: ['loadOpenOrders'], count: 'cnt-orders-urgent' },
      { icon: '🔍', label: 'Inspections', href: 'inspections.html', badge: 'NEW' },
      { icon: '🗂', label: 'Factory Audits', panel: 'factory-audits' },
      { icon: '🎨', label: 'Artwork', panel: 'artwork' },
      { icon: '📦', label: 'Warehouse', panel: 'warehouse', loaders: ['loadWarehouse'], badge: 'BETA' },
      { icon: '💰', label: 'Accounting', href: 'communications.html?tab=accounting', badge: 'BETA' },
      { icon: '🔔', label: 'Credit Watch', panel: 'credit', loaders: ['loadCreditWatch'], count: 'cnt-credit' },
      { icon: '🔮', label: 'Forecasting', panel: 'forecasting', loaders: ['loadForecasting'], badge: 'BETA' },
      { icon: '📊', label: 'Projections', href: 'projections.html' },
    ]},
    { section: 'Factories', items: [
      { icon: '🏭', label: 'All Factories', panel: 'all', count: 'cnt-all' },
      { icon: '⏳', label: 'Pending', panel: 'pending', count: 'cnt-pending' },
      { icon: '📇', label: 'Card Scanner', href: 'scanner.html' },
      { icon: '⚠', label: 'Pending Reviews', panel: 'pending-cats', loaders: ['loadPendingCats', 'loadPendingCerts'], count: 'cnt-pending-cats' },
      { icon: '✉', label: 'Invitations', panel: 'followup', count: 'cnt-followup' },
      { icon: '⏰', label: 'RFQ Follow-ups', panel: 'rfq-followup', loaders: ['loadRFQFollowups'], count: 'cnt-rfq-followup' },
      { icon: '🛡', label: 'Compliance Alerts', panel: 'compliance', loaders: ['loadComplianceAlerts'], count: 'cnt-compliance' },
      { icon: '📋', label: 'Compliance Rules', href: 'compliance-rules.html' },
    ]},
    { section: 'Communications', items: [
      { icon: '💬', label: 'Messages', href: 'communications.html' },
      { icon: '🎥', label: 'Zoom', href: 'zoom.html' },
      { icon: '👤', label: 'Allan', href: 'communications.html?tab=allan' },
      { icon: '📬', label: 'Sourcing', href: 'communications.html?tab=sourcing' },
      { icon: '💼', label: 'Sales', href: 'communications.html?tab=sales' },
      { icon: '🎨', label: 'Graphics', href: 'communications.html?tab=graphics' },
      { icon: '💰', label: 'Accounting', href: 'communications.html?tab=accounting' },
      { icon: '🚚', label: 'Logistics', href: 'communications.html?tab=logistics' },
      { icon: '🛡', label: 'Compliance', href: 'communications.html?tab=compliance' },
    ]},
    { section: 'RFQ & Products', items: [
      { icon: '📋', label: 'RFQs', panel: 'rfq', count: 'cnt-rfq' },
      { icon: '🧪', label: 'Product Development', panel: 'pd', loaders: ['loadPDList'], count: 'cnt-pd' },
    ]},
    { section: 'Products', items: [
      { icon: '⚙', label: 'Setup', href: 'setup.html', newtab: true },
      { icon: '📦', label: 'SKU Library', href: 'skus.html' },
    ]},
    { section: 'System', items: [
      { icon: '👥', label: 'Tenants', href: 'tenant-admin.html' },
      { icon: '📤', label: 'Upload Files', panel: 'upload' },
      { icon: '⚙', label: 'Settings', panel: 'settings' },
    ]},
  ];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function sectionCode(name) {
    return name.toLowerCase().replace(/\s*&\s*/g, '-').replace(/\s+/g, '-');
  }

  // ── CSS (namespaced under #admin-sidebar so it can't collide with any page's styles) ──
  var CSS = [
    // Sidebar floats fixed on the left; every page's body gets 190px left padding so nothing
    // sits under it. No DOM wrapping — login gates / display:none / flex / grid all untouched.
    '#admin-sidebar{position:fixed;top:0;left:0;bottom:0;width:190px;z-index:200;background:#fff;border-right:1px solid #e0e0d8;overflow-y:auto;padding:0 0 16px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}',
    'body.admin-has-sidebar{padding-left:190px;box-sizing:border-box;}',
    '#admin-sidebar .sb-logo{padding:14px 16px 12px;}',
    '#admin-sidebar .sb-wordmark{font-size:14px;font-weight:700;color:#1a1a2e;letter-spacing:0.03em;}',
    '#admin-sidebar .sb-sub{font-size:11px;color:#999;margin-top:2px;}',
    '#admin-sidebar .sb-head{font-size:10px;font-weight:600;color:#bbb;text-transform:uppercase;letter-spacing:0.08em;padding:0 16px;margin:14px 0 4px;cursor:pointer;user-select:none;display:flex;align-items:center;gap:5px;}',
    '#admin-sidebar .sb-head:hover{color:#999;}',
    '#admin-sidebar .sb-chev{font-size:8px;color:#ccc;margin-left:auto;}',
    '#admin-sidebar .sb-items{overflow:hidden;transition:max-height 0.28s ease;max-height:800px;}',
    '#admin-sidebar .sb-sec.collapsed .sb-items{max-height:0;}',
    '#admin-sidebar .sb-item{display:flex;align-items:center;gap:8px;padding:7px 10px;margin:0 6px;border-radius:7px;font-size:13px;color:#888;cursor:pointer;text-decoration:none;transition:all 0.1s;}',
    '#admin-sidebar .sb-item:hover{background:#f5f5f0;color:#1a1a2e;}',
    '#admin-sidebar .sb-item.on,#admin-sidebar .sb-item.active{background:#e8f0ff;color:#2244cc;font-weight:600;}',
    '#admin-sidebar .sb-icon{font-size:13px;width:16px;text-align:center;flex-shrink:0;}',
    '#admin-sidebar .sb-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '#admin-sidebar .sb-count{margin-left:auto;font-size:11px;background:#e8e8e0;color:#888;padding:1px 6px;border-radius:10px;flex-shrink:0;}',
    '#admin-sidebar .sb-badge{font-size:9px;padding:1px 5px;border-radius:8px;margin-left:4px;font-weight:500;flex-shrink:0;}',
    '#admin-sidebar .sb-beta{background:#fff8e0;color:#886600;border:1px solid #f0d860;}',
    '#admin-sidebar .sb-new{background:#e8f0ff;color:#2244cc;border:1px solid #b8ccf0;}',
    // Dark mode (admin pages toggle body.admin-dark)
    'body.admin-dark #admin-sidebar{background:#0d1424;border-color:#1e2d47;}',
    'body.admin-dark #admin-sidebar .sb-wordmark{color:#e2e8f0;}',
    'body.admin-dark #admin-sidebar .sb-sub,body.admin-dark #admin-sidebar .sb-head{color:#64748b;}',
    'body.admin-dark #admin-sidebar .sb-item{color:#94a3b8;}',
    'body.admin-dark #admin-sidebar .sb-item:hover{background:#0f1e35;color:#e2e8f0;}',
    'body.admin-dark #admin-sidebar .sb-item.on,body.admin-dark #admin-sidebar .sb-item.active{background:#14223c;color:#9bc2ff;}',
    'body.admin-dark #admin-sidebar .sb-count{background:#1e2d47;color:#94a3b8;}',
  ].join('\n');

  function injectCss() {
    if (document.getElementById('admin-sidebar-style')) return;
    var st = document.createElement('style');
    st.id = 'admin-sidebar-style';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  // ── Markup ──
  function badgeHtml(b) {
    if (!b) return '';
    var cls = b === 'BETA' ? 'sb-badge sb-beta' : (b === 'NEW' ? 'sb-badge sb-new' : 'sb-badge');
    return '<span class="' + cls + '">' + esc(b) + '</span>';
  }
  function countHtml(id) {
    if (!id) return '';
    return '<span class="sb-count scount" id="' + esc(id) + '">0</span>';
  }
  function itemHtml(it) {
    var inner = '<span class="sb-icon sicon">' + it.icon + '</span>' +
                '<span class="sb-label">' + esc(it.label) + '</span>' +
                badgeHtml(it.badge) + countHtml(it.count);
    if (it.panel) {
      // Keep id="nav-<panel>" + class "sitem" so admin.html's showPanel() still works.
      var loaders = (it.loaders || []).join(',');
      return '<a class="sb-item sitem" id="nav-' + esc(it.panel) + '"' +
             ' href="admin.html#panel=' + esc(it.panel) + '"' +
             ' data-panel="' + esc(it.panel) + '" data-loaders="' + esc(loaders) + '"' +
             ' onclick="return AdminSidebar.go(event,this)">' + inner + '</a>';
    }
    var attrs = 'class="sb-item" href="' + esc(it.href) + '" data-href="' + esc(it.href) + '"';
    if (it.newtab) attrs += ' target="_blank" rel="noopener"';
    return '<a ' + attrs + '>' + inner + '</a>';
  }
  function sectionHtml(sec) {
    var code = sectionCode(sec.section);
    return '<div class="sb-sec" data-sec="' + esc(code) + '">' +
             '<div class="sb-head" data-sec="' + esc(code) + '">' + esc(sec.section) +
               ' <span class="sb-chev">▼</span></div>' +
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
      '<nav class="sb-nav">' + NAV.map(sectionHtml).join('') + '</nav>';
    // Sidebar is position:fixed; shift the whole page right by its width — same on every page.
    document.body.classList.add('admin-has-sidebar');
  }

  // ── Loaders ──
  function runLoaders(str) {
    if (!str) return;
    str.split(',').forEach(function (fn) {
      fn = fn.trim();
      if (fn && typeof window[fn] === 'function') {
        try { window[fn](); } catch (e) { console.error('[admin-sidebar] loader ' + fn + ' failed', e); }
      }
    });
  }

  // Panel click: switch in-page on admin.html; otherwise let the href navigate to admin.html.
  var AdminSidebar = {
    go: function (ev, el) {
      var panel = el.getAttribute('data-panel');
      if (typeof window.showPanel === 'function' && document.getElementById('panel-' + panel)) {
        if (ev && ev.preventDefault) ev.preventDefault();
        window.showPanel(panel);
        runLoaders(el.getAttribute('data-loaders'));
        return false;
      }
      return true; // fall back to href (admin.html#panel=...)
    }
  };
  window.AdminSidebar = AdminSidebar;

  // ── Collapsible sections (persisted; all expanded by default) ──
  function wireCollapse() {
    var saved = {};
    try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch (e) {}
    document.querySelectorAll('#admin-sidebar .sb-sec').forEach(function (sec) {
      var code = sec.getAttribute('data-sec');
      var head = sec.querySelector('.sb-head');
      var chev = sec.querySelector('.sb-chev');
      var collapsed = saved[code] === true;
      sec.classList.toggle('collapsed', collapsed);
      if (chev) chev.textContent = collapsed ? '▶' : '▼';
      head.addEventListener('click', function () {
        var nowCollapsed = sec.classList.toggle('collapsed');
        if (chev) chev.textContent = nowCollapsed ? '▶' : '▼';
        try {
          var st = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
          st[code] = nowCollapsed;
          localStorage.setItem(STORE_KEY, JSON.stringify(st));
        } catch (e) {}
      });
    });
  }

  // ── Active highlight ──
  function highlight() {
    document.querySelectorAll('#admin-sidebar .sb-item').forEach(function (el) { el.classList.remove('active'); });

    if (IS_ADMIN_HOME) {
      // Panel-based: showPanel() applies the "on" class. Honor #panel=<id>, else dashboard.
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

    // Other pages: match the current filename + (#hash or ?query) against nav hrefs.
    var path = CURRENT;
    var suffix = location.hash || location.search || '';
    var items = Array.prototype.slice.call(document.querySelectorAll('#admin-sidebar .sb-item[data-href]'));
    var exact = null, pageDefault = null;
    items.forEach(function (el) {
      var href = el.getAttribute('data-href');
      var parts = href.split(/(?=[#?])/);             // split before first # or ?
      var ip = (parts[0].split('/').pop() || '').toLowerCase();
      var isfx = parts[1] || '';
      if (ip !== path) return;
      if (isfx === suffix) exact = el;
      if (!isfx) pageDefault = pageDefault || el;
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

  // The <script> sits at the end of <body>, so the DOM (and admin.html's showPanel) is
  // already available — build synchronously so the cnt-*/nav-* hooks exist immediately.
  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init);
})();
