// admin-backlink.js
// Injects ONE standardized "← Admin" back button (fixed top-left, identical style)
// on every standalone admin page. Skips admin.html itself and embedded (?embed=1) views.
// De-dupes any page's own .back-link so the standardized button is the single back control.
(function () {
  try {
    var page = (location.pathname.split('/').pop() || '').toLowerCase();
    if (page === 'admin.html' || page === '') return;
    if (new URLSearchParams(location.search).get('embed') === '1') return;

    function inject() {
      if (document.getElementById('tbgAdminBack')) return;
      // Hide any pre-existing in-page back link to avoid duplicates.
      document.querySelectorAll('.back-link, .back-btn').forEach(function (el) { el.style.display = 'none'; });
      var a = document.createElement('a');
      a.id = 'tbgAdminBack';
      a.href = 'admin.html';
      a.textContent = '← Admin';
      a.style.cssText = 'position:fixed;top:10px;left:12px;z-index:9999;' +
        "font:600 13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;" +
        'color:#fff;background:#1a1a2e;border:1px solid rgba(255,255,255,0.18);' +
        'border-radius:7px;padding:6px 12px;text-decoration:none;box-shadow:0 1px 4px rgba(0,0,0,0.25);';
      document.body.appendChild(a);
    }
    if (document.body) inject();
    else document.addEventListener('DOMContentLoaded', inject);
  } catch (e) { /* never block the page */ }
})();
