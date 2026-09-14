// Shared plumbing for the reader (Muse Spark through OpenRouter), used by
// quiz-generate.js and recipe-extract.js: turning a refusal into a sentence a
// person can act on, digging the JSON out of a reasoning model's reply, and
// (for new callers) making the request itself.
//
// The model is an env var so the private tier can be swapped in without a
// code change:
//   MUSE_MODEL=meta/muse-spark-1.3              (prompts not used for training)
//   MUSE_MODEL=meta/muse-spark-1.3-contributor  (cheaper; Meta may train on it)

export const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
export const DEFAULT_MODEL = 'meta/muse-spark-1.3-contributor';

export function readerModel() {
  return process.env.MUSE_MODEL || DEFAULT_MODEL;
}

/**
 * Turn an OpenRouter refusal into something a person can act on. Every branch
 * names the setting or page that fixes it — the point is that nobody has to
 * come back and read this file to find out what went wrong.
 */
export function explain(status, upstream, model) {
  const tail = upstream ? ' (' + upstream + ')' : '';

  if (status === 401 || status === 403) {
    return 'The reader key was refused. Check OPENROUTER_API_KEY on the deployment, '
      + 'or make a fresh key at openrouter.ai/settings/keys.' + tail;
  }
  if (status === 402) {
    return 'The OpenRouter account is out of credit. Top it up at openrouter.ai/settings/credits '
      + 'and try again — reading one picture costs well under a cent.' + tail;
  }
  if (status === 404 || /data polic|no endpoints|no allowed provider/i.test(upstream)) {
    return 'OpenRouter is blocking the contributor model because the account\u2019s privacy setting '
      + 'does not allow it. Open openrouter.ai/settings/privacy and switch on prompt training, '
      + 'or set MUSE_MODEL to "meta/muse-spark-1.3" to use the private paid tier instead.' + tail;
  }
  if (status === 429) {
    return 'The reader is rate-limited right now. Wait a minute and try the picture again.' + tail;
  }
  if (status >= 500) {
    return 'The reader service is having trouble at its end. Try again in a minute \u2014 '
      + 'nothing is wrong with the picture.' + tail;
  }
  return 'The reader (' + model + ') refused the request.' + tail;
}

/**
 * Find the JSON object inside a model reply. Reasoning models wrap their
 * answer in prose, code fences, or both, so a plain JSON.parse of the whole
 * reply fails on output that is otherwise perfectly good. Walks the string
 * and returns the first balanced {...}, ignoring braces inside strings.
 * Returns null when there is nothing parseable.
 */
export function extractJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  // The easy case first.
  try { return JSON.parse(raw); } catch { /* keep looking */ }

  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '{') continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < raw.length; j++) {
      const ch = raw[j];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(raw.slice(i, j + 1)); } catch { break; }
        }
      }
    }
  }
  return null;
}

/**
 * One request to the reader. Resolves to { ok: true, data } with the parsed
 * JSON object, or { ok: false, status, upstreamStatus, error } where `error`
 * is a plain sentence. Never throws.
 *
 *   text       the prompt
 *   image      optional data: URL of a picture
 *   maxTokens  budget; reasoning is mandatory on Muse Spark and counts too
 *   plugins    optional OpenRouter plugins, e.g. [{ id: 'web' }]
 *   tag        label for the runtime logs
 */
export async function askReader({ text, image, maxTokens, plugins, tag }) {
  const label = tag || 'reader';
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return { ok: false, status: 500, upstreamStatus: 0, error: 'OPENROUTER_API_KEY is not set on this deployment.' };
  }

  const model = readerModel();
  const content = [{ type: 'text', text }];
  if (image) content.push({ type: 'image_url', image_url: { url: image } });

  const payload = {
    model,
    temperature: 0.3,
    max_tokens: maxTokens || 4000,
    response_format: { type: 'json_object' },
    messages: [{ role: 'user', content }]
  };
  if (plugins) payload.plugins = plugins;

  let r;
  try {
    r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://r.geyam.com',
        'X-Title': 'Recipe Mom'
      },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    console.error('[%s] network failure: %s', label, err && err.message);
    return { ok: false, status: 502, upstreamStatus: 0, error: `Could not reach the reader service: ${err.message}` };
  }

  if (!r.ok) {
    const detail = await r.text();
    console.error('[%s] %s -> %s %s', label, model, r.status, detail.slice(0, 600));
    let upstream = '';
    try {
      const parsed = JSON.parse(detail);
      upstream = (parsed && parsed.error && (parsed.error.message || parsed.error)) || '';
    } catch { /* not JSON */ }
    upstream = String(upstream || detail).replace(/\s+/g, ' ').trim().slice(0, 300);
    return { ok: false, status: 502, upstreamStatus: r.status, error: explain(r.status, upstream, model) };
  }

  let data;
  try {
    data = await r.json();
  } catch {
    return { ok: false, status: 502, upstreamStatus: r.status, error: 'The reader sent back something unreadable. Please try again.' };
  }
  const msg = (data && data.choices && data.choices[0] && data.choices[0].message) || {};
  // Some replies put the answer in `reasoning` when `content` comes back empty.
  const reply = String(msg.content || msg.reasoning || '');
  const parsed = extractJson(reply);
  if (!parsed) {
    console.error('[%s] unparseable reply from %s: %s', label, model, reply.slice(0, 800));
    return { ok: false, status: 502, upstreamStatus: r.status, error: 'The reader answered, but not in a form it could use. Please try again.' };
  }
  return { ok: true, data: parsed };
}
