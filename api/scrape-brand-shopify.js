// ════════════════════════════════════════════════════════════════════
// /api/scrape-brand-shopify.js  — v2
//
// Changes from v1:
// - Pagination via Link header (current Shopify method) — gets ALL products
// - Captures every variant as separate row in brand_watch_variants
// - AI-assisted size parsing on variants (Claude batched call)
// - Computes price-per-ml and price-per-g for cross-brand comparison
// - Captures description, options, all images, timestamps, UPC barcodes
// ════════════════════════════════════════════════════════════════════

export const config = { runtime: 'nodejs' };
export const maxDuration = 300;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL = 'claude-sonnet-4-6';

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

async function claudeMessage(messages, maxTokens = 4000) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: maxTokens, messages })
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${await r.text()}`);
  return r.json();
}

function extractJson(text) {
  let cleaned = text.replace(/```json|```/g, '').trim();
  const fb = cleaned.indexOf('{') === -1 ? Infinity : cleaned.indexOf('{');
  const fbA = cleaned.indexOf('[') === -1 ? Infinity : cleaned.indexOf('[');
  const start = Math.min(fb, fbA);
  if (start === Infinity) throw new Error('No JSON');
  cleaned = cleaned.substring(start);
  const lb = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
  if (lb === -1) throw new Error('No closing brace');
  return JSON.parse(cleaned.substring(0, lb + 1));
}

function stripHtml(s) {
  if (!s) return null;
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// ────────────────────────────────────────────────────────────────────
// PAGINATION via Link header (current Shopify method)
// ────────────────────────────────────────────────────────────────────
async function fetchShopifyCatalog(storefrontUrl) {
  const base = storefrontUrl.replace(/\/$/, '');
  const allProducts = [];
  const seenIds = new Set();
  const maxRequests = 20;  // safety: 20 * 250 = 5,000 products max
  let requestCount = 0;

  let nextUrl = `${base}/products.json?limit=250`;
  let usedLinkHeader = false;

  while (nextUrl && requestCount < maxRequests) {
    requestCount++;
    const r = await fetch(nextUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TBGIntelBot/1.0)' }
    });
    if (!r.ok) {
      if (requestCount === 1) throw new Error(`HTTP ${r.status} on ${nextUrl}`);
      break;
    }

    const data = await r.json();
    const products = data.products || [];
    if (products.length === 0) break;

    let newCount = 0;
    for (const p of products) {
      if (!seenIds.has(p.id)) {
        seenIds.add(p.id);
        allProducts.push(p);
        newCount++;
      }
    }

    const linkHeader = r.headers.get('link') || r.headers.get('Link');
    if (linkHeader) {
      usedLinkHeader = true;
      const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      if (nextMatch) {
        nextUrl = nextMatch[1];
        continue;
      } else {
        break;
      }
    }

    if (!usedLinkHeader) {
      if (newCount === 0 || products.length < 250) break;
      const urlObj = new URL(nextUrl);
      const currentPage = parseInt(urlObj.searchParams.get('page') || '1', 10);
      urlObj.searchParams.set('page', String(currentPage + 1));
      nextUrl = urlObj.toString();
    } else {
      break;
    }
  }

  return allProducts;
}

// ────────────────────────────────────────────────────────────────────
// SIZE PARSING
// ────────────────────────────────────────────────────────────────────

const SIZE_REGEX_PATTERNS = [
  { pattern: /(\d+\.?\d*)\s*fl\.?\s*oz/i, unit: 'fl_oz' },
  { pattern: /(\d+\.?\d*)\s*oz\b(?!\s*\/\s*\d)/i, unit: 'oz' },
  { pattern: /(\d+\.?\d*)\s*ml\b/i, unit: 'ml' },
  { pattern: /(\d+\.?\d*)\s*l\b(?!\s*[a-z])/i, unit: 'l' },
  { pattern: /(\d+\.?\d*)\s*g\b(?!\s*[a-z])/i, unit: 'g' },
  { pattern: /(\d+\.?\d*)\s*kg\b/i, unit: 'kg' },
  { pattern: /(\d+\.?\d*)\s*lb\b/i, unit: 'lb' },
  { pattern: /(\d+)\s*(?:ct|count|pack|pieces?|pcs?)\b/i, unit: 'ct' }
];

function parseSize(text) {
  if (!text) return null;
  for (const { pattern, unit } of SIZE_REGEX_PATTERNS) {
    const m = text.match(pattern);
    if (m) {
      return {
        size_text: m[0].trim(),
        size_value: parseFloat(m[1]),
        size_unit: unit
      };
    }
  }
  return null;
}

function convertToMl(value, unit) {
  if (!value || !unit) return null;
  const c = { 'ml': 1, 'l': 1000, 'fl_oz': 29.5735 };
  return c[unit] != null ? value * c[unit] : null;
}

function convertToG(value, unit) {
  if (!value || !unit) return null;
  const c = { 'g': 1, 'kg': 1000, 'lb': 453.592, 'oz': 28.3495 };
  return c[unit] != null ? value * c[unit] : null;
}

async function aiParseUnclear(unclear) {
  if (!unclear.length) return {};
  const prompt = `For each variant below, determine if the title encodes a SIZE/QUANTITY or a SHADE/SCENT/COLOR. Return JSON.

