#!/usr/bin/env node
/**
 * TBG Sourcing — Video Shop Out Processor
 * Usage: node tools/process_shopout.js <video_file> [store_name] [--fps N]
 * Requires: brew install ffmpeg
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const https = require('https');

const CONFIG = {
  fps: 1, batchSize: 5, maxFrames: 300,
  model: 'claude-opus-4-5', maxTokens: 1500,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_SERVICE_KEY,
};

const args = process.argv.slice(2);
if (args.length < 1) { console.error('Usage: node tools/process_shopout.js <video_file> [store_name] [--fps N]'); process.exit(1); }
const videoFile = args[0];
const storeName = args[1] && !args[1].startsWith('--') ? args[1] : 'Unknown Store';
const fpsArg = args.find(a => a.startsWith('--fps=') || a === '--fps');
if (fpsArg === '--fps') CONFIG.fps = parseFloat(args[args.indexOf('--fps') + 1]) || 1;
else if (fpsArg) CONFIG.fps = parseFloat(fpsArg.split('=')[1]) || 1;
if (!fs.existsSync(videoFile)) { console.error(`Error: File not found: ${videoFile}`); process.exit(1); }
if (!CONFIG.anthropicApiKey) { console.error('Error: ANTHROPIC_API_KEY not set'); process.exit(1); }

const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outputDir = path.join(path.dirname(videoFile), `shopout_frames_${timestamp}`);
const resultsJson = path.join(path.dirname(videoFile), `shopout_results_${timestamp}.json`);
const resultsCsv = path.join(path.dirname(videoFile), `shopout_results_${timestamp}.csv`);

function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }
function logError(msg) { console.error(`[ERROR] ${msg}`); }

function extractFrames() {
  log(`Extracting frames from: ${videoFile} at ${CONFIG.fps}fps`);
  fs.mkdirSync(outputDir, { recursive: true });
  try { execSync('ffmpeg -version', { stdio: 'ignore' }); }
  catch (e) { logError('ffmpeg not found. Install: brew install ffmpeg'); process.exit(1); }
  const framePattern = path.join(outputDir, 'frame_%04d.jpg');
  try { execSync(`ffmpeg -i "${videoFile}" -vf fps=${CONFIG.fps} -q:v 2 "${framePattern}" -y`, { stdio: 'pipe' }); }
  catch (e) { logError(`ffmpeg failed: ${e.message}`); process.exit(1); }
  const frames = fs.readdirSync(outputDir).filter(f => f.endsWith('.jpg')).sort().map(f => path.join(outputDir, f));
  log(`Extracted ${frames.length} frames`);
  return frames.length > CONFIG.maxFrames ? frames.slice(0, CONFIG.maxFrames) : frames;
}

async function analyzeFrameBatch(frames, batchIndex) {
  const content = [];
  for (let i = 0; i < frames.length; i++) {
    const base64 = fs.readFileSync(frames[i]).toString('base64');
    content.push({ type: 'text', text: `Frame ${batchIndex * CONFIG.batchSize + i + 1}:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } });
  }
  content.push({ type: 'text', text: `These are ${frames.length} consecutive frames from a retail shelf walkthrough at ${storeName}. For each clearly visible product extract: product_name, brand, category, price (from shelf signs — at Five Below typically $1/$3/$5/$7/$10), price_confidence (high/medium/low), packaging, size, upc (if visible), quantity_on_shelf, notes. Associate each product with the nearest price sign. If same product appears in multiple frames list it ONCE. Respond ONLY with a JSON array, no other text. Example: [{"product_name":"Garnier Shampoo","brand":"Garnier","category":"Hair Care","price":5.00,"price_confidence":"high","packaging":"bottle","size":"12oz","upc":null,"quantity_on_shelf":6,"notes":"Green apple","frame":3}]` });
  const response = await callAnthropicAPI(content);
  try {
    let cleaned = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) { logError(`Parse failed batch ${batchIndex + 1}: ${e.message}`); return []; }
}

function callAnthropicAPI(content) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: CONFIG.model, max_tokens: CONFIG.maxTokens, messages: [{ role: 'user', content }] });
    const options = { hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': CONFIG.anthropicApiKey, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) } };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { const p = JSON.parse(data); if (p.error) reject(new Error(`API error: ${p.error.message}`)); else resolve(p.content[0].text); }
        catch (e) { reject(new Error(`Parse error: ${e.message}`)); }
      });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

function deduplicateProducts(products) {
  const seen = new Map();
  for (const p of products) {
    const key = `${(p.brand||'').toLowerCase()}_${(p.product_name||'').toLowerCase()}_${p.price}`;
    if (!seen.has(key)) seen.set(key, p);
    else { const ex = seen.get(key); if (p.upc && !ex.upc) seen.set(key, { ...ex, upc: p.upc }); }
  }
  return Array.from(seen.values());
}

function saveResults(products) {
  const results = { metadata: { store: storeName, video_file: path.basename(videoFile), processed_at: new Date().toISOString(), total_products: products.length, fps_used: CONFIG.fps }, products };
  fs.writeFileSync(resultsJson, JSON.stringify(results, null, 2));
  const headers = ['product_name','brand','category','price','price_confidence','packaging','size','upc','quantity_on_shelf','notes'];
  const csv = [`# TBG Shop Out — ${storeName} — ${new Date().toLocaleDateString()}`, headers.join(','), ...products.map(p => headers.map(h => { const v = p[h]??''; return typeof v==='string'&&v.includes(',') ? `"${v}"` : v; }).join(','))].join('\n');
  fs.writeFileSync(resultsCsv, csv);
  log(`Saved: ${resultsJson}`); log(`Saved: ${resultsCsv}`);
  return results;
}

async function uploadToPortal(results) {
  if (!CONFIG.supabaseUrl || !CONFIG.supabaseKey) { log('Skipping portal upload — env vars not set'); return; }
  log('Uploading to portal...');
  const sessionBody = JSON.stringify({ store_name: results.metadata.store, visit_date: new Date().toISOString().split('T')[0], source: 'video', video_filename: results.metadata.video_file, total_items: results.metadata.total_products, status: 'processed' });
  const sessionRes = await supabasePost('/shop_out_sessions', sessionBody);
  if (!sessionRes?.[0]) { logError('Failed to create session'); return; }
  const sessionId = sessionRes[0].id;
  for (let i = 0; i < results.products.length; i += 50) {
    const batch = results.products.slice(i, i+50).map(p => ({ session_id: sessionId, store_name: results.metadata.store, product_name: p.product_name, brand: p.brand, category: p.category, retail_price: p.price, packaging_type: p.packaging, size: p.size, upc: p.upc, quantity_on_shelf: p.quantity_on_shelf, notes: p.notes, source: 'video_ai', confidence: p.price_confidence==='high'?0.9:0.7 }));
    await supabasePost('/shop_out_items', JSON.stringify(batch));
  }
  log(`Uploaded ${results.products.length} products to session ${sessionId}`);
}

function supabasePost(endpoint, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(CONFIG.supabaseUrl + '/rest/v1' + endpoint);
    const options = { hostname: url.hostname, path: url.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'apikey': CONFIG.supabaseKey, 'Authorization': `Bearer ${CONFIG.supabaseKey}`, 'Prefer': 'return=representation', 'Content-Length': Buffer.byteLength(body) } };
    const req = https.request(options, (res) => { let d=''; res.on('data', c => d+=c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(null); } }); });
    req.on('error', reject); req.write(body); req.end();
  });
}

async function main() {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║  TBG Sourcing — Video Shop Out Processor  ║');
  console.log('╚══════════════════════════════════════════╝\n');
  const frames = extractFrames();
  if (!frames.length) { logError('No frames extracted'); process.exit(1); }
  const batches = [];
  for (let i = 0; i < frames.length; i += CONFIG.batchSize) batches.push(frames.slice(i, i+CONFIG.batchSize));
  log(`Analyzing ${frames.length} frames in ${batches.length} batches...`);
  const allProducts = [];
  for (let i = 0; i < batches.length; i++) {
    log(`Batch ${i+1}/${batches.length}...`);
    try {
      const products = await analyzeFrameBatch(batches[i], i);
      allProducts.push(...products);
      log(`  ${products.length} products (${allProducts.length} total)`);
      if (i < batches.length-1) await new Promise(r => setTimeout(r, 2000));
    } catch(e) { logError(`Batch ${i+1} failed: ${e.message}`); }
  }
  const unique = deduplicateProducts(allProducts);
  log(`Unique products: ${unique.length}`);
  unique.sort((a,b) => (a.category||'').localeCompare(b.category||'') || (a.brand||'').localeCompare(b.brand||''));
  const results = saveResults(unique);
  await uploadToPortal(results);
  const byCategory = {};
  unique.forEach(p => { byCategory[p.category||'Unknown'] = (byCategory[p.category||'Unknown']||0)+1; });
  console.log('\n── SUMMARY ──');
  console.log(`Store: ${storeName} | Products: ${unique.length}`);
  Object.entries(byCategory).sort((a,b)=>b[1]-a[1]).forEach(([c,n]) => console.log(`  ${c}: ${n}`));
  console.log(`\nFiles:\n  ${resultsJson}\n  ${resultsCsv}\n`);
}

main().catch(e => { logError(e.message); process.exit(1); });
