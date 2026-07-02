# UI smoke checklist

The frontend has no automated test net (see `UI-REFACTOR-PLAN.md`). Run this
checklist after each UI-refactor step. The app must build and every view must
render with **no console errors**.

## Build + boot
- [ ] `npm run build:ui` succeeds (writes `public/app.js`).
- [ ] `node -c public/app.js` parses (catches cross-file scope collisions).
- [ ] App loads at `http://localhost:5174` (or via `npm run desktop`) — no red
      console errors; `#root` is populated.

### Automated check (preferred) — `npm run smoke:ui`
`scripts/ui-smoke.mjs` builds the bundle, boots the server on a throwaway data
dir, creates an admin, then drives headless Chrome over CDP (injecting the auth
cookie) to visit `/`, `/chat`, `/chats`, `/kb`, `/manage`, `/settings`. Fails a
view on any console error / uncaught exception / empty `#root`, and writes a
screenshot per view to `$TMPDIR/cortex-ui-smoke/`. Run after every UI step.
(Routes reachable only via in-app nav — People, Knowledge graph, Photo map,
modals — still need the manual pass below.)

### Quick headless check (no GUI needed)
```bash
D=$(mktemp -d); CORTEX_DATA_DIR="$D" PORT=5264 node server.js & SP=$!
sleep 2
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
  --disable-gpu --virtual-time-budget=5000 --screenshot=/tmp/ui.png \
  --dump-dom http://127.0.0.1:5264/ | grep -c auth-card   # >0 ⇒ React mounted
kill $SP; rm -rf "$D"
```
(empty data dir → first-run setup screen; real `data/` → sign-in.)

## Render-each-view pass (sign in first)
- [ ] **Setup / Sign-in** — card renders, can create/sign in.
- [ ] **Gallery** — folders/files grid, breadcrumb, multi-select bar.
- [ ] **Focus** (open a file) — preview + image AI-search panel.
- [ ] **Chat** — send a message: streaming, markdown, a chart/table render,
      agent step trace, source citations, image attach.
- [ ] **Chats hub** — list, search, rename, delete.
- [ ] **Projects** — create, tabs, per-project KB.
- [ ] **Agents** — list, create/edit modal.
- [ ] **People** — face grid (lazy-loads face-api), name a person, lightbox.
- [ ] **Photo Map** — Leaflet map + markers.
- [ ] **Knowledge Graph** — nodes/edges render.
- [ ] **Settings** — all tabs open; model picker; MCP token.
- [ ] **Command palette** (⌘K) — opens, navigates.
- [ ] **Extract / Duplicates / Rename** modals open from the gallery.

## Backend still green (UI calls the same APIs)
- [ ] `bash scripts/smoke.sh` → 21/21
- [ ] `node eval/run.js` → 12/12 (when Ollama is up)
