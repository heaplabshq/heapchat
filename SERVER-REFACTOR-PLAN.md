# server.js Refactor Plan

> Goal: split the 4,978-line monolithic `server.js` into a maintainable set of
> modules **without changing any runtime behavior or HTTP contract**.
> `server.baseline.js` is a byte-for-byte snapshot taken before refactoring so we
> can diff/verify nothing was dropped at the end. (gitignored — delete when done.)

---

## 0. Why refactor

- One file, **4,978 lines / ~316 KB**. Every concern (auth, RAG, vision, faces,
  knowledge graph, agent loop, MCP server, web search) lives together.
- Heavy cross-coupling through **module-level mutable state** (`tagStore`,
  `imageMeta`, `phashStore`, `faceStore`, `geoStore`, `entityStore`,
  `placeNames`, `pdfOcrStore`, `userStores`, `indexCache`, `mcpClients`).
- A single `runExtraction` (~700 lines, 2876→3571) and the agent endpoint
  (`/api/agent`, 4265→4646, ~380 lines) dominate the file.
- Hard to test, hard to navigate, merge-conflict prone.

## 0.1 Hard constraints (DO NOT BREAK THESE)

These three places assume `server.js` is a **single self-contained file**. Every
one must be updated as part of the refactor or the app/evals break silently:

1. **`eval/run.js:43`** — `fs.copyFileSync(ROOT/server.js, sandbox/server.js)`.
   It copies *only* `server.js` into a temp sandbox (with `node_modules` and
   `public` symlinked) and runs it. → Must also copy/symlink the new source dir.
2. **`electron/main.js:117`** — `fs.watch(root … if (file === "server.js")`
   restarts the server in dev. → Must watch the new source dir recursively.
3. **`package.json` `build.files`** — lists `"server.js"` explicitly for the
   packaged Electron app. → Must add the new source dir (e.g. `"src/**/*"`).

Other invariants:
- Entry point stays `node server.js` (electron spawns `process.execPath server.js`).
- No `module.exports` exists today; server.js is run, not required.
- `"type": "commonjs"` — keep CommonJS `require`/`module.exports` (the dynamic
  `await import()` for ESM-only deps like `@modelcontextprotocol/sdk` and `mupdf`
  must stay as dynamic imports).
- The HTTP API surface and all on-disk data formats (`data/*.json`, index files,
  per-user dirs) must remain identical.

---

## 1. Complete feature inventory (what server.js does today)

Captured from `server.baseline.js` so we can check each off at the end.

### A. Infrastructure & process
- `writeJSONAtomic` — atomic JSON writes (temp + rename) used everywhere.
- `DATA_DIR` resolution (`CORTEX_DATA_DIR` override for desktop).
- Express app setup: `express.json({limit:"64mb"})`, static `public/`.
- Admin-toggleable network bind (`data/server.json`, `lanAccess`), `lanUrls()`,
  `bindServer()` — listens on 127.0.0.1 or 0.0.0.0.
- SPA fallback (`app.get("*")` → `public/index.html`).

### B. Accounts, sessions & multi-tenancy
- Users in `data/users.json` (scrypt-hashed pw + salt), sessions in
  `data/sessions.json` via `cortex_sid` HttpOnly cookie.
- `createUser`, `hashPassword`/`verifyPassword`, `publicUser`, `cleanFolders`,
  `parseCookies`, `userFromRequest`, `startSession`, `requireAdmin`.
- Per-user content stores (lazy, debounced persist): `storesFor(user)` →
  `projects, agents, roster, people, chats, memory, mcp, mcpSessions` +
  `kbDir`. `kbDirFor`, `projectKbDirFor`, `isKbDir`.
- Legacy single-tenant → multi-tenant migration (`migrateLegacyData`).
- **Folder grants / path guard** (default-deny disk access): `realResolve`,
  `grantedRoots`, `canAccessPath`, `guardPath`, `accessibleOnly`.
