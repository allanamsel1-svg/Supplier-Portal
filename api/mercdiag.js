// api/mercdiag.js — TEMPORARY. Probes Mercury API response shapes. Remove after.
export const config = { runtime: 'nodejs' };
export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if ((req.query && req.query.run) !== 'mercdiag') return res.status(400).json({ error: 'add ?run=mercdiag' });
  const KEY = process.env.MERCURY_API_KEY;
  if (!KEY) return res.status(500).json({ error: 'MERCURY_API_KEY not set' });
  const base = 'https://api.mercury.com/api/v1';
  const auth = { Authorization: 'Bearer ' + KEY, Accept: 'application/json' };
  const get = async (path) => {
    try { const r = await fetch(base + path, { headers: auth }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { status: r.status, body: j || t }; }
    catch (e) { return { error: e.message }; }
  };
  const out = {};
  const acc = await get('/accounts');
  out.accountsStatus = acc.status;
  // Trim accounts to shape + first account's id for a tx probe
  let firstId = null;
  if (acc.body && Array.isArray(acc.body.accounts)) {
    out.accountKeys = acc.body.accounts[0] ? Object.keys(acc.body.accounts[0]) : [];
    out.accountsSample = acc.body.accounts.map((a) => ({ id: a.id, name: a.name, nickname: a.nickname, currentBalance: a.currentBalance, availableBalance: a.availableBalance, kind: a.kind, status: a.status }));
    firstId = acc.body.accounts[0] && acc.body.accounts[0].id;
  } else { out.accountsBody = acc.body; }
  if (firstId) {
    const tx = await get('/account/' + firstId + '/transactions?limit=3');
    out.txStatus = tx.status;
    if (tx.body && Array.isArray(tx.body.transactions)) {
      out.txKeys = tx.body.transactions[0] ? Object.keys(tx.body.transactions[0]) : [];
      out.txSample = tx.body.transactions[0] || null;
      out.txTotal = tx.body.total;
    } else { out.txBody = tx.body; }
  }
  return res.status(200).json(out);
}
