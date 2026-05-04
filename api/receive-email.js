// api/receive-email.js
// SendGrid Inbound Parse webhook — receives incoming emails and saves to Supabase

export const config = {
  api: {
    bodyParser: false, // Must be disabled for multipart/form-data
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const SB = 'https://mjkjubctswjwjihxjpnd.supabase.co';
  const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1qa2p1YmN0c3dqd2ppaHhqcG5kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczNjQxNjcsImV4cCI6MjA5Mjk0MDE2N30.cZrD_ymrDsRPyfX_g3hUui5_JXuW6BgE77QkIoGpqHo';

  const DEPT_EMAILS = {
    'sourcing@tbgsourcing.net': 'sourcing',
    'sales@tbgsourcing.net': 'sales',
    'accounting@tbgsourcing.net': 'accounting',
    'graphics@tbgsourcing.net': 'graphics',
    'logistics@tbgsourcing.net': 'logistics'
  };

  try {
    // Parse multipart form data manually
    const body = await parseMultipart(req);

    const fromRaw = body.from || '';
    const toRaw = body.to || '';
    const fromEmail = extractEmail(fromRaw);
    const fromName = extractName(fromRaw);
    const toEmail = extractEmail(toRaw).toLowerCase();
    const subject = body.subject || '(No Subject)';
    const textBody = body.text || body.html || '';
    const headersRaw = body.headers || '';
    const messageId = extractHeader(headersRaw, 'Message-ID');
    const inReplyTo = extractHeader(headersRaw, 'In-Reply-To');
    const now = new Date().toISOString();

    const headers = {
      'apikey': KEY,
      'Authorization': 'Bearer ' + KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    };

    // Try to find existing thread
    let threadId = null;

    if (inReplyTo) {
      const r = await fetch(
        SB + '/rest/v1/email_threads?message_id=eq.' + encodeURIComponent(inReplyTo.trim()),
        { headers }
      );
      const rows = await r.json();
      if (rows && rows.length > 0) threadId = rows[0].id;
    }

    if (!threadId) {
      const cleanSubject = subject.replace(/^(Re:|Fwd:|RE:|FW:)\s*/gi, '').trim();
      const r = await fetch(
        SB + '/rest/v1/email_threads?subject=ilike.*' + encodeURIComponent(cleanSubject) + '*&to_email=eq.' + encodeURIComponent(toEmail) + '&order=created_at.desc&limit=1',
        { headers }
      );
      const rows = await r.json();
      if (rows && rows.length > 0) threadId = rows[0].id;
    }

    if (!threadId) {
      // Create new thread
      const r = await fetch(SB + '/rest/v1/email_threads', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          subject,
          from_email: fromEmail,
          from_name: fromName,
          to_email: toEmail,
          direction: 'inbound',
          status: 'unread',
          last_message_at: now,
          message_id: messageId || null
        })
      });
      const rows = await r.json();
      if (rows && rows[0]) threadId = rows[0].id;
    } else {
      // Update existing thread
      await fetch(SB + '/rest/v1/email_threads?id=eq.' + threadId, {
        method: 'PATCH',
        headers: { ...headers, 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          status: 'unread',
          last_message_at: now,
          from_email: fromEmail,
          from_name: fromName,
          direction: 'inbound'
        })
      });
    }

    if (!threadId) {
      return res.status(500).json({ error: 'Could not create thread' });
    }

    // Save message
    await fetch(SB + '/rest/v1/email_messages', {
      method: 'POST',
      headers: { ...headers, 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        thread_id: threadId,
        from_email: fromEmail,
        from_name: fromName,
        to_email: toEmail,
        subject,
        body_text: cleanEmailBody(textBody),
        direction: 'inbound',
        is_read: false,
        sent_at: now,
        message_id: messageId || null
      })
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('receive-email error:', err);
    // Always return 200 to SendGrid so it doesn't retry endlessly
    return res.status(200).json({ error: err.message });
  }
}

// Parse multipart/form-data from raw request
async function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk.toString(); });
    req.on('end', () => {
      try {
        const contentType = req.headers['content-type'] || '';
        const boundary = contentType.split('boundary=')[1];
        if (!boundary) {
          // Try to parse as URL encoded
          const params = {};
          data.split('&').forEach(pair => {
            const [k, v] = pair.split('=');
            if (k) params[decodeURIComponent(k)] = decodeURIComponent((v || '').replace(/\+/g, ' '));
          });
          return resolve(params);
        }
        const parts = data.split('--' + boundary);
        const result = {};
        parts.forEach(part => {
          const match = part.match(/Content-Disposition: form-data; name="([^"]+)"[\r\n]+([\s\S]*)/i);
          if (match) {
            result[match[1]] = match[2].trim();
          }
        });
        resolve(result);
      } catch(e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function extractEmail(str) {
  if (!str) return '';
  const match = str.match(/<([^>]+)>/);
  return match ? match[1].toLowerCase().trim() : str.toLowerCase().trim();
}

function extractName(str) {
  if (!str) return '';
  const match = str.match(/^([^<]+)</);
  return match ? match[1].trim().replace(/"/g, '') : '';
}

function extractHeader(headersStr, headerName) {
  if (!headersStr) return null;
  const regex = new RegExp(headerName + ':\\s*(.+)', 'i');
  const match = headersStr.match(regex);
  return match ? match[1].trim() : null;
}

function cleanEmailBody(text) {
  if (!text) return '';
  const lines = text.split('\n');
  const cleaned = [];
  let quoteCount = 0;
  for (const line of lines) {
    if (line.startsWith('>')) {
      quoteCount++;
      if (quoteCount <= 3) cleaned.push(line);
    } else {
      quoteCount = 0;
      cleaned.push(line);
    }
  }
  return cleaned.join('\n').trim().substring(0, 10000);
}