- Auth wall middleware (every `/api/*` except `/api/auth/*` needs a user).
- Routes: `GET /api/auth/me`, `POST /api/auth/setup`, `POST /api/auth/login`,
  `POST /api/auth/logout`, `GET/POST /api/users`, `PUT/DELETE /api/users/:id`,
  `POST /api/users/:id/password`, `GET/POST /api/auth/mcp-token`.

### C. Filesystem browsing & file serving
- `extOf`, `kindOf`, `fmtSize`, `fmtDate`, `describeFile`, `EXT`/`TEXTLIKE`/`MIME`.
- `GET /api/config`, `GET /api/browse` (folder picker), `GET /api/list`
  (gallery), `GET /api/fileinfo`, `GET /api/file` (byte streaming/range),
  `GET /api/thumb` (Jimp thumbnails, cached in `data/thumbs`).

### D. Chat history store
- `data/users/<id>/chats.json`, shape `{fileId:{sessionId:{…messages}}}`.
- `sessionSummary`. Routes: `DELETE /api/chats`, `GET /api/chats`,
  `GET /api/chats/:fileId`, `GET /api/chats/:fileId/:sessionId`,
  `PUT/PATCH/DELETE /api/chats/:fileId/:sessionId`.

### E. Long-term memory (per user, typed)
- Types preference/instruction (always injected) + fact/episode (top-K recall).
- `guessMemType`, `ensureMemoryReady`, `addMemory`, `sysInfoBlock`,
  `memoryBlock`, `memPublic`, constants (`MAX_MEMORIES`, `MEM_*`).
- Auto-distilled **episodes** from finished sessions (`scheduleEpisode`,
  `distillEpisode`, `EPISODE_*`) and **auto chat titles** (`scheduleTitle`,
  `generateTitle`, `cleanTitle`).
- Routes: `GET/POST /api/memory`, `PATCH/DELETE /api/memory/:id`,
  `DELETE /api/memory`.

### F. MCP client (connectors)
- Connect to external MCP servers per user: `mcpEnabled`, `mcpPublic`,
  `rememberSession`/`forgetSession`, `mcpConnect`, `getMcpClient`,
  `dropMcpClient`, `withMcp`, `mcpListTools`, `mcpCallTool`, `mcpClients` map.
- Routes: `GET/POST /api/mcp`, `PUT/DELETE /api/mcp/:id`, `POST /api/mcp/:id/test`.

### G. Text & document extraction
- `extractText`, `extractRaw` (txt/md/csv/json, docx via mammoth, pdf via
  pdf-parse + OCR fallback), `buildFileContext`.
- PDF OCR via mupdf rasterize → vision (`getMupdf`, `ocrPdf`, `getPdfOcr`,
  `pdfOcrStore`/`data/pdfocr.json`).

### H. Image understanding (vision)
- Vision captions stored as searchable text in `data/imagemeta.json`:
  `describeImage`, `visionReadB64`, `visionExtract`, `visionTranscribe`,
  `storedImageText`, `isImageFile`, `imageMeta`, `DESCRIBABLE_IMG`.
- Tags sidecar `data/tags.json`: `getTags`, `setTags`, `tagStore`.
- Routes: `GET /api/image/meta`, `POST /api/image/describe`, `POST /api/tag`,
  `POST /api/vision`.

### I. RAG engine (embeddings index + retrieval)
- `indexKey`/`indexPath`, disk index `data/index/<key>.json`, LRU `indexCache`.
- `chunkText`, `walkFiles`, `embed` (Ollama embed model), `indexFiles`,
  `buildIndex`, `buildFileIndex`, `indexedFiles`, `loadIndex`/`saveIndex`.
- Similarity: `dot`/`norm`/`cosine`, keyword `kwTerms`/`kwScore`, `retrieve`
  (cosine + MMR + keyword), constants (`EMBED_MODEL`, `CHUNK_*`, `MAX_*`).
- Routes: `GET /api/search`, `POST /api/index`, `GET /api/index`.

