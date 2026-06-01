// One-time backfill: factory-match all existing shop-out observations against
// the indexed factory_product_attributes (reusing lib/factory-match.mjs).
//
//   node scripts/backfill-factory-match.mjs
//
// Sets factory_match_id / factory_match_confidence where the top score >= 3.

import { bestFactoryMatch } from '../lib/factory-match.mjs';

const SB = 'https://mjkjubctswjwjihxjpnd.supabase.co';
const KEY = process.env.SUPABASE_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1qa2p1YmN0c3dqd2ppaHhqcG5kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczNjQxNjcsImV4cCI6MjA5Mjk0MDE2N30.cZrD_ymrDsRPyfX_g3hUui5_JXuW6BgE77QkIoGpqHo';

function h(path, opts = {}) {
  opts.headers = { ...(opts.headers || {}), apikey: KEY, Authorization: 'Bearer ' + KEY };
  return fetch(SB + path, opts);
}

const attrs = await (await h('/rest/v1/factory_product_attributes?select=*')).json();
if (!attrs.length) { console.log('No factory_product_attributes indexed yet — nothing to match. Seed the index first.'); process.exit(0); }

const facIds = [...new Set(attrs.map(a => a.factory_id).filter(Boolean))];
const facById = {};
if (facIds.length) {
  const f = await (await h(`/rest/v1/factories?id=in.(${facIds.join(',')})&select=id,factory_name_english`)).json();
  f.forEach(x => { facById[x.id] = x; });
}

const obs = await (await h('/rest/v1/shop_out_observations?select=id,brand,product_name,ai_suggested_category,normalized_unit&limit=10000')).json();

let matched = 0, byFactory = {}, failed = 0;
for (const o of obs) {
  const m = bestFactoryMatch(o, attrs, facById);
  if (!m.factory_match_id) continue;
  const r = await h('/rest/v1/shop_out_observations?id=eq.' + o.id, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(m)
  });
  if (!r.ok) { failed++; console.error('PATCH failed', o.id, r.status, await r.text()); continue; }
  matched++;
  const name = (facById[m.factory_match_id] || {}).factory_name_english || m.factory_match_id;
  byFactory[name] = (byFactory[name] || 0) + 1;
}

console.log('\nFactory-match backfill');
console.log(`  indexed factory products: ${attrs.length} (across ${facIds.length} factories)`);
console.log(`  observations scanned:     ${obs.length}`);
console.log(`  observations matched (score >= 3): ${matched}`);
Object.keys(byFactory).forEach(n => console.log(`    ${n}: ${byFactory[n]}`));
if (failed) console.log(`  PATCH failures: ${failed}`);
