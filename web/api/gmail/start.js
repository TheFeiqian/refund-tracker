// Begin the Google OAuth flow: redirect the browser to Google's consent screen.
// The account holder signs into THEIR Gmail and grants send permission.
const { env, redirectUri } = require('./_util');

module.exports = (req, res) => {
  const cid = env('GOOGLE_CLIENT_ID');
  if (!cid) { res.status(500).send('GOOGLE_CLIENT_ID is not set on the server.'); return; }
  const params = new URLSearchParams({
    client_id: cid,
    redirect_uri: redirectUri(req),
    response_type: 'code',
    // gmail.send lets us send as the account; gmail.readonly lets us read tracked reply threads;
    // openid+email tells us WHICH account connected.
    scope: 'openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly',
    access_type: 'offline',   // needed to receive a refresh token
    prompt: 'consent',        // force a refresh token even on re-connect
    include_granted_scopes: 'true',
  });
  res.writeHead(302, { Location: 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString() });
  res.end();
};
