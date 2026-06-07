const https = require('https');

const SB_URL = process.env.SUPABASE_URL || 'https://mjkjubctswjwjihxjpnd.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function sbPost(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(SB_URL + path);
    const req = https.request({
      hostname: url.hostname, path: url.pathname + url.search,
      method: 'POST', headers: {
        'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY,
        'Content-Type': 'application/json', 'Prefer': 'return=representation',
        'Content-Length': Buffer.byteLength(data)
      }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(d) }); } catch(e) { resolve({ status: res.statusCode, data: d }); } });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!SB_KEY) return res.status(500).json({ error: 'Missing SUPABASE_SERVICE_ROLE_KEY' });

  try {
    const { dataset_name, category, competitor_name, pull_type, date_from, date_to, row_count, uploaded_by, shipments } = req.body;

    // Insert dataset
    const dsRes = await sbPost('/rest/v1/ig_datasets', {
      dataset_name, category: category || 'general', competitor_name: competitor_name || null,
      pull_type: pull_type || 'manual_upload', date_from: date_from || null,
      date_to: date_to || null, row_count: row_count || shipments.length,
      uploaded_by: uploaded_by || 'admin'
    });
    if (dsRes.status >= 300) return res.status(500).json({ error: 'Dataset insert failed', detail: dsRes.data });
    const datasetId = dsRes.data[0].id;

    // Insert shipments in batches of 200
    const tagged = shipments.map(s => ({ ...s, dataset_id: datasetId }));
    for (let i = 0; i < tagged.length; i += 200) {
      const batch = tagged.slice(i, i + 200);
      const bRes = await sbPost('/rest/v1/ig_shipments', batch);
      if (bRes.status >= 300) return res.status(500).json({ error: 'Shipment insert failed at row ' + i, detail: bRes.data });
    }

    return res.status(200).json({ success: true, dataset_id: datasetId, row_count: tagged.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
