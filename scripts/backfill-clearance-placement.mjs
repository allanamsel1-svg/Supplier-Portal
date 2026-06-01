// Backfill clearance + placement_type on shop-out observations via Anthropic
// vision (logic in lib/clearance-detect.mjs, shared with the server endpoint).
//
//   node scripts/backfill-clearance-placement.mjs              # all placement_type IS NULL
//   node scripts/backfill-clearance-placement.mjs <shopOutId>  # all obs for one shop-out
//
// Requires ANTHROPIC_API_KEY in the environment. For each observation it signs
// the front photo, sends it to the AI with the clearance/placement prompt, and
// PATCHes is_clearance / clearance_confidence / placement_type, in batches of
// 20, then prints a summary (processed, clearance found, placement breakdown).

import { runBackfill } from '../lib/clearance-detect.mjs';

const shopOutId = process.argv[2] || null;
const summary = await runBackfill({ shopOutId, log: console.log });
console.log('\nClearance/placement backfill' + (shopOutId ? ' — shop_out ' + shopOutId : ''));
console.log('  total processed: ' + summary.processed);
console.log('  clearance found: ' + summary.clearance);
console.log('  placement breakdown: ' + JSON.stringify(summary.placement));
if (summary.errors) console.log('  errors: ' + summary.errors);
