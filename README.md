# Recipe Mom

> Everything worth cooking twice.

A recipe site in the structural style of a Food Network recipe page, with its own visual identity
and a lot of motion. It is a **static site**: no build step, no framework, no npm, no bundler.
Plain HTML, CSS and vanilla ES2020 JavaScript, served as files over http.

Nothing on the site is hardcoded content. Every word — brand, hero copy, nav, categories,
collections, footer, and every recipe — is rendered at runtime from two JSON files.

---

## File map

| Path | What it is |
|---|---|
| `index.html` | Document shell: header, hero markup, section skeletons, the inline SVG sprite, footer. Contains no recipe or category text. |
| `styles.css` | The whole design system and every animation, including the `prefers-reduced-motion` fallbacks. |
| `app.js` | Data loading, hash routing, rendering, and all interaction. |
| `site.json` | Site configuration: brand, hero, nav, categories, collections, footer. |
| `recipes.json` | The recipes, as `{ "recipes": [ … ] }`. |
| `images/` | Optional recipe photos. Recipes with `img: ""` fall back to an SVG illustration. |
| `admin/index.html` | Decap CMS shell. |
| `admin/config.yml` | Decap CMS collections — mirrors the JSON schemas exactly. |
| `api/auth.js` | GitHub OAuth step 1 (redirect to GitHub). |
| `api/callback.js` | GitHub OAuth step 2 (code → token, handed back to the CMS). |
| `api/_sections.js` | The three sections and the categories each may use. The save and reader APIs check against it. |
| `api/recipe-save.js` | Saves an entry (any section) and its pictures to the repo, which publishes it. |
| `api/recipe-extract.js` | Reads an uploaded picture with Muse Spark and fills in the fields. |
| `api/recipe-delete.js` | Removes an entry from `recipes.json`. |
| `api/quiz-generate.js` | Writes quiz questions: a sample, a research plan, then batches. |
| `api/_quiz.js` | The quiz question shape and the clean-up applied to every question. |
| `api/_reader.js` | Shared reader plumbing: the request, plain-English errors, JSON extraction. |
| `quizzes/` | One JSON file of questions per quiz. |
| `vercel.json` | Static hosting config: SPA rewrite, cache headers, security headers. |

Routing is hash-based and handled entirely in `app.js`:
`#/`, `#/recipes`, `#/recipe/<id>`, `#/category/<Category>`, `#/search?q=<term>`,
`#/collection/<id>`, `#/health`, `#/health/<id>`, `#/questions`, `#/questions/<id>`,
and the manager at `#/admin?s=<recipes|health|questions>`. An unknown or empty hash falls back
to home.

---

## How the data shape works

### `site.json`

```jsonc
{
  "brand": "Recipe Mom",
  "tagline": "Everything worth cooking twice.",
  "hero":  { "eyebrow", "title", "sub", "cta", "featured" },   // featured = a recipe id
  "nav":   [ { "label", "columns": [ { "heading", "links": [ { "label", "cat" } ] } ] } ],
  "categories": [ "Breakfast", "Mains", … ],
  "collections": [ { "id", "label", "desc", "filter": { … } } ],
  "sections": { "health": { "label", "singular", "intro", "categories": [ … ] }, "questions": { … } },
  "footer": { "note", "columns": [ { "heading", "links": [ { "label", "href" } ] } ] }
}
```

**Collection filters.** Only four filter keys are honoured by `app.js`. Anything else is ignored:

| Key | Type | Meaning |
|---|---|---|
| `maxMinutes` | number | Recipe `total` time parsed to minutes, `<=` this. |
| `minRating` | number | Recipe `rating` `>=` this. |
| `cat` | string | Recipe `cat` equals this. Must be one of `categories`. |
| `tag` | string | Recipe `tags` contains this. |

Keys in the same `filter` object compose with AND. A collection appears at
`#/collection/<id>` and as a horizontal rail on the home page.

Nav links use `cat`, so every mega-menu link resolves to `#/category/<cat>`, and every `cat`
must exist in `categories`. Footer links use a literal `href`, so they can point anywhere in the
hash routing space.

### `recipes.json`

`{ "recipes": [ … ] }`. Keys, **in this order**:

```
id, section, title, author, cat, tags, img, poster, ill, badge, featured, desc, lede, body,
level, prep, cook, active, total, yield, serves,
rating, reviews, ingredientGroups, steps, tips, cooksNote, nutrition
```

### Sections: Recipes, Health, Questions

