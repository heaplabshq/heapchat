# Cortex Roadmap

Ideas parked for later, roughly ordered by value-to-effort within each theme.
(✅ = already shipped: duplicate finder, AI batch actions — Ask AI / Auto-tag / Smart rename — and MCP server mode at `/mcp`.)

## Now

- [x] **Login + multi-tenant** — accounts, sessions, per-user KB/chats/memory/connector isolation; per-user MCP bearer tokens; first-run setup migrates legacy data to the admin account. (Shipped.)
- [x] **RBAC folder grants** — default-deny disk access for members; admins grant per-user folder roots, enforced server-side on every path endpoint. (Shipped.)

## Foundation (perf & safety fixes)

- [x] **Admin network toggle** — Settings → Network access flips the bind between loopback and LAN live (data/server.json), no restart. (Shipped.)
- [ ] **Database** — deliberately skipped for now: JSON stores are fine at this scale. Revisit with SQLite (better-sqlite3 + sqlite-vec) only if the KB passes a few thousand documents or indexes hit ~100MB; first try binary vector encoding below.

- [x] **Range support in `/api/file`** — `res.sendFile` with Range + ETag/304 revalidation. (Shipped.)
- [x] **Thumbnail endpoint** — `/api/thumb` via Jimp, cached to `data/thumbs/` by path+mtime+width, immutable caching; gallery/citations/related strips all use it. (Shipped.)
- [ ] **Trash + undo** — route all delete surfaces (KB, batch, duplicates) through a `data/.trash/` move with an Undo toast and a 30-day sweep, instead of hard `rm`.
- [x] **Build step for the frontend** — esbuild bundle instead of in-browser Babel; frontend also fully migrated to real ES modules (`import`/`export`) with esbuild bundling them into `public/app.js`. See [UI-REFACTOR-PLAN.md](UI-REFACTOR-PLAN.md). (Shipped.)
- [ ] **`.env` hygiene** — `git rm --cached .env`, add to `.gitignore`, commit `.env.example`. **Still open — `.env` is currently tracked in git** (confirmed via `git ls-files`); worth doing soon if it holds any secrets.
- [x] **Raise the 8MB JSON limit for dragged-in images** — `express.json({ limit: "64mb" })` in `server.js`. (Shipped.) Client-side downscale-before-send was not done, but the server-side blocker is gone.
- [ ] **Unit tests for the pure helpers** — `chunkText`, `numericCol`, `buildProvenance`, `hammingHex`, `parseRecords` with `node --test`.

## Personal assistant

- [x] **Typed agent memory (phases 1–3)** — typed entries, selective top-k retrieval, LLM-arbitrated supersede, usage-based decay ([AGENT-MEMORY.md](AGENT-MEMORY.md)). (Shipped.)
- [x] **Episodic memory (phase 4)** — idle sessions distill into "past task" entries behind a promotion gate. (Shipped.)
- [x] **Agent loop upgrades** — hybrid keyword+vector retrieval in search_docs, parallel tool execution, ask_user clarification tool. (Shipped.)
- [x] **Corrective retrieval (CRAG-lite)** — weak search_docs hits trigger one model query-rewrite + merged second pass. (Shipped.)
- [x] **Self-correction (Reflexion-lite)** — verification issues trigger one corrective regeneration, streamed as a revision, re-verified; verifier also attributes sources when the model doesn't cite filenames. (Shipped.)
- [x] **Eval harness** — npm run eval: sandboxed fixture KB + 12 golden questions scoring answers/grounding/sources; low-temp for reproducibility; per-model comparison. (Shipped.)
- [x] **Ollama keep-alive** — models stay resident 30m between calls; cold-load stalls gone. (Shipped.)
- [x] **Parallel deep research** — sub-question evidence gathering (web searches, page fetches, retrieval) runs concurrently; summaries serialize through the single local GPU. (Shipped.)
- [x] **Approve-before-destructive-actions** — agent delete/overwrite/rename pauses with an Approve/Cancel card in chat; nothing touches disk until the user approves (`/api/agent/approve`). (Shipped.)
- [x] **Chat attachments** — composer "+" menu: image (vision), files, or a whole folder; uploads land in `KB/Uploads/`, are injected as context, and always cited. (Shipped.)
- [x] **Composer redesign** — unified ChatGPT/Claude-style input card: attach button, Search/Research/Deep research/Think pills, model picker and round send button in one toolbar. (Shipped.)
- [ ] **Remaining agent items** — connector result cap, context-overflow guard/compaction, research-mode scratchpad, tool-arg schema validation.

