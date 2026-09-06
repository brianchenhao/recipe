// Shared helpers for the sign-in and admin endpoints.
//
// Files under api/ whose name starts with "_" are not turned into routes, so
// this is a plain module the handlers import.
//
// The sign-in is deliberately stateless: there is no database. A short-lived
// signed cookie carries the pending code, and a long-lived signed cookie is
// the session. Both are HMAC'd with AUTH_SECRET, so a cookie that has been
// tampered with simply fails to verify.

import crypto from 'node:crypto';

const SESSION_COOKIE = 'rm_session';
const PENDING_COOKIE = 'rm_pending';
const SESSION_DAYS = 365;      // "log in once, stay logged in"
const PENDING_MINUTES = 15;

/* ----------------------------------------------------------- encoding */

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(str) {
  const pad = str.length % 4 ? '='.repeat(4 - (str.length % 4)) : '';
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8');
}

function secret() {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 16) throw new Error('AUTH_SECRET is not set (needs a long random string).');
  return s;
}

/* ------------------------------------------------------------ signing */

function sign(payloadObj) {
  const body = b64url(JSON.stringify(payloadObj));
  const sig = b64url(crypto.createHmac('sha256', secret()).update(body).digest());
  return `${body}.${sig}`;
}

function unsign(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = b64url(crypto.createHmac('sha256', secret()).update(body).digest());
  // Constant-time compare so a wrong signature cannot be probed byte by byte.
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(unb64url(body));
    if (!data || typeof data.exp !== 'number' || Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ cookies */

export function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return '';
}

function cookie(name, value, maxAgeSeconds) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function setPendingCookie(res, email, code) {
  const codeHash = crypto.createHash('sha256').update(`${code}:${secret()}`).digest('hex');
  const token = sign({ email, codeHash, tries: 0, exp: Date.now() + PENDING_MINUTES * 60 * 1000 });
  res.setHeader('Set-Cookie', cookie(PENDING_COOKIE, token, PENDING_MINUTES * 60));
}

export function readPending(req) {
  return unsign(readCookie(req, PENDING_COOKIE));
}

export function codeMatches(pending, code) {
  const given = crypto.createHash('sha256').update(`${String(code).trim()}:${secret()}`).digest('hex');
  const a = Buffer.from(given);
  const b = Buffer.from(String(pending.codeHash || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function startSession(res, email) {
  const token = sign({ email, exp: Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000 });
  res.setHeader('Set-Cookie', [
    cookie(SESSION_COOKIE, token, SESSION_DAYS * 24 * 60 * 60),
    `${PENDING_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
  ]);
}

export function endSession(res) {
  res.setHeader('Set-Cookie', [
    `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    `${PENDING_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
  ]);
}

/** The signed-in email, or '' when there is no valid session. */
export function sessionEmail(req) {
  const data = unsign(readCookie(req, SESSION_COOKIE));
  return data && typeof data.email === 'string' ? data.email : '';
}

/* --------------------------------------------------------- allow list */

export function allowedEmails() {
  return String(process.env.ALLOWED_EMAILS || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isAllowed(email) {
  const list = allowedEmails();
  return list.length > 0 && list.includes(String(email).trim().toLowerCase());
}

/* -------------------------------------------------------------- utils */

export function sixDigitCode() {
  // randomInt is uniform, unlike Math.random() % 1e6.
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

export function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export async function readJsonBody(req, limitBytes = 12 * 1024 * 1024) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) throw new Error('Payload too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Body was not valid JSON');
  }
}

/** Guard for the admin endpoints: returns the email, or ends the response. */
export function requireSession(req, res) {
  const email = sessionEmail(req);
  if (!email || !isAllowed(email)) {
    json(res, 401, { error: 'Not signed in.' });
    return '';
  }
  return email;
}
