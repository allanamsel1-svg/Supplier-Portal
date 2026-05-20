// ════════════════════════════════════════════════════════════════════
// /api/scrape-brand-shopify.js
//
// Scrapes a Shopify brand's /products.json endpoint and writes
// products to brand_watch_products. Creates a brand_watch_runs row.
//
// POST body: { brand_id: uuid }
// ════════════════════════════════════════════════════════════════════

export const config = { runtime: 'nodejs' };
export const maxDuration = 60;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function sb(path, opts = {}) {
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...(opts.headers || {})
  };
  const r = await fetch(`${SUPABASE_URL}${path}`, { ...opts, headers });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Supabase ${r.status} ${path}: ${body}`);
  }
  if (r.status === 204) return null;
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

async function fetchShopifyCatalog(storefrontUrl) {
  const base = storefrontUrl.replace(/\/$/, '');
  const allProducts = [];
  let page = 1;
  const maxPages = 8;

  while (page <= maxPages) {
    const url = `${base}/products.json?limit=250&page=${page}`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TBGIntelBot/1.0)' }
    });
    if (!r.ok) {
      if (page === 1) throw new Error(`HTTP ${r.status} on ${url}`);
      break;
    }
    const data = await r.json();
    const products = data.products || [];
    if (products.length === 0) break;
    allProducts.push(...products);
    if (products.length < 250) break;
    page++;
  }

  return allProducts;
}

function normalizeProduct(shopifyProduct, brandId, runId) {
  const firstVariant = (shopifyProduct.variants || [])[0] || {};
  const firstImage = (shopifyProduct.images || [])[0] || {};
  const price = firstVariant.price ? Math.round(parseFloat(firstVariant.price) * 100) : null;
  const compareAt = firstVariant.compare_at_price ? Math.round(parseFloat(firstVariant.compare_at_price) * 100) : null;
  const allInStock = (shopifyProduct.variants || []).some(v => v.available === true);

  return {
    brand_id: brandId,
    run_id: runId,
    brand_product_id: String(shopifyProduct.id),
    product_url: shopifyProduct.handle ? `/products/${shopifyProduct.handle}` : null,
    product_title: shopifyProduct.title || 'Untitled',
    product_type: shopifyProduct.product_type || null,
    vendor: shopifyProduct.vendor || null,
    price_current_cents: price,
    price_compare_cents: compareAt,
    currency: 'USD',
    in_stock: allInStock,
    variant_count: (shopifyProduct.variants || []).length,
    image_url: firstImage.src || null,
    tags: shopifyProduct.tags ? (Array.isArray(shopifyProduct.tags) ? shopifyProduct.tags : String(shopifyProduct.tags).split(',').map(t => t.trim()).filter(Boolean)) : null
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Missing SUPABASE env vars' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const { brand_id } = body || {};
  if (!brand_id) return res.status(400).json({ error: 'brand_id required' });

  let runId = null;

  try {
    const brands = await sb(`/rest/v1/brand_watch_brands?id=eq.${brand_id}&select=*`);
    if (!brands || brands.length === 0) return res.status(404).json({ error: 'Brand not found' });
    const brand = brands[0];

    if (brand.platform !== 'shopify') {
      return res.status(400).json({ error: `Brand platform is ${brand.platform}, this endpoint only handles shopify. Use a platform-specific endpoint.` });
    }

    const runRows = await sb('/rest/v1/brand_watch_runs', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        brand_id,
        status: 'running',
        trigger_type: 'manual'
      })
    });
    runId = runRows[0].id;

    const shopifyProducts = await fetchShopifyCatalog(brand.storefront_url);

    if (shopifyProducts.length === 0) {
      await sb(`/rest/v1/brand_watch_runs?id=eq.${runId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: 'partial',
          completed_at: new Date().toISOString(),
          products_discovered: 0,
          error_message: 'No products returned'
        })
      });
      return res.status(200).json({ success: true, products_discovered: 0, brand: brand.name });
    }

    const productRows = shopifyProducts.map(p => normalizeProduct(p, brand_id, runId));

    const chunkSize = 100;
    for (let i = 0; i < productRows.length; i += chunkSize) {
      const chunk = productRows.slice(i, i + chunkSize);
      await sb('/rest/v1/brand_watch_products', {
        method: 'POST',
        body: JSON.stringify(chunk)
      });
    }

    await sb(`/rest/v1/brand_watch_runs?id=eq.${runId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'success',
        completed_at: new Date().toISOString(),
        products_discovered: productRows.length
      })
    });

    return res.status(200).json({
      success: true,
      brand: brand.name,
      products_discovered: productRows.length,
      run_id: runId
    });

  } catch (err) {
    console.error('scrape-brand-shopify error:', err);
    if (runId) {
      try {
        await sb(`/rest/v1/brand_watch_runs?id=eq.${runId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            status: 'failed',
            completed_at: new Date().toISOString(),
            error_message: err.message.substring(0, 500)
          })
        });
      } catch {}
    }
    return res.status(500).json({ error: err.message });
  }
}
