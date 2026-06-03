// tenant-theme-sync.js — lets shared admin pages (reached from the tenant portal)
// render dark by default and respect the tenant's light/dark choice.
// Dark is the default: the override applies UNLESS the tenant explicitly chose
// light (localStorage 'tenant_theme' === 'light'), in which case the page keeps
// its native light appearance. Scoped behind html.tenant-dark so it never leaks
// into the light state, and only present on pages that load this file.
(function () {
  try {
    if (localStorage.getItem('tenant_theme') === 'light') return; // explicit light → native look
    document.documentElement.classList.add('tenant-dark');
    var css = [
      'html.tenant-dark, html.tenant-dark body { background:#0a0e1a !important; color:#e2e8f0 !important; }',
      'html.tenant-dark a { color:#60a5fa; }',
      'html.tenant-dark input, html.tenant-dark select, html.tenant-dark textarea { background:#0d1424 !important; color:#e2e8f0 !important; border-color:#1e2d47 !important; }',
      'html.tenant-dark input::placeholder, html.tenant-dark textarea::placeholder { color:#475569 !important; }',
      'html.tenant-dark table th { background:#0d1424 !important; color:#9ca3af !important; border-color:#1e2d47 !important; }',
      'html.tenant-dark table td { border-color:#1e2d47 !important; color:#cbd5e1 !important; }',
      'html.tenant-dark table tr:hover td, html.tenant-dark tr:hover td { background:#0f1e35 !important; }',
      // Common container / card classes across these pages (ri_shared, mercury, login boxes, panels)
      'html.tenant-dark .lb, html.tenant-dark .card, html.tenant-dark .mc-card, html.tenant-dark .mc-bar, html.tenant-dark .panel, html.tenant-dark .box, html.tenant-dark .cm-wrap, html.tenant-dark .mc-wrap, html.tenant-dark section, html.tenant-dark .modal { background:#131929 !important; border-color:#1e2d47 !important; color:#e2e8f0 !important; }',
      'html.tenant-dark .ri-top, html.tenant-dark header, html.tenant-dark .topbar { background:#0d1424 !important; border-color:#1e2d47 !important; color:#e2e8f0 !important; }',
      // ri_shared.css surfaces (loaded by financials/projections/zoom/communications)
      'html.tenant-dark .ri-tabs, html.tenant-dark .ri-section, html.tenant-dark .ri-section th, html.tenant-dark .ri-stub-banner { background:#131929 !important; border-color:#1e2d47 !important; color:#e2e8f0 !important; }',
      'html.tenant-dark .ri-tab:hover { background:#0f1e35 !important; }',
      // Page-specific containers across the admin pages reached from the tenant portal
      'html.tenant-dark .main, html.tenant-dark .cat-list, html.tenant-dark .cat-item, html.tenant-dark .editor, html.tenant-dark .save-bar, html.tenant-dark .intro, html.tenant-dark .seg, html.tenant-dark .seg button, html.tenant-dark .zm-card, html.tenant-dark .zm-note, html.tenant-dark .zm-input, html.tenant-dark .zm-empty, html.tenant-dark .top-banner, html.tenant-dark .detail, html.tenant-dark .tabled-head { background:#131929 !important; border-color:#1e2d47 !important; }',
      'html.tenant-dark h1, html.tenant-dark h2, html.tenant-dark h3, html.tenant-dark .lb h1, html.tenant-dark strong, html.tenant-dark .page-title, html.tenant-dark .topbar-title, html.tenant-dark .editor-cat-name { color:#f1f5f9 !important; }',
      'html.tenant-dark .mc-empty, html.tenant-dark .fin-soon, html.tenant-dark .cm-intro, html.tenant-dark p, html.tenant-dark label, html.tenant-dark .page-sub, html.tenant-dark .cert-section-desc { color:#9ca3af !important; }'
    ].join('\n');
    var s = document.createElement('style');
    s.id = 'tenant-theme-sync-style';
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  } catch (e) { /* never break the host page */ }
})();
