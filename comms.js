// comms.js — shared factory/customer Communications engine
// (Twilio: WhatsApp | SMS | Phone | Fax). Loaded via <script src> by
// admin.html (drawer), factory-detail.html (Communications tab) and
// communications.html (standalone). Requires globals SB, KEY, g().
//
// UX model:
//   • Every channel tab has a free-form number field on top — type any number
//     and send; the address book below is an OPTIONAL helper that pre-fills it.
//   • Address book lists BOTH factories and customers (labeled).
//   • Each tab shows ONLY that channel's thread (filtered from twilio_comms).
//
// Entry points:
//   renderFactoryComms(factory)  — render into #d-comms for one factory record
//   renderCommsStandalone()      — render into #d-comms with no preset contact

var _twHome = null, _twTarget = null, _twTab = 'whatsapp', _twComms = [], _twStandalone = false;
var __twContacts = [];
var _twUnread = {};   // channel -> unread inbound count (standalone Messages page badges)
function _twTabChannel(tab) { return tab === 'phone' ? 'voice' : tab; }   // Phone tab → 'voice' rows
var TW_ADMIN_MOBILE = '+19177709904';
var TW_CHAN = {
  whatsapp: { c: '#1a7a1a', bg: '#e8f8e8', i: '🟢', label: 'WhatsApp' },
  sms: { c: '#2244cc', bg: '#e8f0ff', i: '💬', label: 'SMS' },
  voice: { c: '#5a2db8', bg: '#f1ebfb', i: '📞', label: 'Voice' },
  fax: { c: '#c2780a', bg: '#fdf2e2', i: '📠', label: 'Fax' }
};
var TW_FALLBACK = { c: '#777', bg: '#f0f0f0', i: '•', label: '' };
function escC(v) { return (v || '').toString().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function _twFac(f) { return { id: f.id, kind: 'factory', name: f.factory_name_english || '', contact: f.sales_contact_name || '', mobile: f.sales_mobile || '', tel: f.telephone || '', whatsapp: f.sales_whatsapp || '', categories: f.product_categories || [], ai_summary: f.ai_comms_summary || '', ai_at: f.ai_comms_summary_at || '' }; }
function _twCust(c) { return { id: c.id, kind: 'customer', name: c.customer_name || '', contact: c.contact_name || '', mobile: c.contact_phone || '', tel: c.contact_phone || '', whatsapp: c.contact_phone || '', categories: [], ai_summary: '', ai_at: '' }; }
function twContactList() { return __twContacts; }
// Fetch BOTH factories and customers into one normalized, labeled list.
async function twEnsureContacts() {
  if (__twContacts.length) return;
  var out = [];
  try {
    var rf = await fetch(SB + '/rest/v1/factories?select=id,factory_name_english,sales_contact_name,sales_mobile,telephone,sales_whatsapp,product_categories,ai_comms_summary,ai_comms_summary_at&order=factory_name_english&limit=5000', { headers: { apikey: KEY, Authorization: 'Bearer ' + KEY } });
    if (rf.ok) (await rf.json()).forEach(function (f) { out.push(_twFac(f)); });
  } catch (e) { }
  try {
    var rc = await fetch(SB + '/rest/v1/customers?select=id,customer_name,contact_name,contact_phone&order=customer_name&limit=5000', { headers: { apikey: KEY, Authorization: 'Bearer ' + KEY } });
    if (rc.ok) (await rc.json()).forEach(function (c) { out.push(_twCust(c)); });
  } catch (e) { }
  __twContacts = out;
}

function _twShellHtml() {
  return '<div id="tw-ai-card" style="background:#f6f4ff;border:1px solid #ddd3f5;border-radius:9px;padding:10px 12px;margin-bottom:12px;"></div>' +
    '<div id="tw-tabs" style="display:flex;gap:2px;border-bottom:1px solid #e0e0d8;margin-bottom:10px;flex-wrap:wrap;"></div>' +
    '<div id="tw-tabpanel"></div>';
}

function renderFactoryComms(f) {
  _twStandalone = false;
  _twHome = _twFac(f);
  _twTarget = _twFac(f);
  _twTab = 'whatsapp';
  var el = g('d-comms'); if (!el) return;
  el.innerHTML = _twShellHtml();
  twRenderTabs(); twRenderTab(); twLoadThread(); twLoadAiSummary(false);
  twEnsureContacts().then(function () { if (g('tw-ab-results')) twAddrSearch(); });
}
function renderCommsStandalone() {
  _twStandalone = true; _twHome = null; _twTarget = {};
  _twTab = (function () { try { var t = new URLSearchParams(location.search).get('tab'); return ['whatsapp', 'sms', 'phone', 'fax'].indexOf(t) > -1 ? t : 'whatsapp'; } catch (e) { return 'whatsapp'; } })();
  var el = g('d-comms'); if (!el) return;
  el.innerHTML = _twShellHtml();
  twRenderTabs(); twRenderTab(); twLoadThread();
  twAiCardRender('Type a number, or pick a factory/customer from the address book, then send on any channel tab.', null, false);
  twEnsureContacts().then(function () { if (g('tw-ab-results')) twAddrSearch(); });
  twLoadUnread();
}
function twRenderTabs() {
  if (!g('tw-tabs')) return;
  var tabs = [['whatsapp', '🟢 WhatsApp'], ['sms', '💬 SMS'], ['phone', '📞 Phone'], ['fax', '📠 Fax']];
  g('tw-tabs').innerHTML = tabs.map(function (t) {
    var on = _twTab === t[0];
    var n = _twStandalone ? (_twUnread[_twTabChannel(t[0])] || 0) : 0;
    var badge = n > 0 ? ' <span style="display:inline-block;min-width:15px;text-align:center;background:#e23b3b;color:#fff;font-size:9px;font-weight:700;line-height:1.4;border-radius:9px;padding:0 5px;margin-left:4px;vertical-align:middle;">' + (n > 99 ? '99+' : n) + '</span>' : '';
    return '<button onclick="twSetTab(\'' + t[0] + '\')" style="padding:7px 11px;font-size:12px;font-weight:600;font-family:inherit;cursor:pointer;border:none;background:none;border-bottom:2px solid ' + (on ? '#1a1a2e' : 'transparent') + ';color:' + (on ? '#1a1a2e' : '#888') + ';">' + t[1] + badge + '</button>';
  }).join('');
}
function twSetTab(tab) { _twTab = tab; twRenderTabs(); twRenderTab(); twLoadThread(); twMarkChannelRead(_twTabChannel(tab)); }
// ── Unread badges (standalone Messages page): count inbound, unread, per channel ──
async function twLoadUnread() {
  if (!_twStandalone) return;
  try {
    var r = await fetch(SB + '/rest/v1/twilio_communications?select=channel&direction=eq.inbound&read=eq.false&limit=2000', { headers: { apikey: KEY, Authorization: 'Bearer ' + KEY } });
    var rows = r.ok ? await r.json() : [];
    var m = {}; rows.forEach(function (x) { if (x.channel) m[x.channel] = (m[x.channel] || 0) + 1; });
    _twUnread = m;
  } catch (e) { _twUnread = {}; }
  twRenderTabs();
}
function twMarkChannelRead(ch) {
  if (!_twStandalone || !_twUnread[ch]) return;
  _twUnread[ch] = 0; twRenderTabs();
  fetch(SB + '/rest/v1/twilio_communications?channel=eq.' + ch + '&direction=eq.inbound&read=eq.false', { method: 'PATCH', headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify({ read: true }) }).catch(function () { });
}
function twRenderTab() {
  var p = g('tw-tabpanel'); if (!p) return;
  if (_twTab === 'whatsapp' || _twTab === 'sms') p.innerHTML = twMsgTabHtml(_twTab);
  else if (_twTab === 'phone') p.innerHTML = twPhoneTabHtml();
  else if (_twTab === 'fax') p.innerHTML = twFaxTabHtml();
  twAddrSearch();
}
// ── Free-form number field (top) + optional address book (below) ──
function _twNumForChannel(t, channel) {
  t = t || {};
  if (channel === 'whatsapp') return t.whatsapp || t.mobile || t.tel || '';
  if (channel === 'phone') return t.tel || t.mobile || t.whatsapp || '';
  return t.mobile || t.tel || t.whatsapp || ''; // sms, fax
}
function _twNumberBlock(channel) {
  var lbl = (TW_CHAN[channel] && TW_CHAN[channel].label) || '';
  var num = _twNumForChannel(_twTarget, channel);
  return '<div style="font-size:10px;font-weight:600;color:#888;text-transform:uppercase;margin-bottom:4px;">' + escC(lbl) + ' number</div>' +
    '<input id="tw-dest" type="tel" value="' + escC(num) + '" placeholder="Type any number, e.g. +8613800000000" style="width:100%;padding:8px 10px;border:1px solid #c0c0b8;border-radius:7px;font-size:13px;box-sizing:border-box;font-family:inherit;margin-bottom:8px;" />' +
    twAddrBookHtml();
}
function twCatOptions() {
  var set = {}; twContactList().forEach(function (f) { (f.categories || []).forEach(function (c) { if (c) set[c] = 1; }); });
  return '<option value="">All categories</option>' + Object.keys(set).sort().map(function (c) { return '<option value="' + escC(c) + '">' + escC(c) + '</option>'; }).join('');
}
function twAddrBookHtml() {
  return '<div style="background:#f7f7f4;border:1px solid #e8e8e0;border-radius:8px;padding:8px;margin-bottom:10px;">' +
    '<div style="font-size:10px;font-weight:600;color:#888;text-transform:uppercase;margin-bottom:5px;">Address Book <span style="font-weight:400;text-transform:none;color:#aaa;">— optional, pre-fills the number above</span></div>' +
    '<div style="display:flex;gap:6px;margin-bottom:6px;">' +
      '<input id="tw-ab-q" oninput="twAddrSearch()" placeholder="Search factory or customer…" style="flex:1;min-width:0;padding:6px 8px;border:1px solid #d8d8d0;border-radius:6px;font-size:12px;box-sizing:border-box;font-family:inherit;" />' +
      '<select id="tw-ab-cat" onchange="twAddrSearch()" style="max-width:150px;padding:6px;border:1px solid #d8d8d0;border-radius:6px;font-size:12px;font-family:inherit;">' + twCatOptions() + '</select>' +
    '</div>' +
    '<div id="tw-ab-results" style="max-height:120px;overflow-y:auto;font-size:12px;"></div>' +
  '</div>';
}
function twAddrSearch() {
  var box = g('tw-ab-results'); if (!box) return;
  var q = ((g('tw-ab-q') && g('tw-ab-q').value) || '').toLowerCase().trim();
  var cat = (g('tw-ab-cat') && g('tw-ab-cat').value) || '';
  // Search-on-demand: don't dump the whole directory (it dominated every tab).
  if (!q && !cat) { box.innerHTML = '<div style="color:#bbb;padding:4px;">Type a factory or customer name to look one up (optional — you can also just type a number above).</div>'; return; }
  var list = twContactList().filter(function (f) {
    if (cat && (f.categories || []).indexOf(cat) === -1) return false;
    if (q && !((f.name || '').toLowerCase().indexOf(q) > -1 || (f.contact || '').toLowerCase().indexOf(q) > -1)) return false;
    return true;
  }).slice(0, 50);
  if (!list.length) { box.innerHTML = '<div style="color:#bbb;padding:4px;">No matches.</div>'; return; }
  box.innerHTML = list.map(function (f) {
    var sel = _twTarget && _twTarget.id === f.id;
    var isCust = f.kind === 'customer';
    var badge = '<span style="font-size:8px;font-weight:700;letter-spacing:0.04em;padding:1px 5px;border-radius:7px;margin-left:6px;background:' + (isCust ? '#fdf0e2;color:#c2780a' : '#e8f0ff;color:#2244cc') + ';">' + (isCust ? 'CUSTOMER' : 'FACTORY') + '</span>';
    return '<div onclick="twPickTarget(\'' + f.id + '\')" style="padding:5px 7px;border-radius:5px;cursor:pointer;' + (sel ? 'background:#e8f0ff;' : '') + 'display:flex;justify-content:space-between;gap:8px;align-items:center;">' +
      '<span style="font-weight:' + (sel ? '600' : '500') + ';color:#1a1a2e;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escC(f.name || '—') + badge + '</span>' +
      '<span style="color:#aaa;flex-shrink:0;">' + escC(f.contact || '') + '</span>' +
    '</div>';
  }).join('');
}
function twPickTarget(id) {
  var f = twContactList().find(function (x) { return x.id === id; }); if (!f) return;
  _twTarget = f;
  if (_twStandalone) { _twHome = Object.assign({}, f); twLoadAiSummary(false); }
  if (g('tw-dest')) g('tw-dest').value = _twNumForChannel(f, _twTab);
  twAddrSearch(); twLoadThread();
}
// ── Tab panels ──
function twMsgTabHtml(channel) {
  var col = TW_CHAN[channel];
  return _twNumberBlock(channel) +
    '<textarea id="tw-compose" rows="3" placeholder="Type a ' + col.label + ' message…" style="width:100%;padding:7px 9px;border:1px solid #d8d8d0;border-radius:6px;font-size:13px;box-sizing:border-box;font-family:inherit;resize:vertical;margin-bottom:6px;"></textarea>' +
    '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:12px;">' +
      '<span id="tw-send-msg" style="font-size:11px;min-height:14px;"></span>' +
      '<button id="tw-send-btn" onclick="' + (channel === 'whatsapp' ? 'twSendWhatsApp()' : 'twSendSms()') + '" style="padding:7px 16px;background:' + col.c + ';color:#fff;border:none;border-radius:7px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;">Send ' + col.label + '</button>' +
    '</div>' +
    twChanThreadHeader(col.label) + '<div id="tw-chan-thread" style="border:1px solid #eee;border-radius:7px;max-height:340px;overflow-y:auto;padding:8px;background:#fafaf8;">…</div>';
}
function twChanThreadHeader(label) { return '<div style="font-size:10px;font-weight:600;color:#aaa;text-transform:uppercase;margin-bottom:4px;">' + escC(label) + ' thread</div>'; }
function twPhoneTabHtml() {
  return _twNumberBlock('phone') +
    '<div style="background:#f1ebfb;border:1px solid #d8c8f0;border-radius:8px;padding:9px 12px;margin-bottom:10px;font-size:12px;color:#5a2db8;line-height:1.5;"><strong>US clients only.</strong> Click-to-call rings the admin mobile (' + TW_ADMIN_MOBILE + ') first, then bridges to the number above. Not for factory calls.</div>' +
    '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:12px;">' +
      '<span id="tw-send-msg" style="font-size:11px;min-height:14px;"></span>' +
      '<button onclick="twCallUSClient()" style="padding:7px 16px;background:#5a2db8;color:#fff;border:none;border-radius:7px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;">📞 Call</button>' +
    '</div>' +
    twChanThreadHeader('Call log') + '<div id="tw-chan-thread" style="border:1px solid #eee;border-radius:7px;max-height:340px;overflow-y:auto;padding:8px;background:#fafaf8;">…</div>';
}
function twFaxTabHtml() {
  return _twNumberBlock('fax') +
    '<div style="font-size:10px;font-weight:600;color:#888;text-transform:uppercase;margin-bottom:4px;">PDF document</div>' +
    '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">' +
      '<label style="flex-shrink:0;padding:7px 14px;background:#fff;border:1px solid #c2780a;color:#c2780a;border-radius:7px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;">📎 Attach PDF' +
        '<input id="tw-fax-file" type="file" accept="application/pdf,.pdf" onchange="twFaxFileChosen()" style="display:none;" />' +
      '</label>' +
      '<span id="tw-fax-hint" style="font-size:12px;color:#aaa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;">No PDF selected — required to send</span>' +
    '</div>' +
    '<div id="tw-fax-preview" style="display:none;align-items:center;gap:10px;margin-bottom:10px;background:#fdf2e2;border:1px solid #e8cfa0;border-radius:8px;padding:8px 10px;">' +
      '<span style="font-size:22px;flex-shrink:0;line-height:1;">📄</span>' +
      '<div style="min-width:0;flex:1;">' +
        '<div id="tw-fax-pname" style="font-size:12px;font-weight:600;color:#1a1a2e;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></div>' +
        '<div id="tw-fax-psize" style="font-size:11px;color:#999;"></div>' +
      '</div>' +
      '<button onclick="twFaxRemove()" title="Remove attachment" style="flex-shrink:0;padding:5px 10px;background:#fff;border:1px solid #d8b88a;color:#c2780a;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;">✕ Remove</button>' +
    '</div>' +
    '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:12px;">' +
      '<span id="tw-send-msg" style="font-size:11px;min-height:14px;"></span>' +
      '<button id="tw-fax-send-btn" onclick="twSendFax()" disabled style="padding:7px 16px;background:#c2780a;color:#fff;border:none;border-radius:7px;font-size:12px;font-weight:600;cursor:not-allowed;opacity:0.5;font-family:inherit;">📠 Send Fax</button>' +
    '</div>' +
    twChanThreadHeader('Fax history') + '<div id="tw-chan-thread" style="border:1px solid #eee;border-radius:7px;max-height:340px;overflow-y:auto;padding:8px;background:#fafaf8;">…</div>';
}
function twFmtBytes(n) { if (n == null) return ''; if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'; return (n / 1048576).toFixed(1) + ' MB'; }
function twFaxSetSendEnabled(on) {
  var btn = g('tw-fax-send-btn'); if (!btn) return;
  btn.disabled = !on;
  btn.style.cursor = on ? 'pointer' : 'not-allowed';
  btn.style.opacity = on ? '1' : '0.5';
}
function twFaxFileChosen() {
  var f = g('tw-fax-file'), file = f && f.files && f.files[0];
  if (!file) { twFaxRemove(); return; }
  if (g('tw-fax-pname')) g('tw-fax-pname').textContent = file.name;
  if (g('tw-fax-psize')) g('tw-fax-psize').textContent = twFmtBytes(file.size) + ' · PDF';
  if (g('tw-fax-preview')) g('tw-fax-preview').style.display = 'flex';
  if (g('tw-fax-hint')) g('tw-fax-hint').style.display = 'none';
  twFaxSetSendEnabled(true);
}
function twFaxRemove() {
  var f = g('tw-fax-file'); if (f) f.value = '';
  if (g('tw-fax-preview')) g('tw-fax-preview').style.display = 'none';
  if (g('tw-fax-hint')) g('tw-fax-hint').style.display = '';
  twFaxSetSendEnabled(false);
  twMsg('', '#888');
}
// ── Send actions (free-form: a contact selection is NOT required) ──
function twMsg(text, color) { var el = g('tw-send-msg'); if (el) { el.textContent = text; el.style.color = color || '#888'; } }
function twTargetId() { return (_twTarget && _twTarget.id) || null; }
function twSendWhatsApp() { return twSendMessage('/api/twilio-whatsapp'); }
function twSendSms() { return twSendMessage('/api/twilio-sms'); }
async function twSendMessage(endpoint) {
  var to = ((g('tw-dest') && g('tw-dest').value) || '').trim();
  var msg = ((g('tw-compose') && g('tw-compose').value) || '').trim();
  if (!to || !msg) { twMsg('Enter a destination number and message.', '#b00'); return; }
  var btn = g('tw-send-btn'); if (btn) btn.disabled = true; twMsg('Sending…', '#888');
  try {
    var r = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: to, message: msg, factory_id: twTargetId() }) });
    var d = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    twMsg('✓ Sent (' + (d.status || 'queued') + ')', '#1a7a1a');
    if (g('tw-compose')) g('tw-compose').value = '';
    twLoadThread();
  } catch (e) { twMsg('Failed: ' + e.message, '#b00'); }
  finally { if (btn) btn.disabled = false; }
}
async function twCallUSClient() {
  var dest = ((g('tw-dest') && g('tw-dest').value) || '').trim();
  if (!dest) { twMsg('Enter a number to connect.', '#b00'); return; }
  if (!confirm('Ring admin mobile ' + TW_ADMIN_MOBILE + ' and bridge to ' + dest + '?')) return;
  twMsg('Placing call…', '#888');
  try {
    var r = await fetch('/api/twilio-voice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: TW_ADMIN_MOBILE, connectTo: dest, factory_id: twTargetId() }) });
    var d = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    twMsg('✓ Call initiated (' + (d.status || 'queued') + ')', '#1a7a1a');
    twLoadThread();
  } catch (e) { twMsg('Call failed: ' + e.message, '#b00'); }
}
async function twSendFax() {
  var to = ((g('tw-dest') && g('tw-dest').value) || '').trim();
  var fileEl = g('tw-fax-file'), file = fileEl && fileEl.files && fileEl.files[0];
  if (!to || !file) { twMsg('Enter a fax number and attach a PDF.', '#b00'); return; }
  twMsg('Uploading PDF…', '#888');
  try {
    var ts = Date.now(); var safe = file.name.replace(/[^a-zA-Z0-9._\-]/g, '_').slice(0, 80);
    var path = (twTargetId() || 'misc') + '/' + ts + '_' + safe;
    var up = await fetch(SB + '/storage/v1/object/twilio-fax/' + path, { method: 'POST', headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/pdf', 'x-upsert': 'true' }, body: file });
    if (!up.ok) throw new Error('Upload failed (' + up.status + ')');
    var mediaUrl = SB + '/storage/v1/object/public/twilio-fax/' + path;
    twMsg('Sending fax…', '#888');
    var r = await fetch('/api/twilio-fax', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: to, mediaUrl: mediaUrl, factory_id: twTargetId() }) });
    var d = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    twMsg('✓ Fax queued (' + (d.status || 'queued') + ')', '#1a7a1a');
    if (g('tw-fax-file')) g('tw-fax-file').value = '';
    if (g('tw-fax-preview')) g('tw-fax-preview').style.display = 'none';
    if (g('tw-fax-hint')) g('tw-fax-hint').style.display = '';
    twFaxSetSendEnabled(false);
    twLoadThread();
  } catch (e) { twMsg('Failed: ' + e.message, '#b00'); }
}
// ── Per-channel thread (each tab shows only its own channel) ──
function twEnsureSpinnerCss() {
  if (g('tw-spin-css')) return;
  var s = document.createElement('style'); s.id = 'tw-spin-css';
  s.textContent = '@keyframes twspin{to{transform:rotate(360deg)}} .tw-spinner{display:inline-block;width:15px;height:15px;border:2px solid #e3e3da;border-top-color:#888;border-radius:50%;animation:twspin .7s linear infinite;vertical-align:middle;}';
  document.head.appendChild(s);
}
function twThreadLoadingHtml(label) { twEnsureSpinnerCss(); return '<div style="color:#aaa;text-align:center;padding:16px;"><span class="tw-spinner"></span><span style="margin-left:8px;">Loading ' + escC(label) + '…</span></div>'; }
async function twLoadThread() {
  var fid = twTargetId();
  var box = g('tw-chan-thread');
  var reqTab = _twTab;                                   // guard against a newer tab switch clobbering _twComms
  var ch = _twTab === 'phone' ? 'voice' : _twTab;
  var label = (TW_CHAN[ch] && TW_CHAN[ch].label) || ch;
  // No contact selected: in the standalone Messages console show the whole
  // channel INBOX (so inbound messages with no factory match are still visible);
  // in the per-contact drawer just clear.
  var url = (!fid)
    ? (SB + '/rest/v1/twilio_communications?channel=eq.' + ch + '&order=created_at.desc&limit=50')
    : (SB + '/rest/v1/twilio_communications?factory_id=eq.' + fid + '&order=created_at.desc&limit=50');
  if (!fid && !_twStandalone) { _twComms = []; twRenderChannelThread(); return; }
  if (box) box.innerHTML = twThreadLoadingHtml(label);
  var rows = [];
  try {
    var r = await fetch(url, { headers: { apikey: KEY, Authorization: 'Bearer ' + KEY } });
    rows = r.ok ? await r.json() : [];
  } catch (e) { rows = []; }
  if (_twTab !== reqTab) return;                         // a later switch superseded this load — drop stale result
  _twComms = rows;
  twRenderChannelThread();
}
function twBubble(c) {
  var col = TW_CHAN[c.channel] || TW_FALLBACK;
  var out = c.direction === 'outbound';
  var when = c.created_at ? new Date(c.created_at).toLocaleString() : '';
  var rt = c.response_time_hours != null ? (' · ⏱' + c.response_time_hours + 'h') : '';
  var who = out ? (c.to_number || '') : (c.from_number || '');
  var whoTxt = who ? (' · ' + escC(who)) : '';
  return '<div style="display:flex;justify-content:' + (out ? 'flex-end' : 'flex-start') + ';margin-bottom:6px;">' +
    '<div style="max-width:84%;background:' + (out ? col.bg : '#fff') + ';border:1px solid #e0e0d8;border-left:3px solid ' + col.c + ';border-radius:7px;padding:6px 9px;">' +
      '<div style="font-size:10px;color:' + col.c + ';font-weight:600;margin-bottom:2px;">' + col.i + ' ' + (col.label || (c.channel || '')) + ' · ' + (out ? 'OUT' : 'IN') + whoTxt + (c.status ? ' · ' + escC(c.status) : '') + rt + '</div>' +
      '<div style="color:#1a1a2e;line-height:1.4;white-space:pre-wrap;overflow-wrap:anywhere;">' + escC((c.body || '').slice(0, 400)) + '</div>' +
      '<div style="font-size:10px;color:#bbb;margin-top:3px;">' + escC(when) + '</div>' +
    '</div></div>';
}
function twRenderChannelThread() {
  var box = g('tw-chan-thread'); if (!box) return;
  var ch = _twTab === 'phone' ? 'voice' : _twTab;       // Phone tab → voice rows
  var rows = _twComms.filter(function (c) { return c.channel === ch; });
  var label = (TW_CHAN[ch] && TW_CHAN[ch].label) || ch;
  // Per-contact drawer with no contact picked → prompt. Standalone console shows
  // the channel inbox (loaded by twLoadThread), even with nothing selected.
  if (!twTargetId() && !_twStandalone) { box.innerHTML = '<div style="color:#bbb;text-align:center;padding:10px;">Pick a factory/customer to see ' + escC(label) + ' history.</div>'; return; }
  if (!rows.length) {
    var empty = twTargetId() ? ('No ' + escC(label) + ' history.') : ('No ' + escC(label) + ' messages yet.');
    box.innerHTML = '<div style="color:#bbb;text-align:center;padding:10px;">' + empty + '</div>'; return;
  }
  box.innerHTML = rows.map(twBubble).join('');
}
// ── AI summary card (factory-scoped; deterministic fallback for customers/no key) ──
function twFmtAgo(iso) { if (!iso) return ''; var d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000); return d <= 0 ? 'today' : (d === 1 ? '1 day ago' : d + ' days ago'); }
function twComputeStats(rows) {
  var s = { count: rows.length, last: null, lastChannel: '', lastTopic: '', byChan: {}, best: '' };
  if (rows.length) { var n = rows[0]; s.last = n.created_at; s.lastChannel = n.channel; var wb = rows.find(function (r) { return (r.body || '').trim(); }); s.lastTopic = wb ? (wb.body || '').slice(0, 90) : ''; }
  var agg = {}; rows.forEach(function (r) { if (r.response_time_hours != null && r.channel) (agg[r.channel] = agg[r.channel] || []).push(r.response_time_hours); });
  var best = null, bestAvg = Infinity;
  Object.keys(agg).forEach(function (ch) { var a = agg[ch]; var avg = a.reduce(function (x, y) { return x + y; }, 0) / a.length; s.byChan[ch] = Math.round(avg * 10) / 10; if (avg < bestAvg) { bestAvg = avg; best = ch; } });
  s.best = best || ''; return s;
}
function twDeterministicSummary(s) {
  if (!s.count) return 'No communications logged yet for this contact.';
  var lab = function (ch) { return (TW_CHAN[ch] && TW_CHAN[ch].label) || ch; };
  var parts = ['Last contacted via ' + lab(s.lastChannel) + (s.last ? ' ' + twFmtAgo(s.last) : '') + '.', s.count + ' total communication' + (s.count === 1 ? '' : 's') + '.'];
  var ks = Object.keys(s.byChan);
  if (ks.length) parts.push('Avg response: ' + ks.map(function (ch) { return lab(ch) + ' ' + s.byChan[ch] + 'hr'; }).join(', ') + '.');
  if (s.best) parts.push('Most responsive: ' + lab(s.best) + '.');
  if (s.lastTopic) parts.push('Last topic: ' + s.lastTopic);
  return parts.join(' ');
}
function twAiCardRender(text, at, loading) {
  var card = g('tw-ai-card'); if (!card) return;
  card.innerHTML =
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px;gap:8px;">' +
      '<span style="font-size:10px;font-weight:700;color:#5a2db8;text-transform:uppercase;letter-spacing:0.05em;">✦ AI Communications Summary</span>' +
      '<button onclick="twLoadAiSummary(true)" ' + (loading ? 'disabled' : '') + ' style="font-size:11px;padding:3px 9px;background:#fff;border:1px solid #d8c8f0;border-radius:6px;color:#5a2db8;cursor:pointer;font-family:inherit;flex-shrink:0;">↻ Regenerate</button>' +
    '</div>' +
    '<div style="font-size:12px;color:#333;line-height:1.5;">' + (loading ? '<span style="color:#999;">Generating…</span>' : escC(text || 'No communications yet.')) + '</div>' +
    (at && !loading ? '<div style="font-size:10px;color:#bbb;margin-top:4px;">Updated ' + escC(new Date(at).toLocaleString()) + '</div>' : '');
}
async function twLoadAiSummary(force) {
  if (!_twHome) return;
  var fid = _twHome.id, summary = _twHome.ai_summary, at = _twHome.ai_at, rows = [], isFactory = _twHome.kind !== 'customer';
  if (isFactory) {
    try {
      var fr = await fetch(SB + '/rest/v1/factories?id=eq.' + fid + '&select=ai_comms_summary,ai_comms_summary_at&limit=1', { headers: { apikey: KEY, Authorization: 'Bearer ' + KEY } });
      var frj = fr.ok ? await fr.json() : []; if (frj[0]) { summary = frj[0].ai_comms_summary; at = frj[0].ai_comms_summary_at; }
    } catch (e) { }
  }
  try {
    var rr = await fetch(SB + '/rest/v1/twilio_communications?factory_id=eq.' + fid + '&order=created_at.desc&limit=300', { headers: { apikey: KEY, Authorization: 'Bearer ' + KEY } });
    rows = rr.ok ? await rr.json() : [];
  } catch (e) { }
  if (!force) {
    if (summary && at && (!rows.length || new Date(rows[0].created_at) <= new Date(at))) { twAiCardRender(summary, at, false); return; }
    if (!rows.length) { twAiCardRender(summary || 'No communications logged yet for this contact.', at, false); return; }
  }
  var stats = twComputeStats(rows);
  var deterministic = twDeterministicSummary(stats);
  var apiKey = localStorage.getItem('anthropic_key') || '';
  if (!apiKey) { twAiCardRender(deterministic, at || null, false); return; }
  twAiCardRender('', null, true);
  try {
    var snippets = rows.slice(0, 8).map(function (r) { return (r.direction === 'outbound' ? 'OUT ' : 'IN ') + (r.channel || '') + ': ' + (r.body || '').slice(0, 80); }).join('\n');
    var prompt = 'You are summarizing a contact\'s communication history for a sourcing admin.\n' +
      'Stats (JSON): ' + JSON.stringify({ total: stats.count, last_channel: stats.lastChannel, last_contact: stats.last, avg_response_hours_by_channel: stats.byChan, most_responsive_channel: stats.best, last_topic: stats.lastTopic }) + '\n' +
      'Recent messages:\n' + snippets + '\n\n' +
      'Write ONE concise paragraph (2-3 sentences) modeled on: "Last contacted via WhatsApp 3 days ago. 12 total communications. Avg response time: WhatsApp 2hr, SMS 6hr. Last topic: pricing on lip gloss RFQ." Use the actual data above. Plain text only, no markdown.';
    var r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }, body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 200, messages: [{ role: 'user', content: prompt }] }) });
    var d = await r.json();
    var text = ((d.content && d.content[0] && d.content[0].text) || '').trim() || deterministic;
    var nowIso = new Date().toISOString();
    twAiCardRender(text, nowIso, false);
    _twHome.ai_summary = text; _twHome.ai_at = nowIso;
    if (isFactory) fetch(SB + '/rest/v1/factories?id=eq.' + fid, { method: 'PATCH', headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify({ ai_comms_summary: text, ai_comms_summary_at: nowIso }) }).catch(function () { });
  } catch (e) { twAiCardRender(deterministic, at || null, false); }
}
