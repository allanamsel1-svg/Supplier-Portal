const https = require('https');

const SB_URL = process.env.SUPABASE_URL || 'https://mjkjubctswjwjihxjpnd.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function sbGet(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(SB_URL + path);
    const req = https.request({
      hostname: url.hostname, path: url.pathname + url.search,
      method: 'GET', headers: {
        'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY,
        'Accept': 'application/json'
      }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(d) }); } catch(e) { resolve({ status: res.statusCode, data: d }); } });
    });
    req.on('error', reject); req.end();
  });
}

function sbDelete(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(SB_URL + path);
    const req = https.request({
      hostname: url.hostname, path: url.pathname + url.search,
      method: 'DELETE', headers: {
        'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY
      }
    }, res => { resolve({ status: res.statusCode }); });
    req.on('error', reject); req.end();
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!SB_KEY) return res.status(500).json({ error: 'Missing SUPABASE_SERVICE_ROLE_KEY' });

  const { action, dataset_id } = req.query;

  try {
    if (req.method === 'GET' && action === 'datasets') {
      const r = await sbGet('/rest/v1/ig_datasets?select=id,dataset_name,category,competitor_name,row_count,uploaded_at&order=uploaded_at.desc&limit=20');
      return res.status(200).json(r.data);
    }

    if (req.method === 'GET' && action === 'shipments' && dataset_id) {
      const r = await sbGet('/rest/v1/ig_shipments?select=*&dataset_id=eq.' + dataset_id + '&order=arrival_date.desc&limit=10000');
      return res.status(200).json(r.data);
    }

    if (req.method === 'DELETE' && action === 'dataset' && dataset_id) {
      await sbDelete('/rest/v1/ig_shipments?dataset_id=eq.' + dataset_id);
      await sbDelete('/rest/v1/ig_datasets?id=eq.' + dataset_id);
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
