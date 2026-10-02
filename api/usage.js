// GET /api/usage?days=30 — the raw usage log for the #/usage page.
// Only for the emails in OWNER_EMAILS (Brian), not for everyone who can sign in.

import { json, sessionEmail, isAllowed } from './_lib.js';
import { usageConfigured, ownerEmails, rpc } from './_usage.js';

export default async function handler(req, res) {
  const email = String(sessionEmail(req) || '').toLowerCase();
  if (!email || !isAllowed(email) || !ownerEmails().includes(email)) {
    return json(res, 403, { error: 'This page is only for the site owner.' });
  }
  if (!usageConfigured()) return json(res, 503, { error: 'Usage logging is not set up on this deployment.' });
  try {
    const days = Math.max(1, Math.min(365, parseInt(req.query && req.query.days, 10) || 30));
    const data = await rpc('rm_usage', { p_days: days });
    return json(res, 200, Object.assign({ days, owners: ownerEmails(), allowed: String(process.env.ALLOWED_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean) }, data));
  } catch (e) {
    return json(res, 502, { error: e.message });
  }
}