### J. Knowledge base (per-user uploads)
- `safeName`, multer `kbUpload`, `KB_OK`. Routes: `POST /api/kb/upload`,
  `DELETE /api/kb`, `POST /api/kb/add`.

### K. Projects (named workspaces)
- `findProject`, per-project KB dir + multer. Routes: `GET/POST /api/projects`,
  `PUT/DELETE /api/projects/:id`, `GET /api/projects/:id/kb`,
  `POST /api/projects/:id/kb/upload`, `DELETE /api/projects/:id/kb`.

### L. Custom agents
- `findAgent`, `cleanAgentTools`, `DEFAULT_AGENT_TOOLS`. Routes:
  `GET/POST /api/agents`, `PUT/DELETE /api/agents/:id`.

### M. Deep-work roster (multi-agent team)
- `rosterFor`, `GET /api/roster`, `PUT /api/roster/:kind`, `POST /api/roster/reset`.

### N. Perceptual hashing & related/duplicates
- `computeDHash`, `getPhash`, `hammingHex`, `mapLimit`, `warmPhashes`,
  `relatedImages`, `relatedFor`, `findFileOnDisk`, `phashStore`/`data/phash.json`.
- Routes: `GET /api/related`, `GET /api/duplicates`, `POST /api/duplicates/delete`.

### O. Batch operations
- `POST /api/extract` + `runExtraction` (~700 lines: multi-file structured
  extraction → tables/charts), `contentBasis`, `POST /api/batch/autotag`,
  `POST /api/batch/rename/suggest`, `POST /api/batch/rename/apply`.

### P. Photos: EXIF, geo, faces, people
- EXIF/GPS: `geoFor`, `geoStore`/`data/geo.json`, `GET /api/geo`, `GET /api/exif`.
- Faces: `faceStore`/`data/faces.json`, `FACE_SCAN_VERSION`, `faceDist`,
  `tagPhotos`, `personDescs`, `upsertPerson`. Routes: `GET /api/faces/list`,
  `POST/GET /api/faces`, `GET /api/faces/one`, `POST /api/faces/assign`,
  `POST /api/faces/assign-bulk`.
- People: `GET/POST /api/people`, `GET/PUT/DELETE /api/people/:id`.

### Q. Knowledge graph
- LLM-free entity graph over photos+docs: `extractEntities`, `getDocEntities`,
  `reverseGeocode` (+`placeNames`/`data/placenames.json`), `buildGraph`,
  `graphFor`, `ensurePhotoGeo`, `docExcerptsFor`, `graphRetrieve`,
  `entityStore`/`data/entities.json`, ENT/ORG constants.
- Routes: `GET /api/graph`, `GET /api/graph/entity`.

### R. Charts / structured rendering helpers (used by agent + extract)
- `numericCol`, `tableSpec`, `chartSpec`, `statSpec`, `looksDateSeq`,
  `chartHintOf`, `wantsVisual`, `seriesRenders`, `parseRecords`, `findRecords`,
  `rendersFromObjects`.

### S. LLM helpers
- `completeJSON`, `completeText`, `stripThink`, `fitCtx`, `snippetFor`,
  `buildProvenance`, `makeThinkSplitter`, `streamReport`.

### T. Web search (DuckDuckGo)
- `decodeEntities`, `stripTags`, `ddgRealUrl`, `ddgFetch`, `withRetry`,
  `ddgText`, `htmlToText`, `fetchPageText`, `ddgImages`.

### U. Agent / tool-calling core
- `TOOL_REGISTRY` + tool implementations (search_docs, find_text, list_files,
  read_file, query_csv, compare_files, find_related, image_tool, save_note, …),
  `agentToolDefs`, `agentToolMechanics`, `agentSys`, `execTool`,
  `ensureIndex`, `findIndexed`.
- Pipelines: `deepResearchPipeline`, `runAgentTurn`, `criticIsApproved`,
  `pickNextAgent`, `multiAgentPipeline`.
