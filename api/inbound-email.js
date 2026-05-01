// api/inbound-email.js
export const config = { api: { bodyParser: false } };

const SB_URL = 'https://mjkjubctswjwjihxjpnd.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1qa2p1YmN0c3dqd2ppaHhqcG5kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczNjQxNjcsImV4cCI6MjA5Mjk0MDE2N30.cZrD_ymrDsRPyfX_g3hUui5_JXuW6BgE77QkIoGpqHo';

async function sb(path, method, body) {
  const r = await fetch(SB_URL + '/rest/v1/' + path, {
    method: method || 'GET',
    headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
    body: body ? JSON.stringify(body) : undefined
  });
  return r.ok ? r.json() : null;
}

async function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
  });
}

function extract(body, field) {
  const re = new RegExp('name="' + field + '"\\r\\n\\r\\n([^\\r]+)');
  const m = body.match(re);
  return m ? m[1].trim() : '';
}

function extractLong(body, field) {
  const re = new RegExp('name="' + field + '"\\r\\n\\r\\n([\\s\\S]+?)(?:\\r\\n--)');
  const m = body.match(re);
  return m ? m[1].trim() : '';
}

function extractEmail(str) {
  const m = (str||'').match(/<([^>]+)>/);
  return m ? m[1] : (str||'').trim();
}

function extractName(str) {
  const m = (str||'').match(/^"?([^"<]+)"?\s*</);
  return m ? m[1].trim() : '';
}

function getDept(toEmail) {
  if (!toEmail) return 'sourcing';
  const addr = toEmail.toLowerCase();
  if (addr.includes('sales')) return 'sales';
  if (addr.includes('accounting')) return 'accounting';
  if (addr.includes('graphics')) return 'graphics';
  if (addr.includes('logistics')) return 'logistics';
  return 'sourcing';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const raw = await readBody(req);
    const contentType = req.headers['content-type'] || '';

    let from = '', to = '', subject = '', text = '';

    if (contentType.includes('application/x-www-form-urlencoded')) {
      const p = new URLSearchParams(raw);
      from = p.get('from') || '';
      to = p.get('to') || '';
      subject = p.get('subject') || '';
      text = p.get('text') || '';
    } else {
      from = extract(raw, 'from');
      to = extract(raw, 'to');
      subject = extract(raw, 'subject');
      text = extractLong(raw, 'text');
    }

    const fromEmail = extractEmail(from);
    const fromName = extractName(from);
    const toEmail = extractEmail(to);
    const dept = getDept(toEmail);
    const cleanSubject = subject.replace(/^(Re:|Fwd:|RE:|FW:)\s*/gi, '').trim();

    let threadId = null;
    const existing = await sb('email_threads?subject=ilike.' + encodeURIComponent(cleanSubject) + '&order=created_at.desc&limit=1');
    if (existing && existing.length) {
      threadId = existing[0].id;
      await sb('email_threads?id=eq.' + threadId, 'PATCH', { status: 'unread', last_message_at: new Date().toISOString() });
    } else {
      const newThread = await sb('email_threads', 'POST', {
        subject, from_email: fromEmail, from_name: fromName,
        to_email: toEmail, direction: 'inbound', status: 'unread', department: dept,
        last_message_at: new Date().toISOString()
      });
      if (newThread && newThread.length) threadId = newThread[0].id;
    }

    if (threadId) {
      await sb('email_messages', 'POST', {
        thread_id: threadId, from_email: fromEmail, from_name: fromName,
        to_email: toEmail, subject, body_text: text,
        direction: 'inbound', is_read: false, sent_at: new Date().toISOString()
      });

      const factory = await sb('factories?sales_email=eq.' + encodeURIComponent(fromEmail) + '&select=id&limit=1');
      if (factory && factory.length) {
        await sb('email_threads?id=eq.' + threadId, 'PATCH', { factory_id: factory[0].id });
      }
    }

    return res.status(200).json({ success: true, threadId });
  } catch (err) {
    console.error('inbound-email error:', err);
    return res.status(200).json({ error: err.message });
  }
}  return m ? m[1].trim().replace(/^"|"$/g, '') : '';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  try {
    const fields = await parseBody(req);
    const fromEmail = extractEmail(fields.from || '');
    const fromName = extractName(fields.from || '');
    const toEmail = extractEmail(fields.to || '');
    const subject = fields.subject || '(no subject)';
    const bodyText = fields.text || '';

    const supabase = createClient(SB_URL, process.env.SUPABASE_SERVICE_KEY || SB_KEY);

    // Find or create thread
    const cleanSubject = subject.replace(/^(Re:|Fwd:|RE:|FW:)\s*/gi, '').trim();
    let threadId = null;
    const { data: thread } = await supabase
      .from('email_threads')
      .select('id')
      .ilike('subject', cleanSubject)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    if (thread) {
      threadId = thread.id;
    } else {
      const { data: newThread } = await supabase
        .from('email_threads')
        .insert({ subject, from_email: fromEmail, from_name: fromName, to_email: toEmail, direction: 'inbound', status: 'unread' })
        .select('id').single();
      if (newThread) threadId = newThread.id;
    }

    if (threadId) {
      await supabase.from('email_messages').insert({
        thread_id: threadId, from_email: fromEmail, from_name: fromName,
        to_email: toEmail, subject, body_text: bodyText, direction: 'inbound', is_read: false
      });
      await supabase.from('email_threads')
        .update({ status: 'unread', last_message_at: new Date().toISOString() })
        .eq('id', threadId);
    }

    // Link to factory
    const { data: factory } = await supabase
      .from('factories').select('id').eq('sales_email', fromEmail).single();
    if (factory && threadId) {
      await supabase.from('email_threads').update({ factory_id: factory.id }).eq('id', threadId);
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(200).json({ error: err.message });
  }
}
