// tenant-theme-sync.js — lets shared admin pages (reached from the tenant portal)
// respect the tenant's light/dark choice. Applies a dark override ONLY when the
// tenant explicitly selected dark (localStorage 'tenant_theme' === 'dark'); when
// unset or 'light' the page keeps its native (light) appearance untouched.
(function () {
  try {
    if (localStorage.getItem('tenant_theme') !== 'dark') return;
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
      'html.tenant-dark h1, html.tenant-dark h2, html.tenant-dark h3, html.tenant-dark .lb h1, html.tenant-dark strong { color:#f1f5f9 !important; }',
      'html.tenant-dark .mc-empty, html.tenant-dark .fin-soon, html.tenant-dark .cm-intro, html.tenant-dark p, html.tenant-dark label { color:#9ca3af !important; }'
    ].join('\n');
    var s = document.createElement('style');
    s.id = 'tenant-theme-sync-style';
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  } catch (e) { /* never break the host page */ }
})();
