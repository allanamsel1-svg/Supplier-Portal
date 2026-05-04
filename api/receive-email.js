// api/receive-email.js
// SendGrid Inbound Parse webhook — receives incoming emails and saves to Supabase

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const SB = 'https://mjkjubctswjwjihxjpnd.supabase.co';
  const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1qa2p1YmN0c3dqd2ppaHhqcG5kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczNjQxNjcsImV4cCI6MjA5Mjk0MDE2N30.cZrD_ymrDsRPyfX_g3hUui5_JXuW6BgE77QkIoGpqHo';

  // Department email map
  const DEPT_EMAILS = {
    'sourcing@tbgsourcing.net': 'sourcing',
    'sales@tbgsourcing.net': 'sales',
    'accounting@tbgsourcing.net': 'accounting',
    'graphics@tbgsourcing.net': 'graphics',
    'logistics@tbgsourcing.net': 'logistics'
  };

  try {
    // SendGrid sends form data
    const body = req.body;

    // Extract fields from SendGrid inbound parse
    const fromEmail = extractEmail(body.from || '');
    const fromName = extractName(body.from || '');
    const toEmail = extractEmail(body.to || '').toLowerCase();
    const subject = body.subject || '(No Subject)';
    const textBody = body.text || body.html || '';
    const messageId = body.headers ? extractHeader(body.headers, 'Message-ID') : null;
    const inReplyTo = body.headers ? extractHeader(body.headers, 'In-Reply-To') : null;

    // Determine which department this email is for
    const dept = DEPT_EMAILS[toEmail];
    const now = new Date().toISOString();

    const headers = { 
      'apikey': KEY, 
      'Authorization': 'Bearer ' + KEY, 
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    };

    // Try to find existing thread by In-Reply-To header or subject
    let threadId = null;

    if (inReplyTo) {
      // Look for thread with matching message ID
      const threadR = await fetch(
        SB + '/rest/v1/email_threads?message_id=eq.' + encodeURIComponent(inReplyTo.trim()),
        { headers }
      );
      const threads = await threadR.json();
      if (threads && threads.length > 0) threadId = threads[0].id;
    }

    if (!threadId) {
      // Try to match by subject (strip Re:, Fwd: etc)
      const cleanSubject = subject.replace(/^(Re:|Fwd:|RE:|FW:)\s*/gi, '').trim();
      const threadR = await fetch(
        SB + '/rest/v1/email_threads?subject=ilike.*' + encodeURIComponent(cleanSubject) + '*&to_email=eq.' + encodeURIComponent(toEmail) + '&limit=1',
        { headers }
      );
      const threads = await threadR.json();
      if (threads && threads.length > 0) threadId = threads[0].id;
    }

    if (!threadId) {
      // Create new thread
      const threadR = await fetch(SB + '/rest/v1/email_threads', {
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
      const threads = await threadR.json();
      if (threads && threads[0]) threadId = threads[0].id;
    } else {
      // Update existing thread — mark as unread with latest timestamp
      await fetch(SB + '/rest/v1/email_threads?id=eq.' + threadId, {
        method: 'PATCH',
        headers: { ...headers, 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          status: 'unread',
          last_message_at: now,
          direction: 'inbound'
        })
      });
    }

    if (!threadId) {
      console.error('Could not create or find thread');
      return res.status(500).json({ error: 'Could not create thread' });
    }

    // Save the message
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
    return res.status(500).json({ error: err.message });
  }
}

function extractEmail(str) {
  const match = str.match(/<([^>]+)>/);
  return match ? match[1].toLowerCase() : str.toLowerCase().trim();
}

function extractName(str) {
  const match = str.match(/^([^<]+)</);
  return match ? match[1].trim().replace(/"/g, '') : '';
}

function extractHeader(headersStr, headerName) {
  const regex = new RegExp(headerName + ':\\s*(.+)', 'i');
  const match = headersStr.match(regex);
  return match ? match[1].trim() : null;
}

function cleanEmailBody(text) {
  if (!text) return '';
  // Remove excessive quoted reply chains (keep only the new part)
  const lines = text.split('\n');
  const cleaned = [];
  let quoteDepth = 0;
  for (const line of lines) {
    if (line.startsWith('>')) {
      quoteDepth++;
      if (quoteDepth <= 2) cleaned.push(line); // keep 1-2 levels of quote for context
    } else {
      quoteDepth = 0;
      cleaned.push(line);
    }
  }
  return cleaned.join('\n').trim().substring(0, 10000);
}
