// Form-control containment audit — finds selects/inputs/textareas/buttons
// whose box extends beyond the border of their nearest card/panel/modal.
// Reveals hidden form containers one at a time so dynamic forms get measured.
import puppeteer from 'puppeteer-core';
import { readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VIEWPORTS = [{ w: 1280 }, { w: 1440 }, { w: 390 }];
const onlyArg = process.argv[2];
const pages = readdirSync(ROOT).filter((f) => f.endsWith('.html'))
  .filter((f) => !onlyArg || f === onlyArg).sort();

// Reveal hidden containers (panels/forms/modals/drawers/panes) one index at a
// time, returning how many candidates exist. idx<0 reveals nothing (baseline).
const REVEAL = (idx) => {
  const RE = /(modal|drawer|form-view|editor|panel|pane|ppane|tab-panel|tabpane|sheet|dialog|popover|flyout)/i;
  const ACT = ['on', 'active', 'show', 'shown', 'open', 'visible', 'is-open', 'is-active'];
  const isHidden = (el) => { const cs = getComputedStyle(el); return cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0; };
  // Faithful reveal: keep position/flex/size; only neutralize the hiding mechanism.
  const force = (el) => {
    if (el.hasAttribute('data-revealed')) return;
    el.setAttribute('data-orig-style', el.getAttribute('style') || '');
    el.setAttribute('data-orig-class', el.getAttribute('class') || '');
    el.setAttribute('data-revealed', '1');
    ACT.forEach((c) => { try { el.classList.add(c); } catch {} });
    if (isHidden(el)) {
      // inline display:none → clear it; if stylesheet still hides, force a sane display
      el.style.display = '';
      if (isHidden(el)) el.style.cssText += ';display:block !important;visibility:visible !important;opacity:1 !important;';
    }
  };
  const cands = [];
  document.querySelectorAll('div,section,form,aside').forEach((el) => {
    const id = el.id || ''; const cls = (typeof el.className === 'string' ? el.className : '');
    if (!RE.test(id) && !RE.test(cls)) return;
    if (isHidden(el)) cands.push(el);
  });
  // restore any prior overrides
  document.querySelectorAll('[data-revealed]').forEach((el) => { el.style.cssText = el.getAttribute('data-orig-style') || ''; if (el.hasAttribute('data-orig-class')) el.setAttribute('class', el.getAttribute('data-orig-class')); el.removeAttribute('data-revealed'); el.removeAttribute('data-orig-style'); el.removeAttribute('data-orig-class'); });
  if (idx >= 0 && cands[idx]) {
    const el = cands[idx];
    // reveal the element, its hidden ancestors, and hidden form/modal descendants
    let a = el; while (a && a !== document.body) { if (isHidden(a)) force(a); a = a.parentElement; }
    force(el);
    el.querySelectorAll('*').forEach((d) => { const id = d.id || ''; const cls = (typeof d.className === 'string' ? d.className : ''); if ((RE.test(id) || RE.test(cls)) && isHidden(d)) force(d); });
  }
  return cands.length;
};

const PROBE = () => {
  const CARD_RE = /(card|panel|section|box|modal|drawer|sheet|dialog|qf|form-section|mgr-|ph\b|ri-section|auth-box)/i;
  const controls = document.querySelectorAll('select,input,textarea,button');
  const out = [];
  const seen = new Set();
  for (const c of controls) {
    const cr = c.getBoundingClientRect();
    if (cr.width === 0 || cr.height === 0) continue;
    const ccs = getComputedStyle(c);
    if (ccs.display === 'none' || ccs.visibility === 'hidden') continue;
    if (ccs.position === 'fixed' || ccs.position === 'absolute') continue; // popovers etc.
    // find nearest card-like ancestor; bail if a scroll/clip container sits between
    let a = c.parentElement, card = null, clipped = false;
    while (a && a !== document.body) {
      const acs = getComputedStyle(a);
      if (['auto', 'scroll', 'hidden', 'clip'].includes(acs.overflowX)) { clipped = true; break; }
      const acls = typeof a.className === 'string' ? a.className : '';
      const hasBorder = parseFloat(acs.borderRightWidth) > 0 && acs.borderRightStyle !== 'none';
      if (CARD_RE.test(acls) || CARD_RE.test(a.id || '') || hasBorder) { card = a; break; }
      a = a.parentElement;
    }
    if (clipped || !card) continue;
    const acs = getComputedStyle(card);
    const ar = card.getBoundingClientRect();
    const contentRight = ar.right - parseFloat(acs.borderRightWidth || 0) - parseFloat(acs.paddingRight || 0);
    const contentLeft = ar.left + parseFloat(acs.borderLeftWidth || 0) + parseFloat(acs.paddingLeft || 0);
    const overR = Math.round(cr.right - contentRight);
    const overL = Math.round(contentLeft - cr.left);
    const over = Math.max(overR, overL);
    if (over > 1.5) {
      const csel = c.tagName.toLowerCase() + (c.id ? '#' + c.id : '') + (typeof c.className === 'string' && c.className ? '.' + c.className.trim().split(/\s+/)[0] : '');
      const asel = card.tagName.toLowerCase() + (card.id ? '#' + card.id : '') + (typeof card.className === 'string' && card.className ? '.' + card.className.trim().split(/\s+/).slice(0,2).join('.') : '');
      const key = csel + '|' + asel;
      if (seen.has(key)) continue; seen.add(key);
      out.push({ ctrl: csel, card: asel, overR, overL, ctrlW: Math.round(cr.width), cardW: Math.round(ar.width), width: ccs.width, maxW: ccs.maxWidth, box: ccs.boxSizing });
    }
  }
  return out;
};

const report = {};
const OUT = join(ROOT, 'scripts', 'form_overflow_result.json');
for (const file of pages) {
  const url = pathToFileURL(join(ROOT, file)).href;
  report[file] = {};
  let browser;
  try {
    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', protocolTimeout: 9000, args: ['--no-sandbox', '--hide-scrollbars'] });
    const page = await browser.newPage();
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    page.on('pageerror', () => {}); page.on('console', () => {});
    for (const vp of VIEWPORTS) {
      const findings = [];
      try {
        await page.setViewport({ width: vp.w, height: 900, deviceScaleFactor: 1 });
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 7000 }).catch(() => {});
        await new Promise((r) => setTimeout(r, 500));
        const n = await page.evaluate(REVEAL, -1).catch(() => 0);
        // baseline (nothing revealed)
        (await page.evaluate(PROBE).catch(() => [])).forEach((f) => findings.push({ ...f, ctx: '(visible)' }));
        const N = Math.min(n, 30);
        for (let i = 0; i < N; i++) {
          await page.evaluate(REVEAL, i).catch(() => {});
          await new Promise((r) => setTimeout(r, 120));
          (await page.evaluate(PROBE).catch(() => [])).forEach((f) => findings.push({ ...f, ctx: 'reveal#' + i }));
        }
      } catch (e) { findings.push({ error: String(e).split('\n')[0] }); }
      // dedupe by ctrl|card
      const seen = new Set(); const uniq = [];
      for (const f of findings.sort((a, b) => (Math.max(b.overR||0,b.overL||0)) - (Math.max(a.overR||0,a.overL||0)))) {
        const k = f.error || (f.ctrl + '|' + f.card);
        if (seen.has(k)) continue; seen.add(k); uniq.push(f);
      }
      report[file][vp.w] = uniq.slice(0, 25);
    }
    await page.close().catch(() => {});
  } catch (e) { report[file].error = String(e).split('\n')[0]; }
  finally { if (browser) await browser.close().catch(() => {}); }
  writeFileSync(OUT, JSON.stringify(report));
  process.stdout.write('done ' + file + '\n');
}

for (const file of pages) {
  const r = report[file]; if (!r) continue;
  const lines = [];
  for (const vp of VIEWPORTS) {
    const fs = r[vp.w]; if (!fs || !fs.length) continue;
    for (const f of fs) {
      if (f.error) { lines.push(`  [${vp.w}] ERROR ${f.error}`); continue; }
      const dir = f.overR >= f.overL ? `R+${f.overR}` : `L+${f.overL}`;
      lines.push(`  [${vp.w}] ${dir}px  ${f.ctrl}  out of  ${f.card}  (w=${f.width} maxW=${f.maxW} box=${f.box} ctx=${f.ctx})`);
    }
  }
  if (lines.length) { console.log('== ' + file + ' =='); console.log(lines.join('\n')); }
}
console.log('\n[form-overflow audit complete]');