- Chat helpers: `wantsConversationRecap`, `histBudget`, `compactHistory`,
  `chatImageRefs`, `resolveImageRef`, `materializeChatImage`,
  `wantsVisual`/recap regexes.
- Routes: `POST /api/agent` (streaming SSE, ~380 lines), `POST /api/chat`,
  `POST /api/agent/approve`, `POST /api/upload`.

### V. Models / health / setup
- `GET /api/models`, `GET /api/health`, `GET /api/setup/status`,
  `POST /api/ollama/pull` (first-run model pull), Ollama constants.

### W. Admin
- `GET/PUT /api/admin/server` (lan toggle), `GET /api/admin/indexes`,
  `DELETE /api/admin/index`, `GET /api/admin/images`, `DELETE /api/admin/image`,
  `DELETE /api/account/data`.

### X. MCP server mode (expose our KB to external clients)
- `MCP_EXPOSED`, `makeMcpServer`, `POST /mcp` (bearer-token, stateless
  Streamable-HTTP), `GET/DELETE /mcp` (405).

---

## 2. Target architecture

Keep it CommonJS. Introduce a `src/` tree; `server.js` becomes a thin
~60-line bootstrap that wires modules together and calls `bindServer()`.

```
server.js                      # bootstrap: build app, mount routers, listen
src/
  config.js                    # env constants, DATA_DIR, OLLAMA_*, PORT/HOST
  util/
    json-store.js              # writeJSONAtomic + makeSidecar(file) helper
    files.js                   # extOf, kindOf, fmtSize, fmtDate, EXT/MIME/TEXTLIKE
  state/                       # all module-level stores, each self-persisting
    sidecars.js                # tags, imageMeta, phash, geo, faces, entities,
                               #   placenames, pdfocr  (path-keyed shared stores)
    user-stores.js            # storesFor, kbDirFor, projectKbDirFor, isKbDir
  auth/
    accounts.js                # users/sessions, createUser, password, migration
    access.js                  # folder grants: canAccessPath, guardPath, …
    middleware.js              # auth wall, requireAdmin
    routes.js                  # /api/auth/*, /api/users/*
  llm/
    ollama.js                  # completeText/JSON, embed, stripThink, fitCtx, models
    vision.js                  # describeImage, visionExtract/Transcribe, imagemeta
  rag/
    index.js                   # chunk/walk/embed/buildIndex/loadIndex/saveIndex
    retrieve.js                # cosine/mmr/keyword retrieve
    extract.js                 # extractText/Raw, buildFileContext, PDF OCR
  media/
    phash.js                   # dhash, related, duplicates helpers
    photos.js                  # geo, exif, faces, people helpers
    graph.js                   # knowledge graph build/retrieve, entities
    render.js                  # chart/table/stat spec helpers
  web/search.js                # DuckDuckGo helpers
  mcp/
    client.js                  # external MCP connectors
    server.js                  # /mcp server-mode (makeMcpServer)
  agent/
    tools.js                   # TOOL_REGISTRY + tool impls, execTool, agentSys
    pipelines.js               # deepResearch/runAgentTurn/multiAgent/compactHistory
  routes/
    browse.js  chats.js  memory.js  kb.js  projects.js  agents.js
    roster.js  images.js  search.js  related.js  duplicates.js  batch.js
    photos.js  graph.js  mcp.js  admin.js  agent.js  chat.js  health.js
```

Wiring contract:
- Each `routes/*.js` exports `function mount(app, deps)` (or an Express
  `Router`). `deps` is a single object carrying shared services
  (stores, llm helpers, access guards) so we avoid a tangle of imports.
- Stores in `src/state/*` each own their file path, in-memory object, and
  debounced `persist()` — exported as a small object, not loose globals.
- `src/config.js` is imported by everything; no other module reads `process.env`.

---

## 3. Step-by-step plan (each step independently runnable & verifiable)

