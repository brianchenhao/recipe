// POST /api/recipe-save
//   { recipe, posterBase64?, posterMime?, cardBase64?, cardMime?, originalId? }
//
// Writes an image-only recipe into the repository through the GitHub Contents
// API. Pushing to main is what publishes it: Vercel is connected to the repo,
// so the commit triggers a deploy.

import { json, readJsonBody, requireSession } from './_lib.js';

const CATEGORIES = [
  'Stir-Fry', 'Noodles', 'Soup', 'Rice', 'Meat & Seafood',
  'Salad', 'Breakfast', 'Kuih', 'Bread & Pau', 'Cake',
  'Dessert', 'Drinks', 'Pickles', 'Sides & Sauces'
];
const ILLUSTRATIONS = [
  'ill-bowl', 'ill-noodles', 'ill-bread', 'ill-cake', 'ill-pot', 'ill-pan',
  'ill-salad', 'ill-egg', 'ill-fish', 'ill-grill', 'ill-jar', 'ill-drink'
];

function repoParts() {
  const repo = process.env.GITHUB_REPO || 'brianchenhao/recipe';
  const [owner, name] = repo.split('/');
  return { owner, name, branch: process.env.GITHUB_BRANCH || 'main' };
}

async function gh(path, options = {}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not set on this deployment.');
  const { owner, name } = repoParts();
  const r = await fetch(`https://api.github.com/repos/${owner}/${name}/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'recipe-mom-admin',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {})
    }
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!r.ok) {
    const msg = (data && data.message) || text.slice(0, 200) || `HTTP ${r.status}`;
    throw new Error(`GitHub: ${msg}`);
  }
  return data;
}

async function getFile(path) {
  const { branch } = repoParts();
  try {
    return await gh(`contents/${encodeURIComponent(path).replace(/%2F/g, '/')}?ref=${branch}`);
  } catch (err) {
    if (/Not Found/i.test(err.message)) return null;
    throw err;
  }
}

async function putFile(path, contentBase64, message, sha) {
  const { branch } = repoParts();
  const body = { message, content: contentBase64, branch };
  if (sha) body.sha = sha;
  return gh(`contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`, {
    method: 'PUT',
    body: JSON.stringify(body)
  });
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** Only let through the fields the site understands, in the documented order. */
function cleanRecipe(input, posterPath, cardPath) {
  const tags = Array.isArray(input.tags)
    ? input.tags.filter(t => typeof t === 'string' && t.trim()).slice(0, 8).map(t => t.trim())
    : [];
  return {
    id: slugify(input.id),
    title: String(input.title || '').trim().slice(0, 140),
    author: String(input.author || '').trim().slice(0, 80),
    cat: CATEGORIES.includes(input.cat) ? input.cat : 'Stir-Fry',
    tags,
    img: cardPath || String(input.img || ''),
    poster: posterPath || String(input.poster || ''),
    ill: ILLUSTRATIONS.includes(input.ill) ? input.ill : 'ill-bowl',
    badge: String(input.badge || '').trim().slice(0, 20),
    featured: input.featured === true,
    desc: String(input.desc || '').trim().slice(0, 300),
    lede: String(input.lede || '').trim().slice(0, 600),
    level: '', prep: '', cook: '', active: '',
    total: String(input.total || '').trim().slice(0, 40),
    yield: String(input.yield || '').trim().slice(0, 40),
    serves: numOrZero(input.serves, 99),
    // Ratings are never accepted from the client — the site does not show
    // invented social proof.
    rating: 0,
    reviews: 0,
    ingredientGroups: cleanGroups(input.ingredientGroups),
    steps: cleanSteps(input.steps),
    tips: Array.isArray(input.tips)
      ? input.tips.filter(t => typeof t === 'string' && t.trim()).slice(0, 8).map(t => t.trim().slice(0, 300))
      : [],
    cooksNote: String(input.cooksNote || '').trim().slice(0, 600),
    nutrition: {}
  };
}

function numOrZero(v, max) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (!isFinite(n) || n <= 0) return 0;
  return Math.min(max === undefined ? n : max, Math.round(n * 100) / 100);
}

/** A full extraction may carry the ingredients and method; keep them tidy. */
function cleanGroups(groups) {
  if (!Array.isArray(groups)) return [];
  return groups.filter(Boolean).slice(0, 8).map(g => ({
    group: String(g.group || '').trim().slice(0, 80),
    items: Array.isArray(g.items)
      ? g.items.filter(Boolean).slice(0, 40).map(it => ({
          name: String(it.name || '').trim().slice(0, 160),
          usQty: numOrZero(it.usQty),
          usUnit: String(it.usUnit || '').trim().slice(0, 20),
          metricQty: numOrZero(it.metricQty),
          metricUnit: String(it.metricUnit || '').trim().slice(0, 20),
          note: String(it.note || '').trim().slice(0, 160)
        })).filter(it => it.name)
      : []
  })).filter(g => g.items.length);
}

function cleanSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps.filter(Boolean).slice(0, 30).map(s => ({
    title: String(s.title || '').trim().slice(0, 80),
    text: String(s.text || (typeof s === 'string' ? s : '')).trim().slice(0, 900)
  })).filter(s => s.text);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST.' });
  const email = requireSession(req, res);
  if (!email) return;

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return json(res, 400, { error: err.message });
  }

  const input = body.recipe || {};
  if (!String(input.title || '').trim()) return json(res, 400, { error: 'The recipe needs a title.' });

  const id = slugify(input.id || input.title);
  if (!id) return json(res, 400, { error: 'Could not make a web address from that title.' });

  try {
    // --- 1. images -------------------------------------------------------
    const ext = (mime) => (String(mime).includes('png') ? 'png' : String(mime).includes('webp') ? 'webp' : 'jpg');
    let posterPath = String(input.poster || '');
    let cardPath = String(input.img || '');

    if (body.posterBase64) {
      posterPath = `images/${id}.${ext(body.posterMime)}`;
      const existing = await getFile(posterPath);
      await putFile(posterPath, String(body.posterBase64).replace(/^data:[^;]+;base64,/, ''),
        `Upload image for ${id}`, existing && existing.sha);
    }
    if (body.cardBase64) {
      cardPath = `images/${id}-card.${ext(body.cardMime)}`;
      const existing = await getFile(cardPath);
      await putFile(cardPath, String(body.cardBase64).replace(/^data:[^;]+;base64,/, ''),
        `Upload card image for ${id}`, existing && existing.sha);
    }

    // --- 2. recipes.json -------------------------------------------------
    const file = await getFile('recipes.json');
    if (!file) return json(res, 500, { error: 'recipes.json is missing from the repository.' });

    const data = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
    if (!Array.isArray(data.recipes)) return json(res, 500, { error: 'recipes.json is not in the expected shape.' });

    const recipe = cleanRecipe({ ...input, id }, posterPath, cardPath);
    const originalId = slugify(body.originalId || '');
    const targetId = originalId || id;
    const index = data.recipes.findIndex(r => r && r.id === targetId);

    if (index === -1) {
      if (data.recipes.some(r => r && r.id === id)) {
        return json(res, 409, { error: `A recipe with the address "${id}" already exists.` });
      }
      data.recipes.push(recipe);
    } else {
      // Editing: keep whatever the existing entry had unless it was replaced.
      const prev = data.recipes[index];
      recipe.img = cardPath || prev.img || '';
      recipe.poster = posterPath || prev.poster || '';
      recipe.featured = prev.featured === true;
      data.recipes[index] = recipe;
    }

    const updated = Buffer.from(JSON.stringify(data, null, 2), 'utf8').toString('base64');
    await putFile('recipes.json', updated,
      `${index === -1 ? 'Add' : 'Update'} ${recipe.title} (via admin, ${email})`, file.sha);

    return json(res, 200, { ok: true, id: recipe.id, created: index === -1, total: data.recipes.length });
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
}
