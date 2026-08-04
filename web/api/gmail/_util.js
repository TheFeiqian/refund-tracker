// Shared helpers for the Gmail OAuth + send endpoints.
// Vercel ignores files/folders prefixed with "_", so this is NOT itself a route.
//
// Required environment variables (set in Vercel → Project → Settings → Environment Variables):
//   GOOGLE_CLIENT_ID           – OAuth client ID (Google Cloud → Credentials)
//   GOOGLE_CLIENT_SECRET       – OAuth client secret
//   SUPABASE_URL               – e.g. https://xxxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY  – Supabase service_role key (server-only; bypasses RLS)

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

function env(k) { return process.env[k] || ''; }

function baseUrl(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return proto + '://' + host;
}
function redirectUri(req) { return baseUrl(req) + '/api/gmail/callback'; }

async function sbFetch(path, opts) {
  const url = env('SUPABASE_URL') + '/rest/v1/' + path;
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  const headers = Object.assign(
    { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    (opts && opts.headers) || {}
  );
  return fetch(url, Object.assign({}, opts, { headers }));
}

// Store (upsert) a connected account's refresh token.
async function saveToken(email, refresh_token) {
  await sbFetch('gmail_accounts', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ email, refresh_token, updated_at: new Date().toISOString() }),
  });
}
async function getToken(email) {
  const r = await sbFetch('gmail_accounts?email=eq.' + encodeURIComponent(email) + '&select=refresh_token', { method: 'GET' });
  const rows = await r.json().catch(() => []);
  return (rows && rows[0] && rows[0].refresh_token) || '';
}
async function listAccounts() {
  const r = await sbFetch('gmail_accounts?select=email&order=email.asc', { method: 'GET' });
  const rows = await r.json().catch(() => []);
  return (rows || []).map(x => x.email);
}
async function deleteAccount(email) {
  await sbFetch('gmail_accounts?email=eq.' + encodeURIComponent(email), { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
}

// Exchange a stored refresh token for a short-lived access token.
async function accessFromRefresh(refresh_token) {
  const body = new URLSearchParams({
    client_id: env('GOOGLE_CLIENT_ID'),
    client_secret: env('GOOGLE_CLIENT_SECRET'),
    refresh_token,
    grant_type: 'refresh_token',
  });
  const r = await fetch(GOOGLE_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const d = await r.json();
  if (!r.ok) throw new Error((d && (d.error_description || d.error)) || 'token refresh failed');
  return d.access_token;
}

// Pull the account's email out of the OpenID id_token (no extra API call needed).
function decodeJwtEmail(id_token) {
  try {
    const p = String(id_token).split('.')[1];
    const j = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return j.email || '';
  } catch (e) { return ''; }
}

// ============================================================
// Gmail read (users.threads / users.messages). Access token obtained via accessFromRefresh().
// ============================================================
async function gmailGet(access, path) {
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/' + path, {
    headers: { Authorization: 'Bearer ' + access },
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d && d.error && d.error.message) || ('Gmail API ' + r.status));
  return d;
}
// Decode a Gmail message payload into { from, to, subject, date, body, snippet }.
function headerVal(headers, name) {
  const h = (headers || []).find(x => (x.name || '').toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}
function b64urlDecode(s) {
  try { return Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); }
  catch (e) { return ''; }
}
// Walk the MIME tree and pull the best text (prefer text/plain, fall back to stripped text/html).
function extractBody(payload) {
  if (!payload) return '';
  let plain = '', html = '';
  (function walk(p) {
    if (!p) return;
    const mt = p.mimeType || '';
    if (p.body && p.body.data) {
      if (mt === 'text/plain') plain += b64urlDecode(p.body.data);
      else if (mt === 'text/html') html += b64urlDecode(p.body.data);
    }
    (p.parts || []).forEach(walk);
  })(payload);
  if (plain.trim()) return plain.trim();
  if (html.trim()) return html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
  return '';
}
function parseGmailMessage(m) {
  const payload = m.payload || {};
  const headers = payload.headers || [];
  const from = headerVal(headers, 'From');
  const to = headerVal(headers, 'To');
  const subject = headerVal(headers, 'Subject');
  const msgIdHeader = headerVal(headers, 'Message-ID') || headerVal(headers, 'Message-Id');
  const refs = headerVal(headers, 'References');
  return {
    gmail_message_id: m.id,
    gmail_thread_id: m.threadId,
    from_addr: from,
    to_addr: to,
    subject,
    snippet: m.snippet || '',
    body: extractBody(payload),
    internal_ts: parseInt(m.internalDate, 10) || 0,
    rfc_message_id: msgIdHeader,
    rfc_references: refs,
    label_ids: m.labelIds || [],
  };
}

// ============================================================
// Supabase tables: email_messages, kb_scenarios, orders (read).
// ============================================================
async function messageExists(gmailMessageId) {
  const r = await sbFetch('email_messages?gmail_message_id=eq.' + encodeURIComponent(gmailMessageId) + '&select=id', { method: 'GET' });
  const rows = await r.json().catch(() => []);
  return !!(rows && rows[0]);
}
async function saveMessage(row) {
  const r = await sbFetch('email_messages?on_conflict=gmail_message_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(row),
  });
  const rows = await r.json().catch(() => []);
  return (rows && rows[0]) || null;
}
async function getMessages(orderId) {
  const r = await sbFetch('email_messages?order_id=eq.' + encodeURIComponent(orderId) + '&select=*&order=internal_ts.asc', { method: 'GET' });
  return (await r.json().catch(() => [])) || [];
}
async function updateMessage(id, patch) {
  await sbFetch('email_messages?id=eq.' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
}
async function listKb() {
  const r = await sbFetch('kb_scenarios?select=*&order=learned_at.desc', { method: 'GET' });
  return (await r.json().catch(() => [])) || [];
}
async function addKb(row) {
  const r = await sbFetch('kb_scenarios', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });
  const rows = await r.json().catch(() => []);
  return (rows && rows[0]) || null;
}
// Orders that have a linked Gmail thread (for the cron self-discovery path).
async function listTrackedOrders() {
  const r = await sbFetch('orders?select=order_id,data', { method: 'GET' });
  const rows = (await r.json().catch(() => [])) || [];
  return rows
    .map(x => ({ order_id: x.order_id, data: x.data || {} }))
    .filter(x => x.data && x.data.gmail_thread_id && x.data.gmail_account);
}

// Minimal Anthropic text call (server-side; reuses the same ANTHROPIC_API_KEY as /api/ai).
const AI_MODEL = 'claude-haiku-4-5-20251001';
async function anthropicText({ system, userText, maxTokens }) {
  const apiKey = env('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set on the server');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: AI_MODEL, max_tokens: maxTokens || 1024, system: system || undefined, messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }] }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error((d && d.error && d.error.message) || ('Anthropic ' + r.status));
  return (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
}
function jsonFrom(text) {
  if (!text) return null;
  const c = String(text).replace(/```json/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(c); } catch (e) {}
  const m = c.match(/[\[{][\s\S]*[\]}]/);
  if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
  return null;
}

module.exports = {
  env, baseUrl, redirectUri, sbFetch,
  saveToken, getToken, listAccounts, deleteAccount, accessFromRefresh, decodeJwtEmail,
  gmailGet, parseGmailMessage, headerVal,
  messageExists, saveMessage, getMessages, updateMessage, listKb, addKb, listTrackedOrders,
  anthropicText, jsonFrom,
};
