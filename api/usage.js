// /api/usage — the usage log, in one route (the Hobby plan allows 12).
//   POST: a batch of what someone did, from app.js.
//         Body: { visitor, device, events: [{ t, p, d, at }] }. The email is
//         never taken from the body: it comes from the sign-in cookie, so it
//         can't be faked. Always 204, so logging never bothers her.
//   GET ?days=30: the raw log for the #/usage page, OWNER_EMAILS only.

import { json, sessionEmail, isAllowed, readJsonBody } from './_lib.js';
import { usageConfigured, ownerEmails, rpc } from './_usage.js';

export default async function handler(req, res) {
  if (req.method === 'POST') return record(req, res);
  return report(req, res);
}

async function record(req, res) {
  res.statusCode = 204;
  if (!usageConfigured()) return res.end();
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
    console.error('usage record:', e.message);
  }
  res.end();
}

async function report(req, res) {
  const email = String(sessionEmail(req) || '').toLowerCase();
  if (!email || !isAllowed(email) || !ownerEmails().includes(email)) {
    return json(res, 403, { error: 'This page is only for the site owner.' });
  }
  if (!usageConfigured()) return json(res, 503, { error: 'Usage logging is not set up on this deployment.' });
  try {
    const days = Math.max(1, Math.min(365, parseInt(req.query && req.query.days, 10) || 30));
    const data = await rpc('rm_usage', { p_days: days });
    const allowed = String(process.env.ALLOWED_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
    return json(res, 200, Object.assign({ days, owners: ownerEmails(), allowed }, data));
  } catch (e) {
    return json(res, 502, { error: e.message });
  }
}
