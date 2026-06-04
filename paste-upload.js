(function() {
  var zones = [];
  window.registerPasteZone = function(el, handler) {
    if (!el || typeof handler !== 'function') return;
    zones.push({ el: el, handler: handler });
    if (!el.querySelector('.paste-hint')) {
      var hint = document.createElement('div');
      hint.className = 'paste-hint';
      hint.style.cssText = 'font-size:11px;color:var(--text2,#94a3b8);margin-top:6px;text-align:center;';
      hint.textContent = 'or paste a screenshot (Ctrl+V / Cmd+V)';
      el.appendChild(hint);
    }
  };
  document.addEventListener('paste', function(e) {
    if (!zones.length) return;
    var items = (e.clipboardData || window.clipboardData || {}).items;
    if (!items) return;
    var imageItem = null;
    for (var i = 0; i < items.length; i++) {
      if (items[i].type && items[i].type.indexOf('image') !== -1) { imageItem = items[i]; break; }
    }
    if (!imageItem) return;
    var blob = imageItem.getAsFile();
    if (!blob) return;
    var ext = blob.type === 'image/png' ? 'png' : blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/webp' ? 'webp' : 'png';
    var file = new File([blob], 'paste_' + Date.now() + '.' + ext, { type: blob.type });
    var active = zones[zones.length - 1];
    if (active && active.handler) {
      e.preventDefault();
      var el = active.el;
      if (el) { var orig = el.style.border; el.style.border = '2px solid #3b82f6'; setTimeout(function() { el.style.border = orig; }, 600); }
      active.handler(file);
    }
  });
  document.addEventListener('click', function(e) {
    for (var i = 0; i < zones.length; i++) {
      if (zones[i].el && zones[i].el.contains(e.target)) {
        var z = zones.splice(i, 1)[0]; zones.push(z); break;
      }
    }
  });
})();
