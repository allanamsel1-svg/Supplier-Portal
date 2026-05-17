// ============================================================
// admin.html — Readiness Gates panel renderer (drop-in)
//
// PASTE THIS into admin.html, just before the closing </script> tag at the very
// bottom of the file. It overrides any existing renderReadinessGates / refreshReadinessGates
// function with a corrected version that calls /api/check-readiness-gates.
//
// USAGE in your PD detail render code:
//   replace whatever renders the "Readiness Gates" panel with:
//     <div id="readiness-gates-panel-{PDI_ID}"></div>
//   then call:
//     renderReadinessGatesPanel('{PDI_ID}');
//
// Where {PDI_ID} is the product_development_items.id (NOT product_development.id).
// ============================================================

window.renderReadinessGatesPanel = async function(pdiId, containerEl) {
  // Locate container — accept either an element or a string id suffix
  var el = containerEl;
  if (typeof el === 'string') el = document.getElementById(el);
  if (!el) el = document.getElementById('readiness-gates-panel-' + pdiId);
  if (!el) {
    console.warn('renderReadinessGatesPanel: container not found for', pdiId);
    return;
  }

  el.innerHTML = '<div style="font-size:12px;color:#bbb;padding:10px;">Checking readiness gates...</div>';

  try {
    var r = await fetch('/api/check-readiness-gates', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ pdi_id: pdiId })
    });
    if (!r.ok) {
      var errTxt = await r.text();
      el.innerHTML = '<div style="font-size:12px;color:#b00;padding:10px;background:#fff0f0;border:1px solid #fdd;border-radius:8px;">Readiness check failed: HTTP ' + r.status + ' — ' + errTxt.slice(0, 200) + '</div>';
      return;
    }
    var data = await r.json();
    if (!data || !data.success) {
      el.innerHTML = '<div style="font-size:12px;color:#b00;padding:10px;">Readiness check returned no data.</div>';
      return;
    }

    var autoGates   = data.gates.filter(function(g){ return g.section === 'auto'; });
    var manualGates = data.gates.filter(function(g){ return g.section === 'manual'; });

    function esc(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function rowHtml(g) {
      var bg     = g.passed ? '#edfaed' : '#fff8e0';
      var border = g.passed ? '#c0e0c0' : '#f0d860';
      var icon   = g.passed ? '<span style="color:#1a7a1a;font-weight:700;">✓</span>'
                            : '<span style="color:#886600;">○</span>';
      var confirmBtn = '';
      if (g.section === 'manual' && !g.passed) {
        confirmBtn =
          '<button onclick="confirmReadinessGate(\'' + esc(pdiId) + '\',\'' + esc(g.id) + '\')" '+
          'style="padding:5px 14px;background:#1a1a2e;color:#fff;border:none;border-radius:5px;font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;flex-shrink:0;">Confirm</button>';
      }
      return ''+
        '<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:'+bg+';border:1px solid '+border+';border-radius:8px;margin-bottom:6px;">'+
          '<div style="flex-shrink:0;font-size:14px;">' + icon + '</div>'+
          '<div style="flex:1;min-width:0;">'+
            '<div style="font-size:13px;font-weight:600;color:#1a1a2e;">' + esc(g.name) + '</div>'+
            '<div style="font-size:11px;color:#666;margin-top:2px;">' + esc(g.detail) + '</div>'+
          '</div>'+
          confirmBtn +
        '</div>';
    }

    var headerBg     = data.can_activate ? '#edfaed' : '#fff8e0';
    var headerBorder = data.can_activate ? '#c0e0c0' : '#f0d860';
    var headerColor  = data.can_activate ? '#1a7a1a' : '#886600';

    el.innerHTML = ''+
      '<div style="font-size:14px;font-weight:600;color:#1a1a2e;margin-bottom:10px;">'+
        '🚪 Readiness Gates — ' + data.passed_count + '/' + data.total +
      '</div>'+
      '<div style="padding:10px 14px;background:'+headerBg+';color:'+headerColor+';border:1px solid '+headerBorder+';border-radius:8px;font-size:13px;font-weight:600;margin-bottom:14px;">'+
        data.passed_count + ' of ' + data.total + ' gates passed' +
        (data.can_activate ? ' — ready to activate as Live SKU.' : '') +
      '</div>'+
      '<div style="font-size:10px;font-weight:600;color:#bbb;text-transform:uppercase;letter-spacing:0.07em;margin-bottom:6px;">Auto-computed from data</div>'+
      autoGates.map(rowHtml).join('') +
      '<div style="font-size:10px;font-weight:600;color:#bbb;text-transform:uppercase;letter-spacing:0.07em;margin:14px 0 6px;">Admin confirmations</div>'+
      manualGates.map(rowHtml).join('');
  } catch (e) {
    el.innerHTML = '<div style="font-size:12px;color:#b00;padding:10px;">Error: ' + (e.message || e) + '</div>';
  }
};

// Admin Confirm button handler. Maps each manual gate.id to the column it sets.
window.confirmReadinessGate = async function(pdiId, gateId) {
  var SB_URL = (typeof SB !== 'undefined' && SB) ? SB :
               (typeof SUPABASE_URL !== 'undefined' && SUPABASE_URL) ? SUPABASE_URL : null;
  var SB_KEY = (typeof KEY !== 'undefined' && KEY) ? KEY :
               (typeof SUPABASE_ANON_KEY !== 'undefined' && SUPABASE_ANON_KEY) ? SUPABASE_ANON_KEY : null;
  var SB_TOK = (typeof TOKEN !== 'undefined' && TOKEN) ? TOKEN : SB_KEY;
  if (!SB_URL || !SB_KEY) {
    alert('Supabase config not found in this page. Cannot confirm gate.');
    return;
  }

  var columnMap = {
    packaging_design: 'packaging_finalized_at',
    freight_cost:     'freight_cost_confirmed_at',
    tariff_class:     'tariff_confirmed_at'
  };
  var col = columnMap[gateId];
  if (!col) {
    alert('Unknown gate: ' + gateId);
    return;
  }
  if (!confirm('Mark "' + gateId.replace(/_/g, ' ') + '" as confirmed?')) return;

  try {
    var patch = {};
    patch[col] = new Date().toISOString();
    var r = await fetch(SB_URL + '/rest/v1/product_development_items?id=eq.' + pdiId, {
      method: 'PATCH',
      headers: {
        'apikey': SB_KEY,
        'Authorization': 'Bearer ' + SB_TOK,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(patch)
    });
    if (!r.ok) {
      var t = await r.text();
      alert('Confirm failed: HTTP ' + r.status + ' — ' + t.slice(0, 200));
      return;
    }
    // Re-render the panel
    if (typeof window.renderReadinessGatesPanel === 'function') {
      window.renderReadinessGatesPanel(pdiId);
    }
  } catch (e) {
    alert('Error: ' + (e.message || e));
  }
};