> After **every** step: `npm start` boots clean, `node eval/run.js` (or the
> smoke checks in §5) pass, and `git diff` is reviewed. Commit per step.

**Step 0 — Safety net (prep)**
- [x] Snapshot `server.baseline.js` (done).
- [ ] Add a smoke-test script (`scripts/smoke.sh`, see §5) that boots the
  server and curls a representative route from each feature group.
- [ ] Update **`eval/run.js`** to symlink/copy `src/` alongside `server.js`,
  and **`electron/main.js`** dev-watcher to watch `src/` recursively, and
  **`package.json` build.files** to include `src/**/*`. Do this *first* so the
  harness keeps working as soon as the first module is extracted.

**Step 1 — Pure leaf utilities (zero state, zero deps).**
Extract `config.js`, `util/json-store.js` (`writeJSONAtomic`),
`util/files.js` (extOf/kindOf/fmtSize/fmtDate/EXT/MIME/TEXTLIKE),
`media/render.js`, `web/search.js`, `llm/ollama.js` text helpers
(`stripThink`, `fitCtx`, `snippetFor`, `decodeEntities`, `stripTags`).
These have no inbound coupling → lowest risk first.

**Step 2 — State modules (sidecars).** ✅ DONE. Moved the 8 path-keyed sidecar
stores (`tags/imageMeta/phash/geo/faces/entities/placenames/pdfocr`) into
`state/sidecars.js`, each a shared-by-reference object with its own load +
debounced atomic persist (exact delays/error-logging preserved). Also moved
`DATA_DIR` into `config.js`. `storesFor`/`kbDirFor`/etc (`user-stores`) were
deferred to **Step 3 (auth)** since they're coupled to `USERS_DIR`, legacy
migration, and access guards.
Gotcha found & fixed: the eval sandbox symlinks `src/`, and Node resolves the
symlink to the real path, so `config.js`'s `__dirname` pointed at the real repo
→ `DATA_DIR` escaped the sandbox. Fix: `eval/run.js` now sets `CORTEX_DATA_DIR`
to the sandbox data dir explicitly.

**Step 3 — Auth + user-stores (state/helpers/middleware).** ✅ DONE.
Extracted `state/user-stores.js` (`storesFor`/`kbDirFor`/`projectKbDirFor`/
`isKbDir` + `USERS_DIR`), `auth/accounts.js` (users/sessions state + all
helpers + `migrateLegacyData`), `auth/access.js` (folder-grant guards), and
`auth/middleware.js` (`authWall` + `requireAdmin`). Re-bound via destructuring;
`app.use(authWall)` replaces the inline middleware.
- `users`/`authSessions`/`userStores` are exported by reference and mutated in
  place. The lone reassignment (`DELETE /api/users/:id`: `users = users.filter`)
  was changed to an in-place `users.splice` — verified delete stays consistent
  across the module boundary (login of a deleted user → 401).
- **Routes stay in server.js for now.** The `mount(app, deps)` router pattern is
  deferred to a dedicated route-extraction phase (introduced on a simpler route
  group first), keeping this step's risk consistent with steps 1–2.

**Step 4 — Content layer: vision + text extraction.** ✅ DONE.
Extraction depends on vision (image OCR), so vision came first.
- Moved `DESCRIBABLE_IMG`/`isImageFile` into `util/files.js` (file-kind checks).
- `src/llm/vision.js` — `storedImageText`, `describeImage`, `visionReadB64`,
  `visionExtract`, `visionTranscribe` (self-contained: config + sidecars only).
- `src/rag/extract.js` — `getMupdf`, `ocrPdf`, `getPdfOcr`, `extractText`,
  `extractRaw`, `buildFileContext` (imports vision). `mammoth`/`pdf-parse`
  requires moved here and dropped from server.js.

