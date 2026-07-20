// GET /api/auth
//
// Step 1 of the GitHub OAuth handshake that Decap CMS expects.
// Decap opens this URL in a popup; we bounce the popup to GitHub's consent
// screen, which will come back to /api/callback with a `code`.
//
// Env vars required (set them in the Vercel project settings):
//   OAUTH_CLIENT_ID     — the GitHub OAuth App client id
//   OAUTH_CLIENT_SECRET — used by /api/callback, not here

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';

function originOf(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto.split(',')[0]}://${host}`;
}

function randomState() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID().replace(/-/g, '');
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export default function handler(req, res) {
  const clientId = process.env.OAUTH_CLIENT_ID;

  if (!clientId) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('OAUTH_CLIENT_ID is not set on this deployment.');
    return;
  }

  const state = randomState();
  const redirectUri = `${originOf(req)}/api/callback`;

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', 'repo');
  url.searchParams.set('state', state);

  // Lax is enough: GitHub sends the user back via a top-level GET navigation.
  res.setHeader(
    'Set-Cookie',
    `rm_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
  );
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = 302;
  res.setHeader('Location', url.toString());
  res.end();
}
