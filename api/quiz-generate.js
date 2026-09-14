// POST /api/quiz-generate
//
//   { mode: "sample",   topic }
//       -> { title, category, question }
//   { mode: "research", topic, count }
//       -> { title, category, summary, tags, subtopics, facts }
//   { mode: "batch",    topic, title, subtopic, facts, count, avoid }
//       -> { questions }
//
// Writes quizzes for the Questions section. A 150-question quiz is far too
// long for one request (and for one serverless time limit), so the browser
// drives it: one "research" call plans the topic into subtopics and key facts,
// then many small "batch" calls write the questions, a subtopic at a time. The
// browser saves after every batch, so a closed tab can carry on later.
//
// Nothing is published here. The finished quiz goes through recipe-save.js.
// Only signed-in users can call this: every call spends reader credit.

import { json, readJsonBody, requireSession } from './_lib.js';
import { askReader } from './_reader.js';
import { categoriesFor, defaultCategory } from './_sections.js';
import { cleanQuestion, questionKey } from './_quiz.js';

const CATEGORIES = categoriesFor('questions');
const MAX_BATCH = 10;

const clip = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const cleanList = (v, maxItems, maxLen) =>
  Array.isArray(v) ? v.map(x => clip(x, maxLen)).filter(Boolean).slice(0, maxItems) : [];
const pickCategory = c => (CATEGORIES.includes(c) ? c : defaultCategory('questions'));

const QUESTION_SHAPE = `{
  "q": "the question",
  "o": ["option 1", "option 2", "option 3", "option 4"],
  "a": 2,
  "tip": "one sentence stating the rule or fact that decides the answer",
  "eli5": "one or two short sentences explaining it with an everyday comparison (cooking, family, school, shopping)"
}`;

const QUESTION_RULES = `Question rules:
- 4 options is normal; use 3 to 6 only when the question needs it.
- "a" is the 1-based position of the correct option. When more than one option is correct, "a" is an array of positions such as [1, 3], and the question itself says how many to pick, e.g. "(Choose 2)". Use multi-answer for at most 1 question in 6.
- Wrong options must be believable, never jokes. No "All of the above" or "None of the above".
- Spread the correct answer across positions; do not favour one.
- Facts must be accurate and generally accepted. For health topics follow mainstream medical guidance, never give personal medical advice or doses.
- Plain English a non-specialist can follow. Explain any necessary term inside the question.
- The eli5 must explain, not repeat the tip.`;

const JSON_ONLY = '- Reply with JSON only. No markdown fence, no commentary.';

function samplePrompt(topic) {
  return `You are writing a study quiz for a family website. Topic: "${topic}".

Write ONE good sample question, so the person can check the style before the full quiz is written.

Return ONLY a JSON object:
{
  "title": "a clean quiz title for the topic, 2 to 6 words, Title Case",
  "category": "one of: ${CATEGORIES.join(' | ')}",
  "question": ${QUESTION_SHAPE}
}

${QUESTION_RULES}
${JSON_ONLY}`;
}

function researchPrompt(topic, count) {
  return `You are planning a ${count}-question study quiz for a family website. Topic: "${topic}".

Research the topic (use any web results provided) and plan broad, even coverage.

Return ONLY a JSON object:
{
  "title": "a clean quiz title, 2 to 6 words, Title Case",
  "category": "one of: ${CATEGORIES.join(' | ')}",
  "summary": "two plain sentences saying what the quiz covers",
  "tags": ["3 to 5 short tags"],
  "subtopics": ["12 to 20 distinct subtopics that together cover the topic, each a short phrase"],
  "facts": ["30 to 50 short, accurate, well-established facts to build questions on, one sentence each"]
}

Rules:
- Accuracy over breadth. Only generally accepted facts; for health topics follow mainstream medical guidance.
- No personal medical advice, no doses.
${JSON_ONLY}`;
}

