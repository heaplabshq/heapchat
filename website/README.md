# Heap Chat — product showcase site

A static, zero-build product page for Heap Chat: the "why", the feature set, real
screenshots, and the agent-research patterns it's built on. Plain HTML/CSS/JS —
no framework, no build step, no external runtime dependencies (only Google Fonts
is loaded from a CDN).

## Deploy to Netlify

**Option A — drag and drop:** go to [app.netlify.com/drop](https://app.netlify.com/drop)
and drag this `website/` folder in. Done.

**Option B — connect the repo:**
1. New site from Git → pick this repo.
2. Base directory: `website`
3. Build command: *(leave empty)*
4. Publish directory: `website` (or `.` relative to the base directory)

`netlify.toml` in this folder already sets sane cache/security headers, so no
further config is needed either way.

## Local preview

Any static file server works, e.g.:

```bash
cd website
npx serve .
```

## Structure

```
website/
├── index.html          # the entire page
├── netlify.toml         # headers config for Netlify
└── assets/
    ├── style.css
    ├── script.js         # screenshot lightbox only
    ├── logo.png          # app icon, reused as favicon
    └── screenshots/       # real screenshots of the running app
```

## Updating screenshots

The screenshots under `assets/screenshots/` are real captures of the app (headless
Chrome against a local server, then downscaled) — not mockups. They're seeded from
`demo-fixtures/`, a small **purpose-built, entirely fictional** knowledge base
(a fake robotics startup: team roster, product brief, meeting notes, roadmap,
budget CSV, and a synthetic receipt image) made specifically for this site.

**Do not reuse `eval/fixtures/` for screenshots.** Those files are real test
fixtures for the automated agent eval suite (`npm run eval`) and are deliberately
built with tricky content — exact numbers, conflation traps, and (importantly) a
fake HR note naming a specific person's salary. That's appropriate for testing
grounding accuracy; it is not appropriate to ever appear in a public screenshot.
`demo-fixtures/` exists precisely so the two never get mixed up: no real-sounding
personal names (team members are named after generic tech-mascot words — Sprocket,
Circuit, Nova, Pixel, Watt, Blip), no real brand names, no salary/PII-shaped data.

If the UI changes meaningfully, retake the screenshots the same way (seed a local
server with `demo-fixtures/`, drive it with headless Chrome) rather than
hand-editing them.
