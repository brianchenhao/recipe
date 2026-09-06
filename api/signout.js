// POST /api/signout — clear the session on this device.

import { json, endSession } from './_lib.js';

export default function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST.' });
  endSession(res);
  return json(res, 200, { ok: true });
}
