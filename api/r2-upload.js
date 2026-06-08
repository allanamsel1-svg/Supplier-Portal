// api/r2-upload.js
// Upload a file to Cloudflare R2 via the S3-compatible API, signed with AWS SigV4.
//   POST  body = raw binary, with ?folder=&filename=&contentType=   (simplest)
//     or  body = multipart/form-data with fields: file, filename, folder, contentType
//   Auth: Bearer <tenant session | admin session>
//   → { success:true, url } | { error:true, message }
//
// Env: CF_R2_ACCESS_KEY_ID, CF_R2_SECRET_ACCESS_KEY, CF_ACCOUNT_ID, CF_R2_BUCKET
//
// NOTE: the returned URL is the S3 endpoint URL and is NOT publicly accessible until a public
// dev URL / custom domain is configured on the bucket (e.g. the tbg-artwork bucket — enable
// "Public Development URL" in the Cloudflare R2 dashboard, then swap the public base below).
// SigV4 implemented from scratch with Node's built-in crypto only (no aws-sdk).
export const config = { runtime: 'nodejs' };

import { createHmac, createHash, timingSafeEqual } from 'crypto';

const SB_URL = process.env.SUPABASE_URL || 'https://mjkjubctswjwjihxjpnd.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const H = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' };

const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_R2_BUCKET = process.env.CF_R2_BUCKET;
const CF_R2_ACCESS_KEY_ID = process.env.CF_R2_ACCESS_KEY_ID;
const CF_R2_SECRET_ACCESS_KEY = process.env.CF_R2_SECRET_ACCESS_KEY;

