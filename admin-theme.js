(function () {
  // Apply saved admin theme immediately on load (before render)
  var theme = localStorage.getItem('admin_theme') || 'light';
  // Loaded in <head>, so document.body may not exist yet — guard it.
  // The DOMContentLoaded handler below re-applies the class once body exists.
  if (theme === 'dark' && document.body) document.body.classList.add('admin-dark');
})();

function toggleAdminTheme() {
  var isDark = document.body.classList.toggle('admin-dark');
  localStorage.setItem('admin_theme', isDark ? 'dark' : 'light');
  var btn = document.getElementById('adminThemeToggle');
  if (btn) btn.textContent = isDark ? '☀️' : '🌙';
}

document.addEventListener('DOMContentLoaded', function() {
  var btn = document.getElementById('adminThemeToggle');
  if (btn) {
    var isDark = localStorage.getItem('admin_theme') === 'dark';
    btn.textContent = isDark ? '☀️' : '🌙';
    if (isDark) document.body.classList.add('admin-dark');
  }
});
