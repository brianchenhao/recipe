// POST /api/recipe-extract  { imageBase64, mimeType }
//
// Reads a recipe infographic with Gemini and suggests the handful of fields
// the site needs. The picture stays the recipe — this only fills in the
// metadata around it so nobody has to type it.

import { json, readJsonBody, requireSession } from './_lib.js';

const CATEGORIES = ['Main Dish', 'Side Dish', 'Juice', 'Fermentation'];
const ILLUSTRATIONS = [
  'ill-bowl', 'ill-noodles', 'ill-bread', 'ill-cake', 'ill-pot', 'ill-pan',
  'ill-salad', 'ill-egg', 'ill-fish', 'ill-grill', 'ill-jar', 'ill-drink'
];

const INSTRUCTION = `You are reading a recipe infographic for a home-cooking website.

Return ONLY a JSON object, no markdown fence, with these keys:
{
  "title": "the dish name as printed, without words like EASY or QUICK",
  "cat": "one of: ${CATEGORIES.join(' | ')}",
  "tags": ["3 to 5 short tags: cuisine, main ingredient, method"],
  "desc": "one sentence, max 20 words, describing the dish",
  "total": "total time EXACTLY as printed (e.g. '25-30 min', '15 min'), or \\"\\" if the image does not state an overall time",
  "yield": "servings EXACTLY as printed (e.g. '2 servings', 'Makes 6'), or \\"\\" if not stated",
  "ill": "one of: ${ILLUSTRATIONS.join(' | ')} — whichever best suits the dish"
}

Rules that matter:
- NEVER invent a total time. If the image only gives per-step times and no overall total, return "".
- NEVER invent servings. Only use a number the image actually prints.
- Choose "cat" by what the dish IS: a meal is Main Dish; a side, bread, salad or dessert is Side Dish; a drink is Juice; only pickled or fermented items are Fermentation.
- Do not add a rating or review count.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST.' });
  if (!requireSession(req, res)) return;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return json(res, 500, { error: 'GEMINI_API_KEY is not set on this deployment.' });

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return json(res, 400, { error: err.message });
  }

  const imageBase64 = String(body.imageBase64 || '').replace(/^data:[^;]+;base64,/, '');
  const mimeType = String(body.mimeType || 'image/jpeg');
  if (!imageBase64) return json(res, 400, { error: 'No image was sent.' });

  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: INSTRUCTION },
            { inline_data: { mime_type: mimeType, data: imageBase64 } }
          ]
        }],
        generationConfig: { temperature: 0.1, responseMimeType: 'application/json' }
      })
    });

    if (!r.ok) {
      const detail = await r.text();
      return json(res, 502, { error: 'Gemini rejected the request.', detail: detail.slice(0, 400) });
    }

    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('') || '';
    let parsed;
    try {
      parsed = JSON.parse(text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim());
    } catch {
      return json(res, 502, { error: 'Gemini did not return usable JSON.', detail: text.slice(0, 300) });
    }

    // Never trust the model for values the site constrains.
    const cat = CATEGORIES.includes(parsed.cat) ? parsed.cat : 'Main Dish';
    const ill = ILLUSTRATIONS.includes(parsed.ill) ? parsed.ill : 'ill-bowl';
    const tags = Array.isArray(parsed.tags)
      ? parsed.tags.filter(t => typeof t === 'string' && t.trim()).slice(0, 6).map(t => t.trim())
      : [];

    return json(res, 200, {
      title: String(parsed.title || '').trim().slice(0, 120),
      cat,
      ill,
      tags,
      desc: String(parsed.desc || '').trim().slice(0, 200),
      total: String(parsed.total || '').trim().slice(0, 40),
      yield: String(parsed.yield || '').trim().slice(0, 40)
    });
  } catch (err) {
    return json(res, 502, { error: `Could not reach Gemini: ${err.message}` });
  }
}
