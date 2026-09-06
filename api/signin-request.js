// POST /api/signin-request  { email }
//
// Emails a six digit code to an allow-listed address and stores its hash in a
// short-lived signed cookie. Nothing is written to a database.

import { json, readJsonBody, isAllowed, sixDigitCode, setPendingCookie } from './_lib.js';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

function emailHtml(code) {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#fbf6ef;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#241c15">
    <div style="max-width:460px;margin:0 auto;background:#fff;border:1px solid #e4d8c6;border-radius:22px;padding:32px">
      <p style="margin:0 0 6px;font-size:12px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#8f2f16">Recipe Mom</p>
      <h1 style="margin:0 0 16px;font-family:Georgia,serif;font-size:26px;line-height:1.2">Your sign-in code</h1>
      <p style="margin:0 0 22px;font-size:15px;line-height:1.6;color:#6a5a4c">
        Enter this code on the site to sign in. You only need to do this once on
        this device &mdash; after that you will stay signed in.
      </p>
      <div style="margin:0 0 22px;padding:18px;border-radius:14px;background:#fbeae4;text-align:center">
        <span style="font-family:Georgia,serif;font-size:38px;font-weight:700;letter-spacing:.22em;color:#bf4526">${code}</span>
      </div>
      <p style="margin:0;font-size:13px;line-height:1.6;color:#6a5a4c">
        The code expires in 15 minutes. If you did not ask to sign in you can
        ignore this email &mdash; nobody can get in without the code.
      </p>
    </div>
  </body>
</html>`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST.' });

  let body;
  try {
    body = await readJsonBody(req, 64 * 1024);
  } catch (err) {
    return json(res, 400, { error: err.message });
  }

  const email = String(body.email || '').trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json(res, 400, { error: 'That does not look like an email address.' });
  }

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM;
  if (!apiKey || !from) {
    return json(res, 500, { error: 'Email is not configured on this deployment (RESEND_API_KEY / MAIL_FROM).' });
  }

  // Only invited addresses may sign in. We still answer "sent" either way so
  // the endpoint cannot be used to discover who has access.
  if (!isAllowed(email)) {
    return json(res, 200, { sent: true });
  }

  const code = sixDigitCode();

  try {
    const payload = {
      from,
      to: [email],
      subject: `${code} is your Recipe Mom sign-in code`,
      html: emailHtml(code),
      text: `Your Recipe Mom sign-in code is ${code}. It expires in 15 minutes.`
    };
    if (process.env.MAIL_REPLY_TO) payload.reply_to = process.env.MAIL_REPLY_TO;

    const r = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!r.ok) {
      const detail = await r.text();
      // Surface the reason (usually an unverified sending domain) rather than
      // failing silently — this is the step most likely to be misconfigured.
      return json(res, 502, { error: 'Resend rejected the email.', detail: detail.slice(0, 400) });
    }
  } catch (err) {
    return json(res, 502, { error: `Could not reach Resend: ${err.message}` });
  }

  setPendingCookie(res, email, code);
  return json(res, 200, { sent: true });
}
