// POST /api/recipe-extract  { imageBase64, mimeType, mode }
//
// Reads a recipe picture and fills in the fields around it.
//
//   mode "basic" — just the labels: name, category, tags, one-line
//                  description, and any time/servings the image states.
//   mode "full"  — the same, plus the ingredients and the method, so the
//                  recipe becomes searchable and readable as text instead
//                  of only as a picture.
//
// Uses Muse Spark through OpenRouter (OpenAI-compatible). The model is an
// env var so the private tier can be swapped in without a code change:
//   MUSE_MODEL=meta/muse-spark-1.3              (prompts not used for training)
//   MUSE_MODEL=meta/muse-spark-1.3-contributor  (cheaper; Meta may train on it)

import { json, readJsonBody, requireSession } from './_lib.js';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'meta/muse-spark-1.3-contributor';

const CATEGORIES = [
  'Stir-Fry', 'Noodles', 'Soup', 'Rice', 'Meat & Seafood',
  'Salad', 'Breakfast', 'Kuih', 'Bread & Pau', 'Cake',
  'Dessert', 'Drinks', 'Pickles', 'Sides & Sauces'
];
const ILLUSTRATIONS = [
  'ill-bowl', 'ill-noodles', 'ill-bread', 'ill-cake', 'ill-pot', 'ill-pan',
  'ill-salad', 'ill-egg', 'ill-fish', 'ill-grill', 'ill-jar', 'ill-drink'
];

const SHARED_RULES = `
Rules that matter:
- NEVER invent a total time. If the picture only gives per-step times and no overall total, return "".
- NEVER invent servings. Only use a number the picture actually prints.
- Choose "cat" by what the dish IS. A wok dish without noodles is Stir-Fry; anything built on noodles is Noodles; a steamed bun or loaf is Bread & Pau; a steamed rice-flour snack is Kuih; a pickled or fermented item is Pickles; a condiment or accompaniment is Sides & Sauces.
- Do not invent a rating or a review count.
- Reply with JSON only. No markdown fence, no commentary.`;

function basicPrompt() {
  return `You are reading a recipe picture for a home-cooking website.

Return ONLY a JSON object with these keys:
{
  "title": "the dish name as printed, without words like EASY or QUICK",
  "cat": "one of: ${CATEGORIES.join(' | ')}",
  "tags": ["3 to 5 short tags: cuisine, main ingredient, method"],
  "desc": "one sentence, max 20 words, describing the dish",
  "total": "total time EXACTLY as printed (e.g. '25-30 min'), or \\"\\" if the picture states no overall time",
  "yield": "servings EXACTLY as printed (e.g. '2 servings', 'Makes 6'), or \\"\\" if not stated",
  "ill": "one of: ${ILLUSTRATIONS.join(' | ')} — whichever best suits the dish"
}
${SHARED_RULES}`;
}

function fullPrompt() {
  return `You are transcribing a recipe picture for a home-cooking website.

Return ONLY a JSON object with these keys:
{
  "title": "the dish name as printed, without words like EASY or QUICK",
  "cat": "one of: ${CATEGORIES.join(' | ')}",
  "tags": ["3 to 5 short tags"],
  "desc": "one sentence, max 20 words",
  "lede": "2 to 3 warm sentences introducing the dish, written as a home cook",
  "total": "total time EXACTLY as printed, or \\"\\" if none is stated",
  "yield": "servings EXACTLY as printed, or \\"\\" if not stated",
  "serves": 0,
  "ill": "one of: ${ILLUSTRATIONS.join(' | ')}",
  "ingredientGroups": [
    { "group": "heading as printed, or \\"\\" if the list has no headings",
      "items": [
        { "name": "ingredient with its preparation, e.g. 'onion, finely sliced'",
          "usQty": 0, "usUnit": "", "metricQty": 0, "metricUnit": "", "note": "" }
      ] }
  ],
  "steps": [ { "title": "a 2-4 word heading for the step", "text": "the instruction as written" } ],
  "tips": ["any tips the picture lists"],
  "cooksNote": "any note or storage advice, else \\"\\""
}

Transcribing the ingredients:
- Copy quantities EXACTLY as printed. If the picture says "300 g", metricQty is 300 and metricUnit is "g".
- Fill in the other unit system ONLY by straight conversion (1 cup flour = 120 g, 1 cup liquid = 240 ml, 1 lb = 454 g, 1 tbsp = 15 ml, 1 tsp = 5 ml). Never guess a quantity the picture does not give.
- Countable things ("2 eggs") use empty units and the same number in both.
- "to taste" or "a pinch" is qty 0 with the wording in "note".
- "serves" is the plain number of servings if the picture states one, else 0.
${SHARED_RULES}`;
}

/**
 * Turn an OpenRouter refusal into something a person can act on. Every branch
 * names the setting or page that fixes it — the point is that nobody has to
 * come back and read this file to find out what went wrong.
 */
