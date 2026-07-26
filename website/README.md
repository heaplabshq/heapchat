# Heap Chat — product showcase site

A static, zero-build product page for Heap Chat: the "why", the feature set, real
screenshots, and the agent-research patterns it's built on. Plain HTML/CSS/JS —
no framework, no build step, no external runtime dependencies (only Google Fonts
is loaded from a CDN).

## Deploy

Live at [chat.heaplabs.dev](https://chat.heaplabs.dev) on **Cloudflare Pages**, deployed
automatically by `.github/workflows/deploy-site.yml`. Nothing here needs a manual upload:

- **push to `main`** touching `website/**` → deploys
- **a GitHub release is published** → deploys

That second trigger isn't decoration. The download buttons point at
`/releases/latest/download/<file>`, which resolves against whichever release is newest —
so publishing a release without redeploying leaves the live site linking to the previous
version's filenames, which no longer exist. The two have to move together.

Requires one repo secret: `CLOUDFLARE_API_TOKEN`, with the "Cloudflare Pages — Edit"
permission. No account ID is needed — wrangler resolves it from the token when the token
maps to a single account, same as heapcode's site deploy.

Cache and security headers live in `_headers` — Cloudflare Pages' format. (This folder
previously carried a `netlify.toml`, left over from before the move to Cloudflare. It was
inert here, which is how the site ended up serving no `X-Frame-Options` at all.)

To deploy by hand: `npx wrangler pages deploy website --project-name=<project>`.

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
    ├── screenshots/       # real screenshots of the running app
    └── hero/              # hero video (webm + mp4 + poster)
```

## Updating screenshots and the hero video

Everything under `assets/screenshots/` and `assets/hero/` is a real capture of the
running app (headless Chrome/Playwright against a local server, video via
`recordVideo` + ffmpeg) — not a mockup. All of it is seeded from `demo-fixtures/`,
a small **purpose-built, entirely fictional** knowledge base (a fake robotics
startup: team roster, product brief, meeting notes, roadmap, budget CSV, and a
synthetic receipt image) made specifically for this site.

**Do not reuse `eval/fixtures/` for screenshots or video.** Those files are real
test fixtures for the automated agent eval suite (`npm run eval`) and are
deliberately built with tricky content — exact numbers, conflation traps, and
(importantly) a fake HR note naming a specific person's salary. That's appropriate
for testing grounding accuracy; it is not appropriate to ever appear in a public
screenshot. `demo-fixtures/` exists precisely so the two never get mixed up: no
real-sounding personal names (team members are named after generic tech-mascot
words — Sprocket, Circuit, Nova, Pixel, Watt, Blip), no real brand names, no
salary/PII-shaped data.

If the UI changes meaningfully, retake these the same way (seed a throwaway
`HEAPCHAT_DATA_DIR` server with `demo-fixtures/`, drive it with Playwright)
rather than hand-editing them:

1. Start a server on a throwaway data dir, create an admin account, upload
   `demo-fixtures/*` to the KB, `POST /api/index` to build the RAG index.
2. The hero clip and the "Bring your own model" screenshot both show a live
   connected provider (currently OpenRouter's `tencent/hy3:free`, free-tier) so
   the demo doesn't look Ollama-only — copy the real provider config from your
   own `data/server.json` into the throwaway instance via
   `POST /api/admin/providers` rather than hand-typing a key, and set it as the
   default model via `localStorage["heapchat.settings.<userId>"]` before the
   page's first script runs (`context.addInitScript`, since model prefs are
   client-side, not server-side).
3. Record the hero clip with `context = browser.newContext({ recordVideo: {...} })`,
   type the question into the composer, wait for the "Grounded/verified" badge,
   close the context to flush the `.webm`, then encode with ffmpeg:
   `-c:v libx264 -crf 20` for `hero-demo.mp4` (Safari needs H.264), and
   `-c:v libvpx-vp9 -crf 32 -b:v 0` for `hero-demo.webm` (smaller, listed first
   in the `<source>` order). Grab `hero-poster.jpg` from a late frame for the
   `poster` attribute and `og:image`/`twitter:image`.
4. Screenshot views the same way for `assets/screenshots/`, `fullPage` doesn't
   help for the chat view — it has its own internal scroll container, not the
   page body — so scroll that container explicitly before capturing.

**Known citation-rendering gotcha, fixed 2026-07-20:** models frequently
backtick-quote filenames they cite (`` `budget.csv` ``). The citation-linkifier in
`public/js/markdown.jsx` used to do a naive string replace that could land an
`<a>` tag *inside* a markdown code span, which then got HTML-escaped and showed up
as literal `<a class="cite" ...>` text instead of a link. If a future screenshot
shows raw citation-tag text, that regression is back — `linkifyCites` needs to
skip over backtick spans/fences.
