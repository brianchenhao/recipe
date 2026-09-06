// POST /api/recipe-delete  { id }
//
// Removes a recipe from recipes.json. The images are left in place — they are
// small, and git keeps the history either way, so an accidental delete stays
// recoverable.

import { json, readJsonBody, requireSession } from './_lib.js';

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
  if (!r.ok) throw new Error(`GitHub: ${(data && data.message) || text.slice(0, 200) || r.status}`);
  return data;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST.' });
  const email = requireSession(req, res);
  if (!email) return;

  let body;
  try {
    body = await readJsonBody(req, 32 * 1024);
  } catch (err) {
    return json(res, 400, { error: err.message });
  }

  const id = String(body.id || '').trim();
  if (!id) return json(res, 400, { error: 'No recipe was named.' });

  try {
    const { branch } = repoParts();
    const file = await gh(`contents/recipes.json?ref=${branch}`);
    const data = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));

    const before = data.recipes.length;
    const removed = data.recipes.find(r => r && r.id === id);
    data.recipes = data.recipes.filter(r => !r || r.id !== id);
    if (data.recipes.length === before) return json(res, 404, { error: 'That recipe was not found.' });

    await gh('contents/recipes.json', {
      method: 'PUT',
      body: JSON.stringify({
        message: `Remove ${(removed && removed.title) || id} (via admin, ${email})`,
        content: Buffer.from(JSON.stringify(data, null, 2), 'utf8').toString('base64'),
        branch,
        sha: file.sha
      })
    });

    return json(res, 200, { ok: true, removed: id, total: data.recipes.length });
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
}