The top menu has three parts: **Recipes**, **Health** and **Questions**. All three are stored in
`recipes.json`, so they share one upload, save and delete path and one manager page.

- `section` — `"health"` or `"questions"`. **Leave it out for a recipe.** Recipes written before
  sections existed have no `section` key, and that is correct; nothing needs migrating.
- `body` — plain text: a health post's write-up, shown under the picture. An empty line starts
  a new paragraph. Recipes and quizzes do not use it.
- `cat` — for a recipe, one of `site.json` `categories`. For the other two, one of that
  section's `sections.<id>.categories` (shown to visitors as "topics").
- `poster` — optional for Health: a health post can be words only.
- `quiz`, `questionCount` — Questions only: the path of the quiz file and how many questions it holds.

**The category lists live in two places that must match:** `site.json` (what the site offers)
and `api/_sections.js` (what saving and the picture reader accept). Change both together.

Health posts render at `#/health/<id>`: title, then the picture (tap to zoom, like a recipe
infographic), then the `body`. Quizzes render at `#/questions/<id>` (see below). They never appear in recipe
lists, category pages or collections, but search covers all three sections.

In `nav`, an item with `href` and no `columns` is a plain link. That is how Health and Questions
sit in the top menu next to the Recipes dropdown.

In the manager (`#/admin`), the tabs pick the section. The floating **Add** button and **Add one
by hand** both add to the open tab.

### Quizzes (the Questions section)

Questions is a shelf of quizzes, one per topic.

- **`#/questions`** has a topic search at the top. Searching a topic with no quiz opens the
  **quiz maker** (signed-in users only, because writing a quiz spends reader credit).
- **The quiz maker** takes a topic and a number of questions (150 by default). **Generate**
  writes one sample question so the style can be checked; **Done** writes the rest. It calls
  `/api/quiz-generate` once to research the topic into subtopics and key facts, then in small
  batches (6 questions, 2 at a time) so no single request runs into the time limit. The sample
  becomes question 1. When all are written it publishes through `/api/recipe-save`.
- **Writing can pause.** Every batch is saved in the browser under `rm-quiz-draft`. Closing the
  popup or the tab keeps it, and **Continue writing** on `#/questions` carries on. One draft at a
  time, on the device that started it.
- **Each quiz's questions live in `quizzes/<id>.json`**, not in `recipes.json`, so the file every
  visitor downloads stays small. The entry in `recipes.json` has `section: "questions"`, `quiz`
  (that path) and `questionCount`.
- **Question shape** (the same as the study-quiz files): `{ "q", "o": [2-6 options], "a", "tip",
  "eli5" }`. `a` is the 1-based position of the right option, or an array such as `[1, 3]` when more
  than one is right. `api/_quiz.js` cleans every question on the way in and on save.
- **Taking a quiz**: tap an option for instant right or wrong; multi-answer questions need
  Submit. Show hint reveals the tip and the explain-like-I-am-5. Skip, Jump to and Finish work as
  in the study quizzes, and Finish lists anything still unanswered. Keys: 1-6 pick, arrows move,
  H hint, S skip. Progress is saved per quiz in the browser under `rm-quiz-<id>`, so a long quiz
  can be finished over several days.
- The questions of a published quiz cannot be edited in the manager. Delete the quiz and create
  it again to rewrite them; Edit changes only its title, topic, summary and tags.

Only `id` and `title` are required. **Every other field may be absent, `""`, `0`, or `[]`** —
the renderer omits the whole section rather than drawing an empty box, so a recipe with just an
id and a title renders fine. That is deliberate: add what you have, fill the rest in later.

- `id` — url-safe slug, unique, lowercase-hyphen. It is the URL.
- `cat` — must be one of the `categories` in `site.json`.
- `img` — absolute `https://…` or `images/x.jpg`. Empty is the preferred default.
- `ill` — the illustration used when `img` is empty. Must be one of the twelve sprite ids:
  `ill-bowl`, `ill-noodles`, `ill-bread`, `ill-cake`, `ill-pot`, `ill-pan`,
  `ill-salad`, `ill-egg`, `ill-fish`, `ill-grill`, `ill-jar`, `ill-drink`.
- `featured` — `true` makes the recipe eligible for the rotating home hero.
- `serves` — the numeric base the servings scaler multiplies against.
- `ingredientGroups` — `[{ "group": "Congee Base", "items": [ … ] }]`. A recipe with no
  sub-sections uses one group with `"group": ""`.