// ── AWS SigV4 (crypto-only) ──
function hmac(key, data) { return createHmac('sha256', key).update(data).digest(); }
function sha256(data) { return createHash('sha256').update(data).digest('hex'); }
function getSigningKey(secret, date, region, service) {
  const kDate = hmac('AWS4' + secret, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}
function signRequest({ method, host, path, headers, body, accessKeyId, secretKey, region, service }) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:\-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256(body || '');
  const allHeaders = Object.assign({}, headers, {
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    'host': host,
  });
  const sortedKeys = Object.keys(allHeaders).sort();
  const canonicalHeaders = sortedKeys.map(k => k.toLowerCase() + ':' + String(allHeaders[k]).trim()).join('\n') + '\n';
  const signedHeaders = sortedKeys.map(k => k.toLowerCase()).join(';');
  const canonicalRequest = [method, path, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope = [dateStamp, region, service, 'aws4_request'].join('/');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256(canonicalRequest)].join('\n');
  const signingKey = getSigningKey(secretKey, dateStamp, region, service);
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  const authHeader = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return Object.assign({}, allHeaders, { Authorization: authHeader });
}
// RFC3986 encoding for a single path segment (does not encode '/').
function uriEncodeSegment(s) {
  return encodeURIComponent(s).replace(/[!*'()]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// ── Session auth (unchanged) ──
function verifyAdminToken(token) {
  const key = String(process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASSWORD || '').trim();
  if (!key || !token || typeof token !== 'string' || token.indexOf('.') === -1) return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  const expected = createHmac('sha256', key).update(payload).digest('base64url');
  if (sig.length !== expected.length) return false;
  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return !obj.exp || Date.now() < obj.exp;
  } catch { return false; }
}
async function isAuthed(token) {
  if (!token) return false;
  if (verifyAdminToken(token)) return true;
  try {
    const r = await fetch(SB_URL + '/rest/v1/tenant_sessions?select=expires_at&token=eq.' + encodeURIComponent(token) + '&limit=1', { headers: H });
    const arr = r.ok ? await r.json() : [];
    const s = Array.isArray(arr) ? arr[0] : null;
    return !!(s && new Date(s.expires_at) >= new Date());
  } catch { return false; }
}
async function readRaw(req) {
  const chunks = [];
  await new Promise((resolve) => { req.on('data', c => chunks.push(typeof c === 'string' ? Buffer.from(c) : c)); req.on('end', resolve); req.on('error', resolve); });
  return Buffer.concat(chunks);
}
// Minimal multipart/form-data parser (unchanged) → { file:Buffer, filename, contentType, fields:{} }
function parseMultipart(buf, boundary) {
  const delim = Buffer.from('--' + boundary);
  let start = buf.indexOf(delim);
  if (start < 0) return null;
  start += delim.length;
  const parts = [];
  while (start < buf.length) {
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break;
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;
    const next = buf.indexOf(delim, start);
    if (next < 0) break;
    let part = buf.slice(start, next);
    if (part.length >= 2 && part[part.length - 2] === 0x0d && part[part.length - 1] === 0x0a) part = part.slice(0, part.length - 2);
    parts.push(part);
    start = next + delim.length;
  }
  const out = { file: null, filename: '', contentType: '', fields: {} };
  const sep = Buffer.from('\r\n\r\n');
  parts.forEach(p => {
    const he = p.indexOf(sep);
    if (he < 0) return;
    const header = p.slice(0, he).toString('utf8');
    const body = p.slice(he + 4);
    const nameM = header.match(/name="([^"]*)"/i);
    const fnM = header.match(/filename="([^"]*)"/i);
    const ctM = header.match(/Content-Type:\s*([^\r\n]+)/i);
    const name = nameM ? nameM[1] : '';
    if (fnM && fnM[1]) { out.file = body; out.filename = fnM[1]; out.contentType = ctM ? ctM[1].trim() : ''; }
    else if (name === 'file') { out.file = body; }
    else if (name) { out.fields[name] = body.toString('utf8'); }
  });
  return out;
}
function query(req) {
  try { return Object.fromEntries(new URL(req.url, 'http://x').searchParams); } catch { return {}; }
}
function clean(s) { return String(s || '').replace(/^\/+|\/+$/g, '').replace(/\.\.+/g, ''); }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: true, message: 'Method not allowed' });

  try {
    const token = (req.headers.authorization || req.headers.Authorization || '').replace('Bearer ', '').trim();
    if (!(await isAuthed(token))) return res.status(401).json({ error: true, message: 'Unauthorized' });
    if (!CF_ACCOUNT_ID || !CF_R2_BUCKET || !CF_R2_ACCESS_KEY_ID || !CF_R2_SECRET_ACCESS_KEY) {
      return res.status(200).json({ error: true, message: 'R2 is not configured (missing CF_ACCOUNT_ID / CF_R2_BUCKET / CF_R2_ACCESS_KEY_ID / CF_R2_SECRET_ACCESS_KEY).' });
    }

    const q = query(req);
    const ct = (req.headers['content-type'] || '');
    const raw = await readRaw(req);

    let fileBuf = null, filename = q.filename || '', folder = q.folder || '', contentType = q.contentType || q.content_type || '';
    if (ct.indexOf('multipart/form-data') !== -1) {
      const m = ct.match(/boundary=(.+)$/);
      const boundary = m ? m[1].trim().replace(/^"|"$/g, '') : '';
      const parsed = boundary ? parseMultipart(raw, boundary) : null;
      if (parsed) {
        fileBuf = parsed.file;
        filename = parsed.fields.filename || parsed.filename || filename;
        folder = parsed.fields.folder || folder;
        contentType = parsed.fields.contentType || parsed.contentType || contentType;
      }
    } else {
      fileBuf = raw;
      if (!contentType) contentType = ct || '';
    }

    if (!fileBuf || !fileBuf.length) return res.status(200).json({ error: true, message: 'No file data received' });
    if (!filename) filename = 'upload-' + Date.now();
    if (!contentType) contentType = 'application/octet-stream';

    const keyParts = [clean(folder), clean(filename)].filter(Boolean);
    const key = keyParts.join('/');                                            // <folder>/<filename>
    const host = CF_ACCOUNT_ID + '.r2.cloudflarestorage.com';
    // Canonical (signed) path is path-style + RFC3986-encoded segments.
    const canonicalPath = '/' + [CF_R2_BUCKET].concat(key.split('/')).map(uriEncodeSegment).join('/');

    const signed = signRequest({
      method: 'PUT', host, path: canonicalPath,
      headers: { 'content-type': contentType },
      body: fileBuf,
      accessKeyId: CF_R2_ACCESS_KEY_ID, secretKey: CF_R2_SECRET_ACCESS_KEY,
      region: 'auto', service: 's3',
    });
    const sendHeaders = Object.assign({}, signed);
    delete sendHeaders.host;   // let fetch set Host from the URL (matches the signed value)

    let r;
    try {
      r = await fetch('https://' + host + canonicalPath, { method: 'PUT', headers: sendHeaders, body: fileBuf });
    } catch (e) {
      return res.status(200).json({ error: true, message: 'R2 request failed: ' + (e && e.message ? e.message : e) });
    }
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return res.status(200).json({ error: true, message: 'R2 upload failed: ' + r.status + ' ' + t });
    }
    // Prefer the bucket's public dev URL / custom domain; fall back to the (non-public) S3 endpoint URL.
    const pub = (process.env.CF_R2_PUBLIC_URL || '').replace(/\/+$/, '');
    const url = pub ? (pub + '/' + key) : ('https://' + host + '/' + CF_R2_BUCKET + '/' + key);
    return res.status(200).json({ success: true, url });
  } catch (e) {
    return res.status(200).json({ error: true, message: 'Upload failed: ' + (e && e.message ? e.message : e) });
  }
}
