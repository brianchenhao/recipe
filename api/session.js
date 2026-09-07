// GET /api/session — who, if anyone, is signed in on this device, and which
// sign-in methods this deployment actually has set up.

import { json, sessionEmail, isAllowed } from './_lib.js';

export default function handler(req, res) {
  const email = sessionEmail(req);
  const signedIn = !!email && isAllowed(email);
  return json(res, 200, {
    signedIn,
    email: signedIn ? email : '',
    // The login page shows whichever of these are actually configured, so a
    // half-set-up deployment degrades to a clear message instead of a dead
    // button or a confusing error.
    methods: {
      google: !!process.env.GOOGLE_CLIENT_ID,
      email: !!(process.env.RESEND_API_KEY && process.env.MAIL_FROM)
    },
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
    // Whether the picture-upload step can ask Gemini to fill in the recipe
    // details. Not required for adding a recipe — the form still works
    // without it, just with nothing pre-filled.
    ai: !!process.env.GEMINI_API_KEY
  });
}