Variants:
${unclear.map((v, i) => `${i}: product="${v.productTitle}" variant_title="${v.variantTitle}" options=[${v.options.filter(Boolean).join('|')}]`).join('\n')}

For each, return EXACTLY this shape indexed by the number:
{
  "0": {"type": "size" | "shade" | "scent" | "other" | "none", "size_text": "extracted size or null", "size_value": numeric or null, "size_unit": "fl_oz|oz|g|ml|l|kg|lb|ct or null", "shade_or_scent": "the shade/scent name or null"},
  "1": {...}
}

Rules:
- type "size": variant differs by physical quantity (e.g. "30ml", "Travel Size", "1.7oz")
- type "shade": cosmetic color/shade
- type "scent": fragrance/flavor
- type "other": something else (e.g. "Refill")
- type "none": title not informative

For type=size, extract numeric value + unit. For shade/scent, put name in shade_or_scent. Use null where N/A. Return ONLY the JSON object.`;

  try {
    const resp = await claudeMessage([{ role: 'user', content: prompt }], 4000);
    return extractJson(resp.content[0].text);
  } catch (err) {
    console.warn(`AI parse failed: ${err.message}`);
    return {};
  }
}

// ────────────────────────────────────────────────────────────────────
// NORMALIZATION
// ────────────────────────────────────────────────────────────────────

function normalizeProduct(sp, brandId, runId) {
  const variants = sp.variants || [];
  const images = sp.images || [];
  const firstImage = images[0] || {};

  const prices = variants.map(v => v.price ? parseFloat(v.price) : null).filter(p => p != null);
  const priceMin = prices.length ? Math.round(Math.min(...prices) * 100) : null;
  const priceMax = prices.length ? Math.round(Math.max(...prices) * 100) : null;
  const firstVariant = variants[0] || {};
  const firstPrice = firstVariant.price ? Math.round(parseFloat(firstVariant.price) * 100) : null;
  const firstCompare = firstVariant.compare_at_price ? Math.round(parseFloat(firstVariant.compare_at_price) * 100) : null;
  const anyInStock = variants.some(v => v.available === true);
  const allInStock = variants.length > 0 && variants.every(v => v.available === true);

  return {
    brand_id: brandId,
    run_id: runId,
    brand_product_id: String(sp.id),
    product_url: sp.handle ? `/products/${sp.handle}` : null,
    handle: sp.handle || null,
    product_title: sp.title || 'Untitled',
    product_type: sp.product_type || null,
    vendor: sp.vendor || null,
    description_html: sp.body_html || null,
    description_text: sp.body_html ? stripHtml(sp.body_html).substring(0, 4000) : null,
    published_at: sp.published_at || null,
    created_at_shopify: sp.created_at || null,
    updated_at_shopify: sp.updated_at || null,
    options: sp.options || null,
    price_current_cents: firstPrice,
    price_compare_cents: firstCompare,
    price_min_cents: priceMin,
    price_max_cents: priceMax,
    currency: 'USD',
    in_stock: anyInStock,
    any_in_stock: anyInStock,
    all_in_stock: allInStock,
    variant_count: variants.length,
    image_url: firstImage.src || null,
    all_image_urls: images.map(i => i.src).filter(Boolean),
    tags: sp.tags ? (Array.isArray(sp.tags) ? sp.tags : String(sp.tags).split(',').map(t => t.trim()).filter(Boolean)) : null
  };
}

function normalizeVariant(sv, sp, productDbId, brandId, runId, sizeInfo) {
  const priceCents = sv.price ? Math.round(parseFloat(sv.price) * 100) : null;
  const compareCents = sv.compare_at_price ? Math.round(parseFloat(sv.compare_at_price) * 100) : null;

  let variantImage = null;
  if (sv.image_id && sp.images) {
    const img = sp.images.find(i => i.id === sv.image_id);
    if (img) variantImage = img.src;
  }

  const weightGrams = sv.grams != null ? sv.grams : (sv.weight && sv.weight_unit
    ? convertToG(sv.weight, sv.weight_unit.toLowerCase().replace(/[^a-z]/g, ''))
    : null);

  let pricePerMl = null, pricePerG = null;
  if (priceCents && sizeInfo) {
    if (sizeInfo.size_value_ml) pricePerMl = priceCents / sizeInfo.size_value_ml;
    if (sizeInfo.size_value_g) pricePerG = priceCents / sizeInfo.size_value_g;
  }

  return {
    product_id: productDbId,
    brand_id: brandId,
    run_id: runId,
    shopify_variant_id: String(sv.id),
    shopify_product_id: String(sp.id),
    sku: sv.sku || null,
    barcode: sv.barcode || null,
    variant_title: sv.title || null,
    option1: sv.option1 || null,
    option2: sv.option2 || null,
    option3: sv.option3 || null,
    size_text: sizeInfo ? sizeInfo.size_text : null,
    size_value: sizeInfo ? sizeInfo.size_value : null,
    size_unit: sizeInfo ? sizeInfo.size_unit : null,
    size_value_ml: sizeInfo ? sizeInfo.size_value_ml : null,
    size_value_g: sizeInfo ? sizeInfo.size_value_g : null,
    shade_or_scent: sizeInfo ? sizeInfo.shade_or_scent : null,
    price_current_cents: priceCents,
    price_compare_cents: compareCents,
    currency: 'USD',
    price_per_ml_cents: pricePerMl,
    price_per_g_cents: pricePerG,
    in_stock: sv.available === true,
    requires_shipping: sv.requires_shipping !== false,
    taxable: sv.taxable !== false,
    weight_grams: weightGrams,
    variant_image_url: variantImage,
    raw_payload: sv
  };
}

async function resolveAllSizes(allVariantsWithProducts) {
  const sizeMap = new Map();
  const unclear = [];

  for (const { variant, productTitle } of allVariantsWithProducts) {
    const candidates = [variant.title, variant.option1, variant.option2, variant.option3].filter(Boolean);
    let parsed = null;
    for (const candidate of candidates) {
      if (candidate === 'Default Title') continue;
      parsed = parseSize(candidate);
      if (parsed) break;
    }

    if (parsed) {
      let sizeMl = null, sizeG = null;
      if (['ml', 'l', 'fl_oz'].includes(parsed.size_unit)) sizeMl = convertToMl(parsed.size_value, parsed.size_unit);
      if (['g', 'kg', 'lb'].includes(parsed.size_unit)) sizeG = convertToG(parsed.size_value, parsed.size_unit);
      sizeMap.set(String(variant.id), {
        size_text: parsed.size_text, size_value: parsed.size_value, size_unit: parsed.size_unit,
        size_value_ml: sizeMl, size_value_g: sizeG, shade_or_scent: null
      });
    } else if (variant.title && variant.title !== 'Default Title') {
      unclear.push({
        variantId: String(variant.id),
        variantTitle: variant.title,
        productTitle,
        options: [variant.option1, variant.option2, variant.option3]
      });
    } else {
      sizeMap.set(String(variant.id), null);
    }
  }

  const BATCH = 30;
  for (let i = 0; i < unclear.length; i += BATCH) {
    const batch = unclear.slice(i, i + BATCH);
    const result = await aiParseUnclear(batch);
    batch.forEach((v, idx) => {
      const r = result[String(idx)] || {};
      if (r.type === 'size' && r.size_value) {
        const unit = (r.size_unit || '').toLowerCase().replace(/[^a-z_]/g, '');
        let sizeMl = null, sizeG = null;
        if (['ml', 'l', 'fl_oz'].includes(unit)) sizeMl = convertToMl(r.size_value, unit);
        if (['g', 'kg', 'lb'].includes(unit)) sizeG = convertToG(r.size_value, unit);
        sizeMap.set(v.variantId, {
          size_text: r.size_text || null, size_value: r.size_value, size_unit: unit || null,
          size_value_ml: sizeMl, size_value_g: sizeG, shade_or_scent: null
        });
      } else if (['shade', 'scent', 'other'].includes(r.type)) {
        sizeMap.set(v.variantId, {
          size_text: null, size_value: null, size_unit: null,
          size_value_ml: null, size_value_g: null,
          shade_or_scent: r.shade_or_scent || v.variantTitle
        });
      } else {
        sizeMap.set(v.variantId, null);
      }
    });
  }

  return sizeMap;
}

// ════════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ════════════════════════════════════════════════════════════════════

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Missing SUPABASE env vars' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const { brand_id } = body || {};
  if (!brand_id) return res.status(400).json({ error: 'brand_id required' });

  let runId = null;

  try {
    const brands = await sb(`/rest/v1/brand_watch_brands?id=eq.${brand_id}&select=*`);
    if (!brands || brands.length === 0) return res.status(404).json({ error: 'Brand not found' });
    const brand = brands[0];

    if (brand.platform !== 'shopify') {
      return res.status(400).json({ error: `Brand platform is ${brand.platform}, this endpoint only handles shopify.` });
    }

    const runRows = await sb('/rest/v1/brand_watch_runs', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ brand_id, status: 'running', trigger_type: 'manual' })
    });
    runId = runRows[0].id;

    const shopifyProducts = await fetchShopifyCatalog(brand.storefront_url);

    if (shopifyProducts.length === 0) {
      await sb(`/rest/v1/brand_watch_runs?id=eq.${runId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: 'partial', completed_at: new Date().toISOString(),
          products_discovered: 0, error_message: 'No products returned'
        })
      });
      return res.status(200).json({ success: true, products_discovered: 0, variants_discovered: 0, brand: brand.name });
    }

    const allVariantsWithProducts = [];
    shopifyProducts.forEach(sp => {
      (sp.variants || []).forEach(v => {
        allVariantsWithProducts.push({ variant: v, productTitle: sp.title });
      });
    });
    console.log(`[scrape-brand-shopify] ${shopifyProducts.length} products, ${allVariantsWithProducts.length} variants. Resolving sizes...`);
    const sizeMap = await resolveAllSizes(allVariantsWithProducts);

    const productRows = shopifyProducts.map(p => normalizeProduct(p, brand_id, runId));
    let insertedProducts = [];
    const productChunk = 50;
    for (let i = 0; i < productRows.length; i += productChunk) {
      const chunk = productRows.slice(i, i + productChunk);
      const inserted = await sb('/rest/v1/brand_watch_products', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(chunk)
      });
      if (inserted) insertedProducts = insertedProducts.concat(inserted);
    }

    const productIdMap = new Map();
    insertedProducts.forEach(p => productIdMap.set(p.brand_product_id, p.id));

    const variantRows = [];
    shopifyProducts.forEach(sp => {
      const dbProductId = productIdMap.get(String(sp.id));
      if (!dbProductId) return;
      (sp.variants || []).forEach(v => {
        const sizeInfo = sizeMap.get(String(v.id)) || null;
        variantRows.push(normalizeVariant(v, sp, dbProductId, brand_id, runId, sizeInfo));
      });
    });

    const variantChunk = 100;
    for (let i = 0; i < variantRows.length; i += variantChunk) {
      await sb('/rest/v1/brand_watch_variants', {
        method: 'POST',
        body: JSON.stringify(variantRows.slice(i, i + variantChunk))
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
      variants_discovered: variantRows.length,
      run_id: runId
    });

  } catch (err) {
    console.error('scrape-brand-shopify error:', err);
    if (runId) {
      try {
        await sb(`/rest/v1/brand_watch_runs?id=eq.${runId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            status: 'failed', completed_at: new Date().toISOString(),
            error_message: err.message.substring(0, 500)
          })
        });
      } catch {}
    }
    return res.status(500).json({ error: err.message });
  }
}