function explain(status, upstream, model) {
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
function extractJson(text) {
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

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST.' });
  if (!requireSession(req, res)) return;

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return json(res, 500, { error: 'OPENROUTER_API_KEY is not set on this deployment.' });

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return json(res, 400, { error: err.message });
  }

  const imageBase64 = String(body.imageBase64 || '').replace(/^data:[^;]+;base64,/, '');
  const mimeType = String(body.mimeType || 'image/jpeg');
  const full = String(body.mode || 'basic') === 'full';
  if (!imageBase64) return json(res, 400, { error: 'No picture was sent.' });

  const model = process.env.MUSE_MODEL || DEFAULT_MODEL;

  try {
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://r.geyam.com',
        'X-Title': 'Recipe Mom'
      },
      body: JSON.stringify({
        model,
        // A reasoning model narrates before it answers, and that narration is
        // what broke the parse. We only want the JSON.
        reasoning: { enabled: false },
        temperature: 0.1,
        max_tokens: full ? 6000 : 900,
        response_format: { type: 'json_object' },
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: full ? fullPrompt() : basicPrompt() },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } }
          ]
        }]
      })
    });

    if (!r.ok) {
      const detail = await r.text();
      // "Rejected the request" told nobody anything. Turn the common refusals
      // into a sentence that says what to actually go and change, and log the
      // raw body so the runtime logs stay useful for whoever inherits this.
      console.error('[recipe-extract] %s %s -> %s %s', model, full ? 'full' : 'basic', r.status, detail.slice(0, 600));

      let upstream = '';
      try {
        const parsed = JSON.parse(detail);
        upstream = (parsed && parsed.error && (parsed.error.message || parsed.error)) || '';
      } catch { /* not JSON */ }
      upstream = String(upstream || detail).replace(/\s+/g, ' ').trim().slice(0, 300);

      return json(res, 502, { error: explain(r.status, upstream, model), detail: upstream });
    }

    const data = await r.json();
    const msg = (data && data.choices && data.choices[0] && data.choices[0].message) || {};
    // Some replies put the answer in `reasoning` when `content` comes back empty.
    const text = String(msg.content || msg.reasoning || '');
    const parsed = extractJson(text);
    if (!parsed) {
      console.error('[recipe-extract] unparseable reply from %s: %s', model, text.slice(0, 800));
      return json(res, 502, {
        error: 'The reader answered, but not with a recipe it could fill the form from. '
          + 'Please try the picture again, or fill the details in by hand.',
        detail: text.slice(0, 300)
      });
    }

    // Never trust the model for values the site constrains.
    const out = {
      title: String(parsed.title || '').trim().slice(0, 140),
      cat: CATEGORIES.indexOf(parsed.cat) !== -1 ? parsed.cat : 'Stir-Fry',
      ill: ILLUSTRATIONS.indexOf(parsed.ill) !== -1 ? parsed.ill : 'ill-bowl',
      tags: Array.isArray(parsed.tags)
        ? parsed.tags.filter(t => typeof t === 'string' && t.trim()).slice(0, 6).map(t => t.trim())
        : [],
      desc: String(parsed.desc || '').trim().slice(0, 300),
      total: String(parsed.total || '').trim().slice(0, 40),
      yield: String(parsed.yield || '').trim().slice(0, 40),
      mode: full ? 'full' : 'basic'
    };

    if (full) {
      const num = v => { const n = typeof v === 'number' ? v : parseFloat(v); return isFinite(n) && n > 0 ? n : 0; };
      out.lede = String(parsed.lede || '').trim().slice(0, 600);
      out.serves = Math.max(0, Math.min(99, Math.round(num(parsed.serves))));
      out.cooksNote = String(parsed.cooksNote || '').trim().slice(0, 600);
      out.tips = Array.isArray(parsed.tips)
        ? parsed.tips.filter(t => typeof t === 'string' && t.trim()).slice(0, 8).map(t => t.trim().slice(0, 300))
        : [];
      out.steps = Array.isArray(parsed.steps)
        ? parsed.steps.filter(Boolean).slice(0, 30).map(s => ({
            title: String(s.title || '').trim().slice(0, 80),
            text: String(s.text || (typeof s === 'string' ? s : '')).trim().slice(0, 900)
          })).filter(s => s.text)
        : [];
      out.ingredientGroups = Array.isArray(parsed.ingredientGroups)
        ? parsed.ingredientGroups.filter(Boolean).slice(0, 8).map(g => ({
            group: String(g.group || '').trim().slice(0, 80),
            items: Array.isArray(g.items)
              ? g.items.filter(Boolean).slice(0, 40).map(it => ({
                  name: String(it.name || '').trim().slice(0, 160),
                  usQty: num(it.usQty),
                  usUnit: String(it.usUnit || '').trim().slice(0, 20),
                  metricQty: num(it.metricQty),
                  metricUnit: String(it.metricUnit || '').trim().slice(0, 20),
                  note: String(it.note || '').trim().slice(0, 160)
                })).filter(it => it.name)
              : []
          })).filter(g => g.items.length)
        : [];
    }

    return json(res, 200, out);
  } catch (err) {
    console.error('[recipe-extract] network failure:', err && err.message);
    return json(res, 502, { error: `Could not reach the reader service: ${err.message}` });
  }
}
