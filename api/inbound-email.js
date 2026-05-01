{ createClient } from '@supabase/supabase-js';

const SB_URL = 'https://mjkjubctswjwjihxjpnd.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1qa2p1YmN0c3dqd2ppaHhqcG5kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczNjQxNjcsImV4cCI6MjA5Mjk0MDE2N30.cZrD_ymrDsRPyfX_g3hUui5_JXuW6BgE77QkIoGpqHo';

export const config = { api: { bodyParser: false } };

async function parseBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      const fields = {};
      const fromMatch = body.match(/name="from"\r\n\r\n([^\r\n]+)/);
      const toMatch = body.match(/name="to"\r\n\r\n([^\r\n]+)/);
      const subjectMatch = body.match(/name="subject"\r\n\r\n([^\r\n]+)/);
      const textMatch = body.match(/name="text"\r\n\r\n([\s\S]+?)(?:\r\n--)/);
      const headersMatch = body.match(/name="headers"\r\n\r\n([\s\S]+?)(?:\r\n--)/);
      if (fromMatch) fields.from = fromMatch[1].trim();
      if (toMatch) fields.to = toMatch[1].trim();
      if (subjectMatch) fields.subject = subjectMatch[1].trim();
      if (textMatch) fields.text = textMatch[1].trim();
      if (headersMatch) fields.headers = headersMatch[1].trim();
      resolve(fields);
    });
  });
}

function extractEmail(str) {
  const m = str.match(/<([^>]+)>/);
  return m ? m[1] : str.trim();
}

function extractName(str) {
  const m = str.match(/^([^<]+)</);
  return m ? m[1].trim().replace(/^"|"$/g, '') : '';
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
