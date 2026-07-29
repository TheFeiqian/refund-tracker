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

module.exports = { env, baseUrl, redirectUri, saveToken, getToken, listAccounts, deleteAccount, accessFromRefresh, decodeJwtEmail };
