// GET /api/callback?code=...&state=...
//
// Step 2 of the GitHub OAuth handshake that Decap CMS expects.
// GitHub redirects the popup here with a short-lived `code`. We trade the code
// for an access token, then hand that token to the window that opened the popup
// (the CMS) using Decap's message protocol:
//
//   popup  -> opener : "authorizing:github"
//   opener -> popup  : (any message, used to learn the opener's origin)
//   popup  -> opener : 'authorization:github:success:{"token":"…","provider":"github"}'
//
// Env vars required (set them in the Vercel project settings):
//   OAUTH_CLIENT_ID
//   OAUTH_CLIENT_SECRET

const TOKEN_URL = 'https://github.com/login/oauth/access_token';

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return '';
}

// Safe to drop inside a <script> block in an HTML document.
function embed(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function respond(res, status, message) {
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Signing in…</title></head>
<body style="font:14px/1.5 system-ui,sans-serif;padding:2rem;color:#3a2f28">
<p>Talking to GitHub…</p>
<script>
(function () {
  var message = ${embed(message)};
  function send(e) {
    if (!window.opener) return;
    window.opener.postMessage(message, e && e.origin ? e.origin : '*');
    window.removeEventListener('message', send, false);
    setTimeout(function () { window.close(); }, 400);
  }
  window.addEventListener('message', send, false);
  if (window.opener) {
    window.opener.postMessage('authorizing:github', '*');
  } else {
    document.body.textContent =
      'This page has to be opened from the Recipe Mom admin. Go to /admin and click "Login with GitHub".';
  }
})();
</script>
</body>
</html>`;

  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Set-Cookie', 'rm_oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
  res.end(html);
}

function fail(res, status, reason) {
  respond(res, status, `authorization:github:error:${JSON.stringify({ message: reason })}`);
}

export default async function handler(req, res) {
  const clientId = process.env.OAUTH_CLIENT_ID;
  const clientSecret = process.env.OAUTH_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    fail(res, 500, 'OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET are not set on this deployment.');
    return;
  }

  const url = new URL(req.url, 'https://placeholder.local');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const oauthError = url.searchParams.get('error');

  if (oauthError) {
    fail(res, 400, url.searchParams.get('error_description') || oauthError);
    return;
  }
  if (!code) {
    fail(res, 400, 'GitHub did not return an authorization code.');
    return;
  }

  const expected = readCookie(req, 'rm_oauth_state');
  if (expected && state !== expected) {
    fail(res, 400, 'OAuth state mismatch — start again from /admin.');
    return;
  }

  try {
    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'recipe-mom-cms'
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code
      })
    });

    const data = await tokenRes.json();

    if (!tokenRes.ok || data.error || !data.access_token) {
      fail(res, 401, data.error_description || data.error || 'Token exchange failed.');
      return;
    }

    respond(
      res,
      200,
      `authorization:github:success:${JSON.stringify({
        token: data.access_token,
        provider: 'github'
      })}`
    );
  } catch (err) {
    fail(res, 502, `Could not reach GitHub: ${(err && err.message) || 'unknown error'}`);
  }
}
