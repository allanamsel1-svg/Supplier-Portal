// ============================================================
// /api/roadmap-status.js
//
// Read-only session-orientation endpoint. Returns the current
// roadmap state (grouped by status) plus the system_registry and
// a compact text digest — so a new Claude session can be brought
// up to speed by pasting ONE URL response instead of running
// queries and copy-pasting tables.
//
// GET /api/roadmap-status
//   → {
//       success: true,
//       generated_at,
//       roadmap: { now:[...], next:[...], soon:[...], on_hold:[...], backlog:[...], done_recent:[...] },
//       registry: [{ feature, area, status, last_touched }, ...],
//       digest: "human-readable one-paste summary"
//     }
//
// No params. No auth beyond the service key (read-only, returns
// only titles/status — no sensitive data).
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json'
    }
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Missing Supabase env vars' });
  }

  try {
    // Roadmap: pull all, group by status. done_recent = last 15 closed (most recent first).
    const items = await sb(
      'roadmap_items?select=title,status,priority,description&order=priority.desc.nullslast,title'
    );

    const buckets = { now: [], next: [], soon: [], on_hold: [], backlog: [], done: [] };
    (items || []).forEach(it => {
      const s = (it.status || 'backlog').toLowerCase();
      if (buckets[s]) buckets[s].push(it);
      else (buckets.backlog = buckets.backlog || []).push(it);
    });

    const slim = arr => arr.map(it => ({ title: it.title, description: (it.description || '').slice(0, 200) }));

    const roadmap = {
      now: slim(buckets.now),
      next: slim(buckets.next),
      soon: slim(buckets.soon),
      on_hold: slim(buckets.on_hold),
      backlog: slim(buckets.backlog),
      done_recent: slim(buckets.done.slice(0, 15))
    };

    // Registry: feature + status, most recently touched first.
    let registry = [];
    try {
      registry = await sb('system_registry?select=feature,area,status,last_touched&order=last_touched.desc.nullslast');
    } catch (e) { /* registry optional */ }

    // Compact text digest — the part that's easy to read in a browser tab.
    const line = it => `  • ${it.title}`;
    const digestParts = [];
    digestParts.push('=== ROADMAP STATUS (' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC) ===');
    digestParts.push('');
    digestParts.push('NOW (' + roadmap.now.length + '):');
    digestParts.push(roadmap.now.length ? roadmap.now.map(line).join('\n') : '  (none)');
    digestParts.push('');
    digestParts.push('NEXT (' + roadmap.next.length + '):');
    digestParts.push(roadmap.next.length ? roadmap.next.map(line).join('\n') : '  (none)');
    digestParts.push('');
    digestParts.push('SOON (' + roadmap.soon.length + '):');
    digestParts.push(roadmap.soon.length ? roadmap.soon.map(line).join('\n') : '  (none)');
    if (roadmap.on_hold.length) {
      digestParts.push('');
      digestParts.push('ON HOLD (' + roadmap.on_hold.length + '):');
      digestParts.push(roadmap.on_hold.map(line).join('\n'));
    }
    digestParts.push('');
    digestParts.push('BACKLOG: ' + roadmap.backlog.length + ' items');
    digestParts.push('RECENTLY DONE: ' + (buckets.done.length) + ' total, last ' + roadmap.done_recent.length + ' shown');
    digestParts.push(roadmap.done_recent.map(line).join('\n'));

    const digest = digestParts.join('\n');

    return res.status(200).json({
      success: true,
      generated_at: new Date().toISOString(),
      counts: {
        now: roadmap.now.length, next: roadmap.next.length, soon: roadmap.soon.length,
        on_hold: roadmap.on_hold.length, backlog: roadmap.backlog.length, done_total: buckets.done.length
      },
      roadmap,
      registry,
      digest
    });
  } catch (err) {
    console.error('roadmap-status error:', err);
    return res.status(500).json({ error: err.message });
  }
}
