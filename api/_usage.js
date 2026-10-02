// Shared plumbing for the usage log. Events go to Brian's Supabase project
// (brianchenhaov2, schema recipe_mom) through two key-gated functions:
// rm_track writes, rm_usage reads. USAGE_KEY is the gate; the database keeps
// only its sha256.

const URL_ = () => String(process.env.USAGE_DB_URL || '').replace(/\/+$/, '');
const PUBLIC_KEY = () => process.env.USAGE_DB_PUBLIC_KEY || '';

export function usageConfigured() {
  return !!(URL_() && PUBLIC_KEY() && process.env.USAGE_KEY);
}

export function ownerEmails() {
  return String(process.env.OWNER_EMAILS || '')
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
}

export async function rpc(name, args) {
  const r = await fetch(URL_() + '/rest/v1/rpc/' + name, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: PUBLIC_KEY(),
      Authorization: 'Bearer ' + PUBLIC_KEY()
    },
    body: JSON.stringify(Object.assign({ p_key: process.env.USAGE_KEY }, args))
  });
  const text = await r.text();
  if (!r.ok) throw new Error('Usage store said ' + r.status + ': ' + text.slice(0, 200));
  return text ? JSON.parse(text) : null;
}
