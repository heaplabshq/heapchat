# Cortex — Design System Rules (for Figma → code via MCP)

How this codebase is structured for UI, and the exact conventions to follow when
translating a Figma design into it. **Read this before generating any UI.**

> TL;DR: React as a `<script>` global (no `import React`) + ES-module app code + hand-written CSS with **CSS custom
> properties** as the only token source. No Tailwind, no CSS-in-JS, no component
> library. Build = esbuild concatenating `public/js/*.jsx`. Reuse the existing
> primitives (`.btn`, `.chip`, `.field`, `.set-section`, `Icon`) and **never
> hardcode a hex value** — map every Figma style to a `var(--token)`.

---

## 1. Token Definitions

**All design tokens are CSS custom properties in `:root`**, defined once in
[`public/css/app.css`](public/css/app.css). There is **no JS token system, no
Style Dictionary, no transformation pipeline** — the CSS variable *is* the token.

```css
:root {
  /* surfaces */   --bg:#f1f3f7; --surface:#fff; --surface-2:#f8f9fb; --surface-3:#f1f3f7;
  /* ink (text) */ --ink:#131922; --ink-2:#58626f; --ink-3:#8b95a2; --ink-4:#aab2bd;
  /* lines */      --line:#e6e9ef; --line-2:#eef0f5;
  /* accent */     --accent:#2b57e0; --accent-hover:#2247bd; --accent-ink:#fff;
                   --accent-soft:#eaf0fe; --accent-soft-2:#d8e3fd;
  /* status */     --good:#1e8a5b; --good-soft:#e4f3ec; --warn:#b4541b; --warn-soft:#fbeee4;
  /* radii */      --radius:14px; --radius-sm:10px; --radius-lg:20px;
  /* elevation */  --shadow-xs / --shadow-sm / --shadow-md / --shadow-lg;
  /* type */       --font-ui:'Manrope',…; --font-mono:'JetBrains Mono',…;
  /* layout */     --sidebar-w:248px; --chat-w:384px;
}
```

**Rules**
- Map every Figma color/style to the nearest token below. **Never paste a raw hex** into a component.
- Tokens marked `/* tweakable */` (`--accent`, `--radius`, `--font-ui`) are intentional theming knobs.
- Need a one-off shade? Use the token in `rgba()` / `color-mix()` rather than inventing a new hex.

| Figma role | Token |
|---|---|
| Page background | `--bg` |
| Card / panel fill | `--surface` (raised) · `--surface-2` / `--surface-3` (insets, hovers) |
| Primary text | `--ink` · secondary `--ink-2` · muted `--ink-3` · faint/placeholder `--ink-4` |
| Borders / dividers | `--line` (default) · `--line-2` (subtle) |
| Brand / primary action | `--accent` (+`--accent-hover`, text on it `--accent-ink`, tints `--accent-soft`/`-soft-2`) |
| Success / destructive | `--good*` / `--warn*` |
| Corner radius | `--radius-sm` 10 · `--radius` 14 · `--radius-lg` 20 |

---

## 2. Component Library

There is **no third-party component library and no Storybook**. "Components" are:

1. **CSS component classes** in [`public/css/app.css`](public/css/app.css) (primitives) and
   [`public/css/views.css`](public/css/views.css) (feature/view chrome).
2. **React function components** in `public/js/*.jsx`, one file per feature/view.

Reuse these CSS classes instead of authoring new styles:

| Need | Class(es) | Source |
|---|---|---|
| Button | `.btn` + `.primary` / `.ghost` / `.sm` / `.icon` | app.css |
| Pill / filter | `.chip` (+`.on`) · label `.tag` | app.css |
| Text input / textarea / select | `.input` `.textarea` `.select` (shared focus ring) | app.css |
| Search box | `.search` | app.css |
| Toggle switch | `.toggle` (+`.on`) | app.css |
| Slider | `.range` | app.css |
| Card surface | `.card` | app.css |
| Settings/feature **section** | `.set-section` › `.set-title` › `.set-sub` | views.css |
| Labeled field | `.field` › `.field-label` + `.field-hint` | views.css |
| List row / setting row | `.row-set` | views.css |
| Inline notice | `.callout` (+`.warn`) | views.css |
| Modal | `.modal-backdrop` › `.modal` › `.modal-head`/`.modal-body`/`.modal-foot` | views.css |
| Sidebar nav item | `.nav-item` (+`.on`) | views.css |
| Chat composer | `.composer` | views.css |

A canonical page (mirror this for new views — see [`public/js/manage.jsx`](public/js/manage.jsx),
[`public/js/activity.jsx`](public/js/activity.jsx)):

