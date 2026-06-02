// Tab-traversal overflow audit — activates every tab/pane on each page and
// re-measures document overflow, catching issues hidden in inactive panes.
import puppeteer from 'puppeteer-core';
import { readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VIEWPORTS = [
  { w: 1280, name: '1280' },
  { w: 1440, name: '1440' },
  { w: 390, name: '390' },
];
const onlyArg = process.argv[2];
const pages = readdirSync(ROOT).filter((f) => f.endsWith('.html'))
  .filter((f) => !onlyArg || f === onlyArg).sort();

// Returns list of clickable tab/nav triggers (text + index) without clicking.
const LIST_TRIGGERS = () => {
  const sels = ['.tab', '.ri-tab', '.ptab', '.rfq-tab',
    '[onclick*="switchTab"]', '[onclick*="showTab"]', '[onclick*="selectTab"]',
    '[onclick*="showPanel"]', '[onclick*="switchPanel"]', '[onclick*="openPanel"]',
    '.nav-item', '.sidebar a', '.sidebar button', '.side-item', '.menu-item'];
  const set = new Set();
  const out = [];
  document.querySelectorAll(sels.join(',')).forEach((el) => {
    if (set.has(el)) return; set.add(el);
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    out.push((el.textContent || '').trim().slice(0, 30));
  });
  return out;
};

const CLICK_NTH = (n) => {
  const sels = ['.tab', '.ri-tab', '.ptab', '.rfq-tab',
    '[onclick*="switchTab"]', '[onclick*="showTab"]', '[onclick*="selectTab"]',
    '[onclick*="showPanel"]', '[onclick*="switchPanel"]', '[onclick*="openPanel"]',
    '.nav-item', '.sidebar a', '.sidebar button', '.side-item', '.menu-item'];
  const set = new Set(); const out = [];
  document.querySelectorAll(sels.join(',')).forEach((el) => {
    if (set.has(el)) return; set.add(el);
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    out.push(el);
  });
  const el = out[n];
  if (!el) return false;
  try { el.click(); } catch {}
  return true;
};

const MEASURE = () => {
  const vw = window.innerWidth;
  const horiz = document.documentElement.scrollWidth - vw;
  let worst = null;
  if (horiz > 1) {
    const all = document.querySelectorAll('*');
    for (const el of all) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const over = Math.max(Math.round(r.right - vw), Math.round(-r.left));
      if (over > 1) {
        // skip elements that live inside an overflow-x scroll container (by design)
        let p = el.parentElement, scrollable = false;
        while (p) {
          const pcs = getComputedStyle(p);
          if (pcs.overflowX === 'auto' || pcs.overflowX === 'scroll') { scrollable = true; break; }
          p = p.parentElement;
        }
        if (scrollable) continue;
        const sel = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
          (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
        if (!worst || over > worst.over) worst = { sel, over, ox: cs.overflowX };
      }
    }
  }
  return { horiz, worst };
};

const report = {};
const OUT = join(ROOT, 'scripts', 'layout_audit_tabs_result.json');

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
        let triggers = [];
        try { triggers = await page.evaluate(LIST_TRIGGERS); } catch {}
        // baseline
        let base = await page.evaluate(MEASURE).catch(() => ({ horiz: 0 }));
        if (base.horiz > 1) findings.push({ tab: '(default)', ...base });
        const N = Math.min(triggers.length, 40);
        for (let i = 0; i < N; i++) {
          try {
            const ok = await page.evaluate(CLICK_NTH, i);
            if (!ok) continue;
            await new Promise((r) => setTimeout(r, 250));
            const m = await page.evaluate(MEASURE);
            if (m.horiz > 1) findings.push({ tab: triggers[i] || ('#' + i), ...m });
          } catch {}
        }
      } catch (e) {
        findings.push({ error: String(e).split('\n')[0] });
      }
      // dedupe by worst sel
      const seen = new Set(); const uniq = [];
      for (const f of findings.sort((a, b) => (b.horiz || 0) - (a.horiz || 0))) {
        const k = (f.worst && f.worst.sel) || f.error || f.tab;
        if (seen.has(k)) continue; seen.add(k); uniq.push(f);
      }
      report[file][vp.name] = uniq.slice(0, 8);
    }
    await page.close().catch(() => {});
  } catch (e) {
    report[file].error = String(e).split('\n')[0];
  } finally { if (browser) await browser.close().catch(() => {}); }
  writeFileSync(OUT, JSON.stringify(report));
  process.stdout.write('done ' + file + '\n');
}

for (const file of pages) {
  const r = report[file]; if (!r) continue;
  const blocks = [];
  for (const vp of VIEWPORTS) {
    const fs = r[vp.name]; if (!fs || !fs.length) continue;
    blocks.push(`  [${vp.name}]`);
    for (const f of fs) {
      if (f.error) { blocks.push(`     ERROR ${f.error}`); continue; }
      blocks.push(`     +${f.horiz}px  tab="${f.tab}"  ${f.worst ? f.worst.sel + ' (ox=' + f.worst.ox + ')' : ''}`);
    }
  }
  if (blocks.length) { console.log('== ' + file + ' =='); console.log(blocks.join('\n')); }
}
console.log('\n[tab-traversal audit complete]');
