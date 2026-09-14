// The shape of one quiz question, shared by quiz-generate.js (which writes
// them) and recipe-save.js (which publishes them).
//
// Same shape as the study-quiz files used elsewhere:
//   q     the question
//   o     2 to 6 options
//   a     1-based position of the right option, or an array of positions
//         when more than one option is right, e.g. [1, 3]
//   tip   one sentence stating the rule or fact that decides the answer
//   eli5  a plain, everyday explanation ("explain like I am 5")

const clip = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

/** Returns a tidy question, or null when it cannot be answered as written. */
export function cleanQuestion(x) {
  if (!x || typeof x !== 'object') return null;
  const q = clip(x.q, 500);
  const o = Array.isArray(x.o) ? x.o.map(v => clip(v, 240)).filter(Boolean).slice(0, 6) : [];
  if (!q || o.length < 2) return null;

  const raw = Array.isArray(x.a) ? x.a : [x.a];
  const a = [...new Set(raw.map(n => parseInt(n, 10)).filter(n => n >= 1 && n <= o.length))].sort((m, n) => m - n);
  if (!a.length || a.length === o.length) return null;   // no answer, or every option "right"

  return {
    q,
    o,
    a: a.length === 1 ? a[0] : a,
    tip: clip(x.tip, 400),
    eli5: clip(x.eli5, 400)
  };
}

/** A question's identity for spotting repeats: lowercase words only. */
export function questionKey(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** A whole quiz as it is written to quizzes/<id>.json (the id is added on save). */
export function cleanQuiz(input) {
  const src = input && typeof input === 'object' ? input : {};
  const seen = new Set();
  const questions = [];
  for (const raw of Array.isArray(src.questions) ? src.questions.slice(0, 1000) : []) {
    const q = cleanQuestion(raw);
    if (!q) continue;
    const key = questionKey(q.q);
    if (seen.has(key)) continue;
    seen.add(key);
    questions.push(q);
  }
  return {
    title: clip(src.title, 140),
    topic: clip(src.topic, 140),
    category: clip(src.category, 60),
    summary: clip(src.summary, 400),
    createdAt: new Date().toISOString().slice(0, 10),
    questions
  };
}
