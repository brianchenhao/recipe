// POST /api/google-signin  { credential }
//
// "Sign in with Google", restricted to an allow-listed set of accounts.
// No password, no email round trip: whoever is already signed into Google
// on this device just picks their account.
//
// GOOGLE_CLIENT_ID is not a secret — it identifies the site to Google and
// is meant to be visible; every "Sign in with Google" button on the web
// exposes it in the page. What proves the sign-in is the token below,
// verified with Google.

import { json, readJsonBody, isAllowed, startSession } from './_lib.js';

const TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST.' });

  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return json(res, 500, { error: 'GOOGLE_CLIENT_ID is not set on this deployment.' });

  let body;
  try {
    body = await readJsonBody(req, 16 * 1024);
  } catch (err) {
    return json(res, 400, { error: err.message });
  }

  const credential = String(body.credential || '');
  if (!credential) return json(res, 400, { error: 'Google did not send a credential.' });

  let claims;
  try {
    // Google verifies the token's signature and expiry for us; we only need
    // to check it was issued for *this* site and that Google itself
    // confirmed the email. (tokeninfo is Google's own documented way to
    // check a token without a JWT library — fine at this scale: a handful
    // of people signing in once and staying signed in for a year.)
    const r = await fetch(`${TOKENINFO_URL}?id_token=${encodeURIComponent(credential)}`);
    claims = await r.json();
    if (!r.ok || claims.error) {
      throw new Error(claims.error_description || claims.error || `Google returned ${r.status}.`);
    }
  } catch (err) {
    return json(res, 401, { error: `Could not verify with Google: ${err.message}` });
  }

  if (claims.aud !== clientId) {
    return json(res, 401, { error: 'That sign-in was issued for a different site.' });
  }
  if (claims.email_verified !== 'true' && claims.email_verified !== true) {
    return json(res, 401, { error: 'Google has not verified that email address.' });
  }

  const email = String(claims.email || '').trim().toLowerCase();
  if (!isAllowed(email)) {
    return json(res, 403, { error: 'That Google account is not invited.' });
  }

  startSession(res, email);
  return json(res, 200, { ok: true, email });
}