function batchPrompt({ topic, title, subtopic, facts, count, avoid }) {
  const factLines = facts.length ? facts.map(f => '- ' + f).join('\n') : '- (none provided)';
  const avoidBlock = avoid.length
    ? `These questions are already in the quiz. Do NOT repeat or closely rephrase any of them:\n${avoid.map(a => '- ' + a).join('\n')}\n\n`
    : '';
  return `You are writing questions for a study quiz called "${title}" (topic: "${topic}").

Write exactly ${count} new multiple-choice questions about this part of the topic: "${subtopic}".

Facts you can build on (other well-established knowledge is fine too):
${factLines}

${avoidBlock}Return ONLY a JSON object:
{ "questions": [ ${QUESTION_SHAPE} ] }

${QUESTION_RULES}
${JSON_ONLY}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST.' });
  if (!requireSession(req, res)) return;

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return json(res, 400, { error: err.message });
  }

  const mode = String(body.mode || '');
  const topic = clip(body.topic, 120);
  if (topic.length < 2) return json(res, 400, { error: 'Please type a topic first.' });

  // --- one sample question, to check the style ----------------------------
  if (mode === 'sample') {
    const r = await askReader({ text: samplePrompt(topic), maxTokens: 3000, tag: 'quiz-sample' });
    if (!r.ok) return json(res, r.status, { error: r.error });
    const question = cleanQuestion(r.data.question);
    if (!question) {
      return json(res, 502, { error: 'The sample question came back incomplete. Please tap Generate again.' });
    }
    return json(res, 200, {
      title: clip(r.data.title, 80) || topic,
      category: pickCategory(r.data.category),
      question
    });
  }

  // --- plan the quiz --------------------------------------------------------
  if (mode === 'research') {
    const count = Math.max(10, Math.min(300, parseInt(body.count, 10) || 150));
    const text = researchPrompt(topic, count);
    // Web results ground the plan in checkable facts. If web search is not
    // available to this account or model, plan from the model's own knowledge
    // rather than failing the whole quiz; account problems still stop it.
    let r = await askReader({ text, maxTokens: 8000, plugins: [{ id: 'web', max_results: 5 }], tag: 'quiz-research' });
    if (!r.ok && ![401, 402, 403, 429].includes(r.upstreamStatus)) {
      r = await askReader({ text, maxTokens: 8000, tag: 'quiz-research-noweb' });
    }
    if (!r.ok) return json(res, r.status, { error: r.error });

    const d = r.data;
    const subtopics = cleanList(d.subtopics, 24, 120);
    return json(res, 200, {
      title: clip(d.title, 80) || topic,
      category: pickCategory(d.category),
      summary: clip(d.summary, 400),
      tags: cleanList(d.tags, 6, 30),
      subtopics: subtopics.length ? subtopics : [topic],
      facts: cleanList(d.facts, 60, 240)
    });
  }

  // --- write a few questions ------------------------------------------------
  if (mode === 'batch') {
    const count = Math.max(1, Math.min(MAX_BATCH, parseInt(body.count, 10) || 6));
    const avoid = cleanList(body.avoid, 400, 140);
    const r = await askReader({
      text: batchPrompt({
        topic,
        title: clip(body.title, 80) || topic,
        subtopic: clip(body.subtopic, 120) || topic,
        facts: cleanList(body.facts, 60, 240),
        count,
        avoid
      }),
      maxTokens: 9000,
      tag: 'quiz-batch'
    });
    if (!r.ok) return json(res, r.status, { error: r.error });

    const seen = new Set(avoid.map(questionKey));
    const questions = [];
    for (const raw of Array.isArray(r.data.questions) ? r.data.questions : []) {
      const q = cleanQuestion(raw);
      if (!q || seen.has(questionKey(q.q))) continue;
      seen.add(questionKey(q.q));
      questions.push(q);
      if (questions.length >= count) break;
    }
    return json(res, 200, { questions });
  }

  return json(res, 400, { error: 'Unknown mode.' });
}