- [ ] **Finance copilot** — a Money view combining the Kite MCP connector (live portfolio), receipt/statement extraction (`extract_table`), and the existing chart/KPI renderers. Morning brief: markets, P&L, bills found in new documents.
- [ ] **Conversation importers** — ingest WhatsApp chat exports (.txt), email (.mbox), Apple Notes into the KB as searchable documents grouped per contact.
- [ ] **Reminders & tasks** — agent tool for natural-language reminders with local macOS notifications (`osascript`); upcoming-list in the sidebar.
- [ ] **Voice mode** — push-to-talk via whisper.cpp + replies via macOS `say`. Fully local voice assistant over your files.
- [ ] **Smart inbox (watched folders + rules)** — `fs.watch` on chosen folders; new files get auto-described, auto-tagged, smart-renamed, and filed per natural-language rules. Composes the shipped batch-AI pipeline.
- [x] **Scheduled digests** — `src/agent/scheduler.js` runs saved jobs on a cadence, delivers to a `digests.json` feed (Activity view), a KB note, or a desktop notification. See [LEARNING-LOOP-PLAN.md](LEARNING-LOOP-PLAN.md) Part B. (Shipped.)

## Knowledge tool

- [x] **Knowledge graph** — entity layer fusing photos + documents. Nodes = named people (face clusters), GPS places, autotags, and deterministic NER over indexed text; edges = co-occurrence. LLM-free build (chat model never called); per-doc entities cache by mtime in `data/entities.json`. `GET /api/graph` + `/api/graph/entity`, interactive force-directed view at sidebar → Knowledge graph (`graph.jsx`). Reset clears the entity cache + graph cache. (Shipped.)
- [ ] **Flashcards / study mode** — generate Q&A cards from any document; spaced-repetition review screen (single JSON store).
- [ ] **Read-later library** — paste URLs → `read_url` stores article text in the KB with auto-summary + tags. Offline, searchable Pocket. **Partial:** the `read_url` agent tool exists and fetches/reads pages on demand, but nothing persists the article into `KB/Reading/` with auto-summary/tags yet — still an open build.
- [ ] **YouTube/podcast ingestion** — paste a link → transcript via optional `yt-dlp` → indexed and chat-able. Confirmed not built — no `yt-dlp` references anywhere in the codebase.
- [ ] **Report writer** — `write_document` agent tool producing a cited markdown report into the KB; "Export as report" on deep-research answers.

## Photos & media

- [ ] **Timeline view** — gallery grouped by month/year from EXIF date-taken, scrubber, "On this day" row.
- [ ] **Smart albums** — saved semantic searches pinned in the sidebar as virtual albums; `create_album` agent tool.
- [ ] **Places view** — cluster geotagged photos by GPS proximity (offline grid clustering). Distinct from the shipped Photo Map (`map.jsx`), which plots individual markers on Leaflet but does not cluster by proximity — still open.
- [ ] **Video search** — keyframes via optional `ffmpeg` → vision descriptions → index. Reuses the image pipeline.
- [ ] **Audio transcription** — optional `whisper-cli` → transcripts become searchable documents.
- [ ] **Auto-OCR screenshots** — detect screenshot-like images, auto-index their text via `visionTranscribe`.
- [ ] **Static album export** — self-contained HTML gallery file (thumbnails inlined) to share without a server.

## Product / ecosystem

- [ ] **Ship it** — package as a desktop app (Tauri/Electron) with Ollama auto-detection, or a Docker image; README demo GIF; publish.
- [ ] **Plugin system** — load user tools from `data/tools/*.js` into `TOOL_REGISTRY` at startup.
- [x] **Phone access** — `HOST` env bind + PWA manifest/icons; login wall gates LAN exposure. (Shipped.)
- [ ] **Mobile-responsive layout** — the UI is desktop-first; on a phone the sidebar/gallery/chat need a responsive pass (collapsible nav drawer, single-column gallery, full-width chat).
- [ ] **Grow the MCP server** — expose `find_duplicates`, `autotag`, `extract_table` over `/mcp`; consider MCP resources for browsing KB files. Confirmed still open: `src/mcp/server.js`'s `MCP_EXPOSED` list is unchanged from the original set (`search_docs, find_text, list_files, read_file, query_csv, compare_files, find_related, image_tool, save_note`).
- [ ] **Follow-up chips** — after each agent answer, generate 2–3 suggested follow-up questions as clickable chips.