- ingredient item — `{ "name", "usQty", "usUnit", "metricQty", "metricUnit", "note" }`.
  Quantities are **numbers**; use `0` for "salt to taste". Units are `""` for countable things
  ("2 bay leaves"). Both unit systems are stored, because the page has a US ⇄ Metric toggle.
- `steps` — `[{ "title", "text" }]`; `title` may be `""`.
- `nutrition` — `{ "calories", "fat", "carbs", "protein", "sodium", "fiber" }`, all strings.

---

## Adding a recipe

### By hand

1. Open `recipes.json` and append an object to the `recipes` array.
2. Give it at minimum an `id` and a `title`. Keep the key order above — it makes diffs readable.
3. Pick a `cat` from `site.json` `categories`, and an `ill` from the twelve sprite ids.
4. Leave `img` as `""` unless you have dropped a real photo into `images/`.
5. Fill both `usQty`/`usUnit` and `metricQty`/`metricUnit` for each ingredient if you want the
   unit toggle to be useful; if you only have one system, leave the other's quantity at `0`.
6. Save, then reload the site. There is nothing to build.

Sanity check before committing:

```bash
node -e "JSON.parse(require('fs').readFileSync('recipes.json','utf8'));console.log('ok')"
```

### Through the CMS

1. Go to `/admin` on the deployed site.
2. Click **Login with GitHub** and authorise the OAuth app.
3. Open **Content → Recipes**, click **Add Recipes**, and fill the form. The fields mirror the
   schema above one-for-one, `cat` and `ill` are dropdowns so you cannot pick an invalid value,
   and the list summary shows each recipe's title.
4. **Publish** commits the edited `recipes.json` straight to `main`, which triggers a redeploy.

**Site settings → Site configuration** edits `site.json` the same way — hero copy, nav, categories,
collections and footer. When editing a collection's `filter`, fill in only the keys you want and
leave the rest blank.

---

## Local development

Any static file server works. It must be served over http, not opened as `file://`, because the
site fetches JSON.

```bash
python -m http.server 5173
# or
npx serve .
```

Then open `http://localhost:5173`. `/admin` will not authenticate locally unless you point
`base_url` in `admin/config.yml` at a deployment that has the OAuth functions.

---

## Deployment

Deployed on Vercel as a static site with two serverless functions.

- **No build step.** Framework preset "Other", build command empty, output directory `.`.
- `vercel.json` sets `cleanUrls: false` (the site is a hash-routed single page) and rewrites any
  unknown path to `/index.html`, excluding `/api/`, `/admin/` and `/images/`.
- Cache headers are intentionally conservative: `styles.css` and `app.js` are **not**
  content-hashed, so they get `max-age=3600` rather than `immutable`. HTML, JSON and YAML get
  `max-age=0, must-revalidate` so a published recipe shows up immediately.
- Security headers on every response: `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: SAMEORIGIN`,
  and a restrictive `Permissions-Policy`.

Production URL: `https://recipe-mom3.vercel.app`

### Environment variables

The CMS login needs a GitHub OAuth App (Settings → Developer settings → OAuth Apps) whose
**Authorization callback URL** is `https://recipe-mom3.vercel.app/api/callback`.

Set these two in the Vercel project (Settings → Environment Variables), then redeploy:

| Variable | Value |
|---|---|
| `OAUTH_CLIENT_ID` | The OAuth App's client id |
| `OAUTH_CLIENT_SECRET` | The OAuth App's client secret |

Both are read server-side only, by `api/auth.js` and `api/callback.js`. Neither is ever sent to
the browser. If either is missing the login popup reports it instead of failing silently.

The backend in `admin/config.yml` is pinned to repo `brianchenhao/recipe`, branch `main`, with
`base_url: https://recipe-mom3.vercel.app` and `auth_endpoint: api/auth`. If the repo, branch or
domain changes, update those four values together.

---

## Constraints worth knowing before you edit

- **No external requests** from `index.html`, `styles.css` or `app.js` — no CDN, no Google Fonts,
  no remote images. Headings use a Georgia serif stack, body a system sans. `/admin` is the one
  exception: it is a separate page and loads Decap CMS from unpkg.
- Animations only ever move `transform` and `opacity`, and every one of them collapses to an
  instant state change under `prefers-reduced-motion: reduce`.
- Theme (`rm-theme`) and unit preference (`rm-units`) persist in `localStorage`, along with
  per-recipe ingredient and step ticks.
- A malformed or partial recipe must never break the page. Guard everything.
