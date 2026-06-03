// api/mercury.js
//
// Server-side proxy for the Mercury Bank API. The MERCURY_API_KEY lives only in
// Vercel env and is NEVER exposed to the client.
//
//   GET /api/mercury?action=accounts
//       → { accounts: [{ id, name, currency, currentBalance, availableBalance, status, kind }] }
//   GET /api/mercury?action=transactions&accountId={id}&limit=50
//       → { transactions: [{ id, account_id, amount, direction, description,
//                            counterparty_name, posted_at, created_at, status }], total }
//     Side effect: upserts the returned transactions into Supabase `mercury_sync`
//     (so page-load and refresh both keep the local mirror current).
export const config = { runtime: 'nodejs' };

const MERCURY_BASE = 'https://api.mercury.com/api/v1';
const SB_URL = 'https://mjkjubctswjwjihxjpnd.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1qa2p1YmN0c3dqd2ppaHhqcG5kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczNjQxNjcsImV4cCI6MjA5Mjk0MDE2N30.cZrD_ymrDsRPyfX_g3hUui5_JXuW6BgE77QkIoGpqHo';

function mercAuth() {
  const KEY = process.env.MERCURY_API_KEY;
  return KEY ? { Authorization: 'Bearer ' + KEY, Accept: 'application/json' } : null;
}

async function mercGet(path) {
  const headers = mercAuth();
  if (!headers) return { ok: false, status: 500, error: 'MERCURY_API_KEY is not configured in the environment' };
  try {
    const r = await fetch(MERCURY_BASE + path, { headers });
    const text = await r.text();
    let body = null; try { body = JSON.parse(text); } catch { body = text; }
    if (!r.ok) return { ok: false, status: r.status, error: (body && body.errors && body.errors.message) || (body && body.message) || ('Mercury API error ' + r.status), body };
    return { ok: true, status: r.status, body };
  } catch (e) { return { ok: false, status: 502, error: e.message }; }
}

function normAccount(a) {
  return {
    id: a.id,
    name: a.nickname || a.name || a.legalBusinessName || 'Account',
    currency: a.currency || 'USD',
    currentBalance: typeof a.currentBalance === 'number' ? a.currentBalance : (a.currentBalance != null ? Number(a.currentBalance) : null),
    availableBalance: typeof a.availableBalance === 'number' ? a.availableBalance : (a.availableBalance != null ? Number(a.availableBalance) : null),
    status: a.status || null,
    kind: a.kind || a.type || null,
    accountNumber: a.accountNumber ? ('••••' + String(a.accountNumber).slice(-4)) : null,
  };
}

function normTx(t, accountId) {
  const amount = typeof t.amount === 'number' ? t.amount : Number(t.amount || 0);
  const description = t.bankDescription || t.externalMemo || t.note || t.counterpartyName || t.kind || '—';
  return {
    id: t.id,
    account_id: accountId,
    amount,
    direction: amount >= 0 ? 'credit' : 'debit',
    description,
    counterparty_name: t.counterpartyName || t.counterpartyNickname || null,
    posted_at: t.postedAt || null,
    created_at: t.createdAt || null,
    status: t.status || null,
  };
}

async function upsertSync(rows) {
  if (!rows.length) return;
  const payload = rows.map((t) => ({
    account_id: t.account_id,
    transaction_id: t.id,
    amount: t.amount,
    direction: t.direction,
    description: t.description,
    counterparty_name: t.counterparty_name,
    posted_at: t.posted_at || t.created_at || null,
  }));
  try {
    await fetch(SB_URL + '/rest/v1/mercury_sync?on_conflict=transaction_id', {
      method: 'POST',
      headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(payload),
    });
  } catch { /* mirror is best-effort */ }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const action = (req.query && req.query.action) || '';

  if (action === 'accounts') {
    const r = await mercGet('/accounts');
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    const accounts = (r.body && Array.isArray(r.body.accounts) ? r.body.accounts : []).map(normAccount);
    return res.status(200).json({ accounts });
  }

  if (action === 'transactions') {
    const accountId = (req.query && req.query.accountId) || '';
    if (!accountId) return res.status(400).json({ error: 'Missing accountId' });
    let limit = parseInt((req.query && req.query.limit) || '50', 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 50;
    if (limit > 500) limit = 500;
    const r = await mercGet('/account/' + encodeURIComponent(accountId) + '/transactions?limit=' + limit + '&offset=0');
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    const list = (r.body && Array.isArray(r.body.transactions) ? r.body.transactions : []).map((t) => normTx(t, accountId));
    await upsertSync(list);
    return res.status(200).json({ transactions: list, total: (r.body && r.body.total) != null ? r.body.total : list.length });
  }

  return res.status(400).json({ error: 'Unknown action. Use action=accounts or action=transactions' });
}
