// /api/backfill-clearance-placement.js
//
// Runs the clearance/placement vision backfill server-side (Anthropic key lives
// here, not locally). Processes one bounded batch per request so it stays within
// maxDuration; call repeatedly until remaining = 0.
//
//   GET/POST ?shopOutId=<uuid>&limit=<n>   → one shop-out (re-detect all)
//   GET/POST ?limit=<n>                    → observations with placement_type IS NULL

import { runBackfill } from '../lib/clearance-detect.mjs';

export const config = { runtime: 'nodejs' };
export const maxDuration = 300;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set in env' });

  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const shopOutId = (req.query && req.query.shopOutId) || (body && body.shopOutId) || null;
    const limit = Number((req.query && req.query.limit) || (body && body.limit) || 60);

    const logs = [];
    const summary = await runBackfill({ shopOutId, limit, log: m => logs.push(m) });
    return res.status(200).json({ success: true, shopOutId: shopOutId || null, ...summary, logs });
  } catch (err) {
    console.error('backfill-clearance-placement error:', err);
    return res.status(500).json({ error: err.message || String(err) });
  }
}