**Step 5 — RAG search layer.** ✅ DONE.
- `src/rag/index.js` — index constants + LRU cache, `indexKey`/`indexPath`,
  `loadIndex`/`saveIndex`, `chunkText`/`walkFiles`/`embed`, `indexFiles`/
  `buildIndex`/`buildFileIndex`/`indexedFiles` (`embed` lives here for now).
- `src/rag/retrieve.js` — `dot`/`norm`/`cosine`, `kwTerms`/`kwScore`, `retrieve`
  (imports `loadIndex`/`embed` from index). No circular deps.
Note: server.js has a separate local `norm` (memory dedup) — left untouched;
only `cosine`/`KB_THRESHOLD`/`INDEX_DIR`/`indexPath`/`retrieve`/`embed`/index
builders are re-bound (the math/keyword internals stay in the modules).
(`routes/search.js` deferred to the route-extraction phase.)

**Step 5 — Vision + KB + projects + agents + roster.** `llm/vision.js`,
then `routes/{kb,projects,agents,roster,images}.js`.

**Step 6 — Media layer.** ✅ DONE (3 sub-commits; routes kept in server.js).
- 6a `src/util/concurrency.js` (mapLimit) + `src/media/phash.js`
  (computeDHash/getPhash/hammingHex/warmPhashes/relatedImages/relatedFor,
  DUP_EXACT/DUP_NEAR). `findFileOnDisk` stays in server.js (agent helper).
- 6b `src/media/photos.js` (geoFor, faceDist, tagPhotos, personDescs,
  upsertPerson, FACE_SCAN_VERSION).
- 6c `src/media/graph.js` (reverseGeocode, entity NER, buildGraph/graphFor +
  graphCache, ensurePhotoGeo, docExcerptsFor, graphRetrieve).
Eval barely exercises this layer, so each sub-step added a targeted unit test
(phash dHash/hamming, faceDist 3-4-5, geoFor) alongside smoke. graphRetrieve is
on the chat path, so eval covers it.

**Step 7 — LLM completions + MCP client + memory.** ✅ DONE (routes kept in server.js).
- `src/llm/ollama.js` — completeJSON, completeText (config + util/text only).
- `src/mcp/client.js` — connector helpers (mcpEnabled/mcpPublic/mcpConnect/
  getMcpClient/withMcp/mcpListTools/mcpCallTool + session tracking + mcpClients).
- `src/llm/memory.js` — typed long-term memory (addMemory/memoryBlock/
  ensureMemoryReady/sysInfoBlock), episodic distillation (scheduleEpisode/
  distillEpisode), auto chat titles (scheduleTitle/generateTitle/cleanTitle).
  Inlined the one findAgent call (storesFor(user).agents.find) to avoid a
  cross-module dep. sessionSummary stays in server.js (chat-route helper).
(Browse/chats/memory/mcp *routes* deferred to the route-extraction phase.)

