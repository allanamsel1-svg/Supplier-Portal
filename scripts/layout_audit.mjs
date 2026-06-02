// Layout & overflow audit harness — renders each root HTML page in headless
// Chrome at 1280 / 1440 / 390 px and reports real overflow/clipping/overlap.
import puppeteer from 'puppeteer-core';
import { readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VIEWPORTS = [
  { w: 1280, h: 900, name: '1280' },
  { w: 1440, h: 900, name: '1440' },
  { w: 390, h: 844, name: '390' },
];

const onlyArg = process.argv[2]; // optional: audit a single page
const pages = readdirSync(ROOT)
  .filter((f) => f.endsWith('.html'))
  .filter((f) => !onlyArg || f === onlyArg)
  .sort();

const PROBE = () => {
  const vw = window.innerWidth;
  const docW = document.documentElement.scrollWidth;
  const horiz = docW - vw;
  const offenders = [];
  const seen = new Set();
  const all = document.querySelectorAll('*');
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const overR = Math.round(r.right - vw);
    const overL = Math.round(0 - r.left);
    if (overR > 1 || overL > 1) {
      const sel =
        el.tagName.toLowerCase() +
        (el.id ? '#' + el.id : '') +
        (el.className && typeof el.className === 'string'
          ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.')
          : '');
      const key = sel + '|' + Math.max(overR, overL);
      if (seen.has(key)) continue;
      seen.add(key);
      offenders.push({
        sel, overRight: overR, overLeft: overL,
        w: Math.round(r.width), scrollW: el.scrollWidth, clientW: el.clientWidth,
        overflowX: cs.overflowX, whiteSpace: cs.whiteSpace,
      });
    }
  }
  offenders.sort((a, b) => Math.max(b.overRight, b.overLeft) - Math.max(a.overRight, a.overLeft));

  const fixedEls = [];
  for (const el of all) {
    const cs = getComputedStyle(el);
    if (cs.position === 'fixed' || cs.position === 'sticky') {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      fixedEls.push({
        sel: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
          (typeof el.className === 'string' && el.className
            ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''),
        position: cs.position, zIndex: cs.zIndex,
        top: Math.round(r.top), left: Math.round(r.left), h: Math.round(r.height),
      });
    }
  }
  return { vw, docW, horiz, offenders: offenders.slice(0, 15), fixedEls };
};

const report = {};
const OUT = join(ROOT, 'scripts', 'layout_audit_result.json');

for (const file of pages) {
  const url = pathToFileURL(join(ROOT, file)).href;
  report[file] = {};
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: 'new',
      protocolTimeout: 8000,
      args: ['--no-sandbox', '--hide-scrollbars'],
    });
    const page = await browser.newPage();
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    page.on('pageerror', () => {});
    page.on('console', () => {});
    for (const vp of VIEWPORTS) {
      try {
        await page.setViewport({ width: vp.w, height: vp.h, deviceScaleFactor: 1 });
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 7000 }).catch(() => {});
        await new Promise((r) => setTimeout(r, 600));
        report[file][vp.name] = await page.evaluate(PROBE);
      } catch (e) {
        report[file][vp.name] = { error: String(e).split('\n')[0] };
      }
    }
    await page.close().catch(() => {});
  } catch (e) {
    for (const vp of VIEWPORTS) report[file][vp.name] = report[file][vp.name] || { error: String(e).split('\n')[0] };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  // incremental flush
  writeFileSync(OUT, JSON.stringify(report, null, 0));
  process.stdout.write('done ' + file + '\n');
}

for (const file of pages) {
  console.log('\n========== ' + file + ' ==========');
  for (const vp of VIEWPORTS) {
    const r = report[file][vp.name];
    if (!r) continue;
    if (r.error) { console.log(`  [${vp.name}] ERROR ${r.error}`); continue; }
    const tag = r.horiz > 1 ? `OVERFLOW +${r.horiz}px` : 'ok';
    console.log(`  [${vp.name}px] doc=${r.docW} vw=${r.vw} -> ${tag}`);
    for (const o of r.offenders) {
      const dir = o.overRight > o.overLeft ? `R+${o.overRight}` : `L+${o.overLeft}`;
      console.log(`      ${dir}  ${o.sel}  (w=${o.w} sw=${o.scrollW} cw=${o.clientW} ox=${o.overflowX} ws=${o.whiteSpace})`);
    }
  }
}
