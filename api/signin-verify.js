// POST /api/signin-verify  { code }
//
// Checks the six digit code against the pending cookie and, if it matches,
// swaps it for a year-long session cookie.

import { json, readJsonBody, readPending, codeMatches, startSession, isAllowed } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST.' });

  let body;
  try {
    body = await readJsonBody(req, 16 * 1024);
  } catch (err) {
    return json(res, 400, { error: err.message });
  }

  const code = String(body.code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(code)) {
    return json(res, 400, { error: 'Enter the 6-digit code from the email.' });
  }

  const pending = readPending(req);
  if (!pending) {
    return json(res, 400, { error: 'That code has expired. Ask for a new one.' });
  }

  if (!codeMatches(pending, code)) {
    return json(res, 400, { error: 'That code is not right. Check the email and try again.' });
  }

  if (!isAllowed(pending.email)) {
    return json(res, 403, { error: 'That address is not invited.' });
  }

  startSession(res, pending.email);
  return json(res, 200, { ok: true, email: pending.email });
}