**Step 8 — Batch document helpers.** ✅ DONE.
`src/rag/extract-batch.js` — `runExtraction` (multi-file structured extraction →
table; used by /api/extract AND the agent's extract tool) + `contentBasis`
(autotag/rename reasoning text). NOTE: `runExtraction` is only ~27 lines — the
"~700-line beast" in the baseline was actually `TOOL_REGISTRY` sitting between
it and `agentToolDefs` (that's the agent core, step 9). `AUTOTAG_SYS` and the
batch routes stay in server.js.

**Step 9 — Agent core.** ✅ DONE. Extracted the whole agent subsystem into one
cohesive `src/agent/core.js` (1,350 lines) — the tool registry + tool impls +
execTool, the system-prompt/tool-def builders, the trust layer (VERIFY_SYS),
the deep-research & multi-agent pipelines, and the chat-image attachment helpers
(findFileOnDisk + chatImageRefs/resolveImageRef/materializeChatImage). Done as
ONE module (not split tools/pipelines) because the three regions are mutually
referential; one file avoids intra-cluster import cycles. `safeName` moved to
util/files. Routes (/api/agent, /api/chat, /api/agent/approve, /api/upload) and
chat helpers (compactHistory etc.) stay in server.js.
Regression caught by eval: RETRIEVAL_TOOLS/ROSTER_DEFAULTS (internal tool-group
consts the routes reference) weren't exported → 2/12; added exports → 12/12.

**Step 10 — MCP server mode.** ✅ DONE. `makeMcpServer` + `MCP_EXPOSED` →
`src/mcp/server.js` (imports TOOL_REGISTRY/execTool from agent/core, kbDirFor).
The /mcp routes + admin/health/setup/ollama-pull endpoints are routes → stay in
server.js (route-extraction phase). Verified by the smoke `mcp tools/list` check
(drives makeMcpServer end-to-end) + eval 12/12.

**Steps 11–12 — Finalized (route extraction NOT done, by decision).**
The optional full route-extraction phase (move all 97 handlers into routes/*.js
via mount(app, deps)) was deliberately skipped: it mostly relocates already-thin
handlers and adds deps-plumbing risk, with all business logic already modular.
`server.js` is left as a clean **HTTP/routes + bootstrap layer (~2,180 lines)**.

Finalization done: dead `./src` imports pruned from server.js (45 removed),
`server.baseline.js` deleted (parity proven — see §4), plan marked complete.

### ✅ FINAL RESULT
- **server.js: 4,978 → ~2,180 lines (−56%) at the time this refactor finished.**
  Current `server.js` is back up to ~2,480 lines — that's *new routes added since*
  (skills/profile/jobs from `LEARNING-LOOP-PLAN.md`, image create/edit, etc.),
  not incomplete extraction; verified the `src/` module count and structure below
  are still intact.
- All heavy logic in **25 `src/` modules**.
- **Route parity:** 97/97 endpoints identical to baseline.
- **Function parity:** all 260 baseline top-level names resolve in server.js or src/.
- **Behavior:** smoke 21/21, eval 12/12 at every step (matches the captured baseline).
- **No circular deps.** HTTP API + on-disk data formats unchanged throughout.

---

## 4. Final verification (prove nothing was lost)

1. **Route parity:** `grep -oE 'app\.(get|post|put|delete|patch)\("[^"]+"'
   server.baseline.js | sort -u` vs the union of all `routes/*.js` + `server.js`
   + `mcp/*`. Must match exactly (same method+path set).
2. **Function parity:** every function name in §1 inventory resolves to exactly
   one definition somewhere in `src/`.
3. **Data-format parity:** all the `data/*.json` filenames and the index/thumbs
   dirs are still produced with identical shapes (the constants moved, not
   their values).
4. **Behavioral:** `node eval/run.js` golden suite passes (same pass rate as on
   `server.baseline.js` — run it on the baseline first to capture the number).
   **Baseline captured 2026-06-27: 12/12 (100%)** on
   `fredrezones55/Gemma-4-Uncensored-HauhauCS-Aggressive:latest`. Every step must
   keep this at 12/12.
5. **Smoke:** `scripts/smoke.sh` green.
6. **Desktop:** `npm run desktop` boots; dev auto-restart still fires on edits
   under `src/`.

## 5. Smoke checks (representative endpoint per group)

`/api/health`, `/api/auth/me`, `/api/config`, `/api/browse`, `/api/list`,
`/api/search`, `/api/chats`, `/api/memory`, `/api/projects`, `/api/agents`,
`/api/roster`, `/api/people`, `/api/graph`, `/api/duplicates`, `/api/models`,
and a `POST /mcp` tools/list with a bearer token.

---

## 6. Guardrails / non-goals

- **No behavior changes.** This is a pure move-and-rewire. No new features, no
  signature changes to HTTP routes, no data-format changes. Bug fixes spotted
  along the way get noted, not silently applied.
- Keep CommonJS + dynamic `import()` for ESM-only deps.
- Prefer a `deps` object over deep import graphs to keep wiring explicit.
- Commit per step; never let `main` sit in a half-extracted, non-booting state.