```jsx
<div className="settings-scroll scroll">
  <div className="settings-wrap" style={{ maxWidth: 880 }}>
    <div className="set-section">
      <div className="set-title"><Icon name="bolt" size={18} style={{ color: "var(--accent)" }} /> Title</div>
      <div className="set-sub">One-line description in muted ink.</div>
      <div className="row-set"><div className="col grow">…</div><button className="btn sm">Action</button></div>
    </div>
  </div>
</div>
```

---

## 3. Frameworks & Libraries

- **UI framework:** **React 18** — but loaded as **browser globals** from
  [`public/vendor/react.production.min.js`](public/vendor) (+`react-dom`), *not* bundled from npm.
  `React` and `ReactDOM` are `window` globals; components call `React.useState`, `React.createElement`.
- **JSX runtime:** **classic** (`React.createElement` / `React.Fragment`) — there is **no
  `import React`**. esbuild is configured with `jsx:"transform"`, `jsxFactory:"React.createElement"`.
- **Styling:** hand-written CSS only (no Tailwind / CSS Modules / styled-components / Sass).
- **Build/bundler:** **esbuild** via [`build/esbuild.mjs`](build/esbuild.mjs). It **bundles** the
  `public/js/*.jsx` ES modules (one entry imports them in `ORDER`) into a single IIFE `public/app.js`.
  Run with `npm run build:ui` (minified) / `node build/esbuild.mjs [--watch]`; `prestart` builds automatically.
- **Other vendored libs** (globals, in `public/vendor/`): `marked` (Markdown), `DOMPurify`, `katex`,
  `leaflet` (maps), `mermaid` (diagrams), `face-api`. Desktop shell is **Electron** (`electron/`).

### The module model
The frontend is **real ES modules** (`import` / `export`), bundled by esbuild — one scope, no eval,
no global leakage, proper sourcemaps. Therefore:
- **Import what you use** from sibling files; **export** what other files consume:
  `import { Icon } from "./icons.jsx";` … `export { Foo, Bar };`.
- **Third-party libs stay `<script>` globals** (React, ReactDOM, marked, DOMPurify, katex, leaflet,
  mermaid) — referenced as **free identifiers**, *not* imported. So you still write
  `const { useState } = React;` and JSX still compiles to `React.createElement` (classic runtime,
  `jsxFactory` config — there is no `import React`). esbuild leaves these globals unbundled.
- Cross-file references are explicit imports; circular imports are fine because every reference is
  used at render time (inside component/hook bodies), not at module top level.

```jsx
// public/js/activity.jsx
import { fmt } from "./markdown.jsx";
import { Icon } from "./icons.jsx";
function ActivityPage({ agents = [] }) { const { useState } = React; /* … */ }
export { ActivityPage };
```

**Adding a new file:** create `public/js/<name>.jsx` with `import`/`export`. If another file
imports it, you're done. If nothing imports it yet (e.g. a new top-level view wired only via
state), add `"<name>"` to the `ORDER` array in `build/esbuild.mjs` so the bundle still includes
it. `app` stays last (its top-level render mounts the app).

---

## 4. Asset Management

- Static assets live under **`public/`** and are served directly (no CDN — Cortex is
  **local-first / offline**; do not add remote asset hosts).
- Third-party JS/CSS is **vendored** in `public/vendor/` and loaded via `<script>`/`<link>` in
  [`public/index.html`](public/index.html) (not bundled).
- **User images** are never imported; they're referenced through backend endpoints:
  - full file: `/api/file?path=<encoded path>`
  - thumbnail: `/api/thumb?path=<encoded path>&w=320` (server resizes via `jimp`/`mupdf`)
- App icons / PWA: `public/icon-192.png`, `icon-512.png`, `apple-touch-icon.png`, `manifest.webmanifest`.
- No image build pipeline; optimization is runtime thumbnailing on the server.

---

## 5. Icon System

**One component, inline SVG, no icon package.** [`public/js/icons.jsx`](public/js/icons.jsx) exports a
global `Icon`:

```jsx
<Icon name="folderOpen" size={18} sw={1.7} style={{ color: "var(--accent)" }} />
```

- Props: `name` (key), `size` (px, default 18), `sw` (stroke width, default 1.7), `style`.
- Every glyph is an inline `<svg viewBox="0 0 24 24">` drawn on a **24-unit grid**, `fill:none`,
  `stroke:currentColor` → **icons inherit text `color`** (set via a CSS var or class). Unknown name → falls back to `file`.
- **Naming convention:** short **camelCase**, semantic — e.g. `folderOpen`, `chevR`/`chevD`/`chevL`,
  `arrowL`, `bolt`, `sparkles`, `brain`, `clock`. (Note: chevrons are `chevR/chevD/chevL`, *not* `chevron-right`.)
- **Add an icon:** add a key to the `P` map in `icons.jsx` with path(s) using the shared `{...p}`
  stroke attrs, matching the 24-grid + round caps/joins. Don't introduce an external icon dependency.
