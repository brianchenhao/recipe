// POST /api/track — a batch of what someone did on the site, from app.js.
// Body: { visitor, device, events: [{ t, p, d, at }] }. The email is never
// taken from the body: it comes from the sign-in cookie, so it can't be faked.
// Always answers 204 so a logging problem never shows up on her screen.

import { sessionEmail, isAllowed, readJsonBody } from './_lib.js';
import { usageConfigured, rpc } from './_usage.js';

export default async function handler(req, res) {
  res.statusCode = 204;
  if (req.method !== 'POST' || !usageConfigured()) return res.end();
  try {
    const body = await readJsonBody(req, 64 * 1024);
    const events = Array.isArray(body.events) ? body.events.slice(0, 100) : [];
    if (!events.length) return res.end();
    const email = sessionEmail(req);
    await rpc('rm_track', {
      p_visitor: String(body.visitor || '').slice(0, 40),
      p_email: email && isAllowed(email) ? email : '',
      p_device: String(body.device || '').slice(0, 20),
      p_events: events
    });
  } catch (e) {
    console.error('track:', e.message);
  }
  res.end();
}
