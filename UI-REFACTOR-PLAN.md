# Frontend (UI) Refactor Plan

> **Status (verified against code): DONE, with one deviation.** Path B was chosen
> and fully executed — `public/js/*.jsx` are real ES modules (`import`/`export`),
> bundled by `build/esbuild.mjs` into `public/app.js` (git log: "begin ES-modules
> migration" → "wave 2" → "wave 3" → "finish ES-modules migration — pure esbuild
> bundle"). `chat.jsx` went 1,464 → 669 lines; `app.jsx` went 1,265 → 916 lines,
> both decomposed into ~30 focused files (`chat-data.jsx`, `chat-hooks.jsx`,
> `composer.jsx`, `sidebar.jsx`, `app-hooks.jsx`, etc.) — the god components' render
> AND hook logic are both extracted, not just render.
> **Deviation from §3 below:** the plan proposed nested `lib/`, `components/`,
> `views/`, `modals/` subdirectories; in practice everything landed as flat files
> directly under `public/js/` instead. Functionally equivalent, just a different
> layout than originally sketched.
>
> Goal: break up the two client-side monoliths — `public/js/chat.jsx` (1,464
> lines) and `public/js/app.jsx` (1,265, of which the `App` component alone is
> ~965) — into focused modules, the same way `server.js` was split. Unlike the
> backend, there is **no automated test net** for the UI, so verification is
> manual (drive the app, check each view renders + no console errors).

---

## 0. How the frontend works today (the constraints that shape everything)

- **No build step.** Every view is a `<script type="text/babel" src="js/*.jsx">`
  in `public/index.html`, transpiled **in the browser** by the vendored
  `vendor/babel.min.js` (**3.0 MB**) on *every page load*.
- **Global namespace, load-order coupling.** There is **no `import`/`export`
  anywhere**. Each file defines top-level `function Foo()` / `const BAR` on the
  global scope; other files reference them by bare name (e.g. `app.jsx` renders
  `<Gallery>`, `<FocusView>`, `<PhotoMap>`, `<CommandPalette>` defined in other
  files). Correctness depends on the `<script>` order in `index.html`
  (`app.jsx` is last because it depends on everything).
- **Fully offline / vendored** by explicit design (comment in index.html: "All
  libraries are vendored locally — the app runs fully offline"). React,
  ReactDOM, marked, purify, katex, leaflet are all local files.
- Native bridge: `window.cortex` (Electron). State persists to `localStorage`
  (`cortex.settings`, `cortex.recents`) + the backend.

Implication: splitting a file into more files is **easy mechanically** (add
more `<script>` tags in dependency order) but **fragile** — everything shares
one global scope, so name collisions and load-order bugs are silent, and there
is no compiler to catch a missing/renamed reference. This is exactly the
problem ES modules + a bundler solve.

## 0.1 The big two (what we're cutting)

**`chat.jsx` (1,464)** — one feature file, many concerns:
- helpers: `newId`, `shrinkImage`, `serialize`, `titleFrom`, `relTimeAgo`,
  `escRe`, `linkifyCites`, `fmt`, `downloadCSV`, `fmtNum`
- `ChatAPI` (fetch wrapper for chat/agent endpoints)
- agent-trace UI: `AgentStep`, `AgentSteps`, `ThinkSegment`, `Timeline`,
  `Reasoning`, `GroundingBadge`
- rich renders: `HBars`, `VBars`, `LineChart`, `PieChart` (+ `RB_COLORS`)
- markdown/math/diagrams: `fmt`, `wrapProvenance`, `repairLatex`/`KATEX_*`,
  `ensureMermaid`/`repairMermaid`/`renderMermaid`, `renderDollarMath`,
  `renderBareLatex`, `TEX_*`
- constants: `TOOL_META`, `MANAGE_VERB`, `IMAGE_VERB`, `*_SUGGESTIONS`
- the main `Chat` component (the composer, message list, streaming loop)

**`app.jsx` (1,265)**:
- `parseRoute`, path/format helpers (`prettyBytes`, `pathCrumbs`, `b64url`,
  `shortHash`, `loadRecents`, `loadSavedSettings`), constants
- modals: `ExtractModal`, `DuplicatesModal`, `RenameModal`
- **`App` (~965 lines)** — the god component: routing, global state, sidebar,
  gallery/view switching, keyboard shortcuts, settings, batch ops, lightbox
- `Root` (mounts `<App>`)

`App` is the real target — it's the client-side equivalent of the old
`server.js`: everything routes through it.

---

## 1. The build-step decision (do this FIRST — it determines the rest)

Two viable paths. **Recommendation: Path B (introduce esbuild + ES modules).**

### Path A — stay no-build (global-namespace split)
Split files, add more `<script type="text/babel">` tags in dependency order.
- ✅ Zero new tooling; keeps the "vendored, offline, no toolchain" property.
- ✅ Smallest immediate change.
- ❌ Keeps the **3 MB Babel + full re-transpile on every load** (slow cold start).
- ❌ Splitting INCREASES the global-namespace risk (more files sharing one
  scope, more load-order edges to get right) with no compiler to catch breaks.
- ❌ Doesn't make the refactor meaningfully safer — the opposite.

### Path B — esbuild + real ES modules (recommended)
Add a tiny local bundler (esbuild: single binary, sub-second builds, no CDN),
convert files to `import`/`export`, output one bundled `app.js`.
- ✅ **Enables clean splitting** — explicit `import`/`export` deps (the same
  discipline that made the backend `require`-based split safe), no global
  collisions, compiler catches missing/renamed refs.
- ✅ **Faster app**: precompiled + minified bundle; drop the 3 MB in-browser
  Babel entirely. Big cold-load win.
- ✅ Stays fully offline (esbuild bundles vendored deps locally; nothing from a
  CDN). Source maps for debugging.
- ✅ Dev ergonomics: `esbuild --watch` rebuilds on save; the existing Electron
  dev-reload already watches `public/` → just point it at the bundle.
- ❌ Adds a build step to dev + packaging (electron-builder must run it; the
  `npm run desktop`/`dev` scripts and `eval`/CI unaffected — they're backend).
- ❌ Upfront conversion cost (add export/import to ~18 files).

**Why B despite the "no toolchain" value:** the offline guarantee is preserved
(esbuild + vendored deps, no network). What we give up is "edit jsx, hard-reload,
browser transpiles" — replaced by "esbuild watch rebuilds in <1s, reload." The
payoff (a real module system + dropping 3 MB of per-load transpilation) is
exactly what makes the chat/app split safe and is a user-facing perf win.

> If you prefer to keep zero tooling, Path A is fine — the plan below still
> applies; just substitute "add `<script>` tag + attach to a global namespace
> object" for "add `export`/`import`."

---

## 2. Verification strategy (no eval/smoke for UI)

The backend had `scripts/smoke.sh` + `eval`. The UI has neither. Substitute:

1. **Build/transpile check** (Path B): `esbuild` build succeeds with no errors;
   (Path A): page loads with **no console errors** — add a tiny boot assert.
2. **Render-each-view pass** — manually (or via the `/run` + `/verify` skills,
   which drive the app and screenshot): after each step, load the app and visit
   every route — Gallery, Focus, **Chat** (send a message, see streaming +
   markdown + a chart + agent trace), Chats hub, Projects, Agents, People,
   Photo Map, Knowledge Graph, Settings, Command Palette (⌘K), Setup. Confirm
   each renders and is interactive.
3. **A short manual smoke checklist** committed as `UI-SMOKE.md` (the routes +
   the key interactions above) so every step is checked the same way.
4. Keep the backend `eval` green too — the UI calls the same APIs; if a refactor
   accidentally changes a request shape, `eval`/`smoke.sh` may catch it.

Commit per step (small, revertable), same as the backend.

---

## 3. Target module layout (Path B)

```
public/js/
  main.jsx                 # entry: imports App, mounts Root  (the only <script>)
  lib/
    api.js                 # ChatAPI + other fetch wrappers
    format.js              # newId, prettyBytes, pathCrumbs, relTimeAgo, b64url, …
    storage.js             # loadRecents/loadSavedSettings + localStorage keys
    markdown.js            # fmt, linkifyCites, wrapProvenance, KaTeX/mermaid render
    route.js               # parseRoute
  components/
    charts.jsx             # HBars, VBars, LineChart, PieChart, RB_COLORS
    agent-trace.jsx        # AgentStep(s), ThinkSegment, Timeline, Reasoning, GroundingBadge
    icons.jsx  (exists)
  views/
    Chat.jsx               # the Chat component (slimmed — renders from the above)
    App.jsx                # the shell (slimmed)
    Gallery.jsx Focus.jsx People.jsx Graph.jsx Settings.jsx Projects.jsx
    Agents.jsx Map.jsx Setup.jsx QuickAsk.jsx Chats.jsx Manage.jsx
  modals/
    ExtractModal.jsx DuplicatesModal.jsx RenameModal.jsx FolderPicker.jsx CommandPalette.jsx
build/esbuild.mjs          # the build script (Path B)
```
(Bundled to `public/app.js`; index.html drops all the per-file `<script type=text/babel>` for one `<script type="module" src="app.js">` or the bundle.)

---

## 4. Step-by-step plan

**Step 0 — Decide build path + safety net.**
- Pick Path A or B (recommend B). If B: add esbuild (vendored binary or
  devDependency), `build/esbuild.mjs`, an `npm run build:ui` + `build:ui:watch`,
  wire `electron/main.js` dev-watch to rebuild on `public/js` changes, and make
  `electron-builder`/packaging run the build.
- Write `UI-SMOKE.md` (the manual render-each-view checklist). Capture a
  "baseline" pass (screenshots of each view) before touching code.

**Step 1 — Pure leaf helpers (lowest risk).** Extract `lib/format.js`,
`lib/storage.js`, `lib/route.js` from `app.jsx`/`chat.jsx`. No JSX, no deps.

**Step 2 — Rendering libs.** `lib/markdown.js` (fmt/linkify/provenance/KaTeX/
mermaid) and `components/charts.jsx` from `chat.jsx`. Pure-ish, well-bounded.

**Step 3 — API layer.** `lib/api.js` (`ChatAPI`, any other `fetch` wrappers).

**Step 4 — Agent-trace components.** `components/agent-trace.jsx`.

**Step 5 — Slim `Chat`.** With the above out, `Chat.jsx` is just the component
(composer + message list + streaming). Verify chat end-to-end.

**Step 6 — Modals.** `ExtractModal`, `DuplicatesModal`, `RenameModal` out of
`app.jsx` into `modals/`.

**Step 7 — Decompose `App` (the god component).** The hardest. Pull cohesive
chunks out of the ~965-line `App` into child components/hooks: sidebar,
gallery/view router, lightbox, batch-ops bar, settings wiring, keyboard
shortcuts. Do it in sub-steps, verifying the app renders after each pull.

**Step 8 — Normalize the remaining views** (Settings, People, Graph, Projects,
Agents) to the new export/import convention; they're already separate files.

**Step 9 — Entry + cleanup.** `main.jsx` as the single entry; remove the
per-file `<script>` tags from index.html (Path B); delete dead globals; final
render-each-view pass + backend `eval`/`smoke` still green.

---

## 5. Guardrails / non-goals
- **No behavior or visual change.** Pure restructure; pixels and interactions
  identical. No redesign (that's the frontend-design skill's job, separately).
- Keep everything **offline/vendored** — no CDN deps introduced by the build.
- Backend is untouched; the HTTP API contract stays fixed.
- Commit per step; the app must load and every view must render after each.
