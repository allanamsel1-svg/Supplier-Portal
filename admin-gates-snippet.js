// ============================================================
// /admin-gates-snippet.js
//
// Renders the 8-gate readiness panel for a Product Development
// Item (PDI) inside the admin UI. Loaded as <script src> from
// admin.html. After this script loads, call:
//
//   renderReadinessGatesPanel(pdiId)
//
// AFTER a <div id="readiness-gates-panel-{pdiId}"></div> exists
// in the DOM. The function fetches /api/check-readiness-gates
// and paints the 8 gates with pass/fail status and details.
//
// confirmReadinessGate(pdiId, gateId) handles admin "Confirm"
// clicks on the 3 manual gates (packaging, freight, tariff).
// The backing write endpoint is not yet built, so for now the
// confirm button surfaces an alert + console log so we know it
// fired. We'll wire the real write in a follow-up.
// ============================================================

async function renderReadinessGatesPanel(pdiId) {
  const container = document.getElementById('readiness-gates-panel-' + pdiId);
  if (!container) {
    console.warn('[readiness-gates] container not found for PDI', pdiId);
    return;
  }

  container.innerHTML =
    '<div style="padding:14px;color:#888;font-size:13px;">Loading readiness gates…</div>';

  try {
    const res = await fetch('/api/check-readiness-gates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdi_id: pdiId })
    });
    const data = await res.json();

    if (!data || !data.success) {
      container.innerHTML =
        '<div style="padding:14px;color:#c00;font-size:13px;">' +
        'Could not load readiness gates: ' +
        ((data && data.error) || ('HTTP ' + res.status)) +
        '</div>';
      return;
    }

    const gates = data.gates || [];
    const passed = data.passed_count;
    const total = data.total;
    const canActivate = data.can_activate;

    const row = function (g) {
      const icon = g.passed ? '✅' : '⬜';
      const showConfirm = g.section === 'manual' && !g.passed;
      const confirmBtn = showConfirm
        ? '<button onclick="confirmReadinessGate(\'' + pdiId + '\',\'' + g.id + '\')" ' +
          'style="font-size:12px;padding:5px 12px;background:#1a1a2e;color:#fff;' +
          'border:none;border-radius:6px;cursor:pointer;flex-shrink:0;">Confirm</button>'
        : '';
      return (
        '<div style="display:flex;align-items:flex-start;gap:12px;padding:11px 14px;' +
        'border-bottom:1px solid #f0f0ea;">' +
          '<div style="font-size:18px;flex-shrink:0;width:24px;">' + icon + '</div>' +
          '<div style="flex:1;min-width:0;">' +
            '<div style="font-weight:600;font-size:14px;color:#1a1a2e;">' + g.name + '</div>' +
            '<div style="font-size:12px;color:#666;margin-top:3px;">' + g.detail + '</div>' +
          '</div>' +
          confirmBtn +
        '</div>'
      );
    };

    const headerStatus = canActivate
      ? '<span style="color:#2a7;">— Ready to activate</span>'
      : '';

    container.innerHTML =
      '<div style="border:1px solid #e0e0d8;border-radius:10px;background:#fff;' +
      'overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.04);margin:12px 0;">' +
        '<div style="padding:12px 14px;background:#f5f5f0;border-bottom:1px solid #e0e0d8;' +
        'display:flex;justify-content:space-between;align-items:center;">' +
          '<div style="font-weight:600;font-size:14px;">Readiness Gates</div>' +
          '<div style="font-size:12px;color:#666;">' +
            passed + ' / ' + total + ' passed ' + headerStatus +
          '</div>' +
        '</div>' +
        gates.map(row).join('') +
      '</div>';
  } catch (err) {
    container.innerHTML =
      '<div style="padding:14px;color:#c00;font-size:13px;">' +
      'Network error loading readiness gates: ' + err.message + '</div>';
  }
}

async function confirmReadinessGate(pdiId, gateId) {
  // Placeholder — backing write endpoint not yet built.
  // Once /api/confirm-readiness-gate exists, replace this body with a POST
  // call that stamps the appropriate timestamp column on product_development_items
  // and re-renders the panel.
  alert(
    'Confirm action for gate "' + gateId + '" registered.\n\n' +
    'Backend write not yet implemented — this button will become functional ' +
    'once the /api/confirm-readiness-gate endpoint is added.'
  );
  console.log('[readiness-gates] confirm clicked:', { pdiId: pdiId, gateId: gateId });
}
