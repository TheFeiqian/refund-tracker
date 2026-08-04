// Send an email AS a connected Gmail account.
// POST { from, to, cc?, subject, body, attachmentUrls?:[{url,name,type}] }
//   from  – must be a connected account (its refresh token is looked up server-side)
//   body  – plain text
// Attachments are fetched server-side from their (signed) URLs and MIME-attached.
const { getToken, accessFromRefresh, saveMessage } = require('./_util');

function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function wrap76(s) { return s.replace(/(.{76})/g, '$1\r\n'); }
function encHeader(s) { return String(s == null ? '' : s).replace(/[\r\n]+/g, ' '); }

function buildMime({ from, to, cc, subject, body, attachments, inReplyTo, references }) {
  const nl = '\r\n';
  const head = [];
  head.push('From: ' + encHeader(from));
  head.push('To: ' + encHeader(to));
  if (cc) head.push('Cc: ' + encHeader(cc));
  head.push('Subject: ' + encHeader(subject));
  // Reply threading headers — keep the retailer conversation as one continuous Gmail thread.
  if (inReplyTo) head.push('In-Reply-To: ' + encHeader(inReplyTo));
  if (references) head.push('References: ' + encHeader(references));
  head.push('MIME-Version: 1.0');
  if (attachments && attachments.length) {
    const boundary = 'b_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    head.push('Content-Type: multipart/mixed; boundary="' + boundary + '"');
    const parts = [];
    parts.push('--' + boundary);
    parts.push('Content-Type: text/plain; charset="UTF-8"');
    parts.push('Content-Transfer-Encoding: 7bit');
    parts.push('');
    parts.push(String(body || ''));
    for (const a of attachments) {
      parts.push('--' + boundary);
      parts.push('Content-Type: ' + (a.type || 'application/octet-stream') + '; name="' + a.name + '"');
      parts.push('Content-Transfer-Encoding: base64');
      parts.push('Content-Disposition: attachment; filename="' + a.name + '"');
      parts.push('');
      parts.push(wrap76(a.data));
    }
    parts.push('--' + boundary + '--');
    return head.join(nl) + nl + nl + parts.join(nl);
  }
  head.push('Content-Type: text/plain; charset="UTF-8"');
  return head.join(nl) + nl + nl + String(body || '');
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  let payload = req.body;
  if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (e) { payload = {}; } }
  payload = payload || {};
  const { from, to, cc, subject, body, attachmentUrls, threadId, inReplyTo, references, orderId } = payload;
  if (!from || !to) return res.status(400).json({ error: 'from and to are required' });

  try {
    const refresh = await getToken(from);
    if (!refresh) return res.status(400).json({ error: 'The account ' + from + ' is not connected. Open Email accounts and connect it first.' });
    const access = await accessFromRefresh(refresh);

    // Fetch attachments server-side (cap count + size so a big label can't blow the function).
    const attachments = [];
    for (const a of (attachmentUrls || []).slice(0, 8)) {
      if (!a || !a.url) continue;
      try {
        const fr = await fetch(a.url);
        if (!fr.ok) continue;
        const buf = Buffer.from(await fr.arrayBuffer());
        if (buf.length > 8 * 1024 * 1024) continue; // skip >8MB
        attachments.push({ name: (a.name || 'file').replace(/["\r\n]/g, ''), type: a.type || fr.headers.get('content-type') || 'application/octet-stream', data: buf.toString('base64') });
      } catch (e) {}
    }

    const mime = buildMime({ from, to, cc, subject, body, attachments, inReplyTo, references });
    const sendBody = { raw: b64url(mime) };
    if (threadId) sendBody.threadId = threadId; // keeps the reply inside the same Gmail thread
    const gr = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + access, 'Content-Type': 'application/json' },
      body: JSON.stringify(sendBody),
    });
    const gd = await gr.json();
    if (!gr.ok) return res.status(502).json({ error: (gd && gd.error && gd.error.message) || 'Gmail send failed' });

    // Record the outbound message on the claim's timeline (best-effort; never fails the send).
    if (orderId) {
      try {
        await saveMessage({
          order_id: orderId,
          gmail_thread_id: gd.threadId || threadId || '',
          gmail_message_id: gd.id,
          direction: 'out',
          from_addr: from,
          to_addr: to,
          subject: subject || '',
          snippet: String(body || '').slice(0, 300),
          body: String(body || ''),
          internal_ts: Date.now(),
          ai_processed: true,
          status: 'replied',
        });
      } catch (e) {}
    }
    return res.status(200).json({ ok: true, id: gd.id, threadId: gd.threadId || threadId || '', attached: attachments.length });
  } catch (e) {
    return res.status(502).json({ error: String((e && e.message) || e) });
  }
};
