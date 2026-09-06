// GET /api/session — who, if anyone, is signed in on this device.

import { json, sessionEmail, isAllowed } from './_lib.js';

export default function handler(req, res) {
  const email = sessionEmail(req);
  const signedIn = !!email && isAllowed(email);
  return json(res, 200, {
    signedIn,
    email: signedIn ? email : '',
    // Lets the UI explain a misconfiguration instead of silently failing.
    configured: !!process.env.AUTH_SECRET && !!process.env.RESEND_API_KEY && !!process.env.MAIL_FROM
  });
}
