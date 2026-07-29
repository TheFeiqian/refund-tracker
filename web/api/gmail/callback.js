// OAuth redirect target: exchange the code for tokens, store the refresh token keyed by the
// account's email, then bounce back to the app. This exact URL must be registered as an
// "Authorized redirect URI" on the Google OAuth client: https://<your-app>/api/gmail/callback
const { env, baseUrl, redirectUri, saveToken, decodeJwtEmail } = require('./_util');

function back(res, base, params) {
  res.writeHead(302, { Location: base + '/?' + params });
  res.end();
}

module.exports = async (req, res) => {
  const base = baseUrl(req);
  try {
    const url = new URL(req.url, base);
    const err = url.searchParams.get('error');
    if (err) return back(res, base, 'gmail_error=' + encodeURIComponent(err));
    const code = url.searchParams.get('code');
    if (!code) { res.status(400).send('missing code'); return; }

    const body = new URLSearchParams({
      code,
      client_id: env('GOOGLE_CLIENT_ID'),
      client_secret: env('GOOGLE_CLIENT_SECRET'),
      redirect_uri: redirectUri(req),
      grant_type: 'authorization_code',
    });
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    });
    const d = await r.json();
    if (!r.ok) return back(res, base, 'gmail_error=' + encodeURIComponent((d && (d.error_description || d.error)) || 'token exchange failed'));

    const email = decodeJwtEmail(d.id_token || '');
    if (!d.refresh_token) {
      // Google only returns a refresh token on first consent. If missing, the account already
      // granted access — remove the app at myaccount.google.com/permissions and reconnect.
      return back(res, base, 'gmail_error=' + encodeURIComponent('No refresh token returned — remove this app under your Google account permissions, then reconnect.'));
    }
    await saveToken(email, d.refresh_token);
    return back(res, base, 'gmail_connected=' + encodeURIComponent(email || ''));
  } catch (e) {
    return back(res, base, 'gmail_error=' + encodeURIComponent(String((e && e.message) || e)));
  }
};
