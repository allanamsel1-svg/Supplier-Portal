// api/r2-upload.js
// Upload a file to Cloudflare R2.
//   POST  body = raw binary, with ?folder=&filename=&contentType=   (simplest)
//     or  body = multipart/form-data with fields: file, filename, folder, contentType
//   Auth: Bearer <tenant session | admin session>
//   → { success:true, url } | { error:true, message }
//
// NOTE: R2's S3-compatible endpoint normally requires AWS SigV4 signing. This implements
// the requested Bearer-token PUT (CF_R2_TOKEN). If R2 rejects it (401/403 SignatureDoesNotMatch),
// switch to SigV4 with CF_R2_ACCESS_KEY_ID + CF_R2_SECRET_ACCESS_KEY.
export const config = { runtime: 'nodejs' };

import { createHmac, timingSafeEqual } from 'crypto';

const SB_URL = process.env.SUPABASE_URL || 'https://mjkjubctswjwjihxjpnd.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const H = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' };

const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_R2_TOKEN = process.env.CF_R2_TOKEN;
const CF_R2_BUCKET = process.env.CF_R2_BUCKET;

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
// Minimal multipart/form-data parser → { file:Buffer, filename, contentType, fields:{} }
function parseMultipart(buf, boundary) {
  const delim = Buffer.from('--' + boundary);
  let start = buf.indexOf(delim);
  if (start < 0) return null;
  start += delim.length;
  const parts = [];
  while (start < buf.length) {
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break;          // closing "--"
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;     // skip CRLF
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
    if (!CF_ACCOUNT_ID || !CF_R2_TOKEN || !CF_R2_BUCKET) return res.status(200).json({ error: true, message: 'R2 is not configured (missing CF_ACCOUNT_ID / CF_R2_TOKEN / CF_R2_BUCKET).' });

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
      fileBuf = raw;                                  // raw binary body
      if (!contentType) contentType = ct || '';
    }

    if (!fileBuf || !fileBuf.length) return res.status(200).json({ error: true, message: 'No file data received' });
    if (!filename) filename = 'upload-' + Date.now();
    if (!contentType) contentType = 'application/octet-stream';

    const key = [clean(folder), clean(filename)].filter(Boolean).join('/');
    const url = 'https://' + CF_ACCOUNT_ID + '.r2.cloudflarestorage.com/' + CF_R2_BUCKET + '/' + key;

    let r;
    try {
      r = await fetch(url, { method: 'PUT', headers: { Authorization: 'Bearer ' + CF_R2_TOKEN, 'Content-Type': contentType }, body: fileBuf });
    } catch (e) {
      return res.status(200).json({ error: true, message: 'R2 request failed: ' + (e && e.message ? e.message : e) });
    }
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return res.status(200).json({ error: true, message: 'R2 upload failed: ' + r.status + ' ' + t });
    }
    return res.status(200).json({ success: true, url });
  } catch (e) {
    return res.status(200).json({ error: true, message: 'Upload failed: ' + (e && e.message ? e.message : e) });
  }
}