- `icons.jsx` also defines mesh-gradient palettes (`PAL`: `sunset`, `ocean`, …) used for placeholder thumbnails.

---

## 6. Styling Approach

- **Methodology:** plain global CSS with **utility classes** (`.row`, `.col`, `.gap-2`, `.grow`,
  `.t-sm`, `.semi`, `.truncate`, `.ink-3`) **+ component classes** (`.btn`, `.set-section`, …).
  BEM-ish modifiers via space-separated classes (`.btn.primary.sm`, `.chip.on`, `.nav-item.on`).
- **Two global stylesheets**, both loaded in `index.html`:
  - `public/css/app.css` — tokens, resets, type helpers, layout utilities, form/button primitives, keyframes.
  - `public/css/views.css` — feature/view chrome (sidebar, composer, settings sections, modals, gallery…).
- **Inline `style={{}}` is idiomatic** for one-off spacing/sizing/color, and **must reference tokens**:
  `style={{ color: "var(--accent)", borderRadius: "var(--radius)", maxWidth: 880 }}`.
- **Layout:** flexbox utilities (`.row`/`.col`/`.gap-*`/`.grow`/`.between`/`.center`/`.wrap`/`.none`).
- **Typography:** size helpers `.t-xs`(11) `.t-sm`(12.5) `.t-md`(14) `.t-lg`(16); weight `.semi`(600)
  `.bold`(700) `.x-bold`(800); `.mono` for `--font-mono`. Fonts are **self-hosted variable woff2**
  (`public/fonts/` + `fonts.css`): Manrope (UI), Plus Jakarta Sans, JetBrains Mono. Base 14px / line-height 1.5.
- **Motion:** keyframes in app.css (`fadeUp`, `fadeIn`, `popIn`, `riseIn`); transitions ~`.14s`. Keep durations in that range.
- **Responsive:** desktop-first single-column app shell (it's also an Electron window). Fluid via flex +
  `min-width:0` on `.grow`; sidebar/chat widths are tokens (`--sidebar-w`, `--chat-w`). Use flex + `wrap`
  before reaching for media queries.

---

## 7. Project Structure

```
public/
  index.html            # loads vendor libs, css/app.css, css/views.css, then app.js
  app.js                # BUILD OUTPUT (generated by build/esbuild.mjs — do not edit)
  css/app.css           # tokens + primitives
  css/views.css         # view/feature components
  js/*.jsx              # SOURCE: one global-scope file per view/feature (icons, sidebar, manage, …)
  fonts/  vendor/       # self-hosted fonts; vendored libs (react, marked, leaflet, …)
build/esbuild.mjs       # transpile+concat js/*.jsx → app.js  (ORDER array = load order)
electron/               # desktop wrapper (main.js + preload.js → window.cortex bridge)
server.js + src/        # backend (Express + Ollama); serves public/ and /api/*
```

**Feature pattern:** a view = one `public/js/<feature>.jsx` (ES module — `export` the component,
`import` its deps) + its styles appended to `views.css` (added to `ORDER` in `build/esbuild.mjs`
only if nothing imports it yet). Page-level views are switched on a `view` state in `app.jsx` and given a URL in
`currentRoute()`/`applyRoute()` (+ `parseRoute` in `app-helpers.jsx`); the sidebar nav button
lives in `sidebar.jsx`.

---

## Figma → Code checklist (do this every time)

1. **Colors/text/borders** → swap to the `var(--token)` table in §1. No raw hex.
2. **Type** → `--font-ui`/`--font-mono` + `.t-*`/`.semi`/`.bold` helpers; don't set arbitrary font-families/px.
3. **Spacing** → `.gap-*` utilities or inline px; **radii/shadows** → `--radius*` / `--shadow-*`.
4. **Reuse primitives** — buttons `.btn`, pills `.chip`, inputs `.input/.select/.textarea`,
   sections `.set-section`, rows `.row-set`, modals `.modal-*`. Author new CSS only for genuinely new patterns, and put it in `views.css`.
5. **Icons** → `<Icon name="…"/>`; if the Figma icon isn't in `icons.jsx`, add it as 24-grid inline SVG (no new dep).
6. **New screen** → new `public/js/<name>.jsx` (ES module: `import` deps, `export` the component),
   wire `view`/route in `app.jsx`, add a `.nav-item` in `sidebar.jsx` (add to `ORDER` only if unimported).
7. **ES modules (import/export); third-party libs are `<script>` globals (no `import React`).** No Tailwind,
   no CSS-in-JS, no CDN. Classic JSX → `React.createElement`; `React`/hooks resolve as globals.
8. **Build to verify:** `node build/esbuild.mjs` (must succeed; outputs `public/app.js`). UI smoke: `node scripts/ui-smoke.mjs`.
