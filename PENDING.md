# Pending — everything confirmed NOT built yet

Consolidated from the 2026-07-02 audit of every plan doc in the repo
(`ROADMAP.md`, `LEARNING-LOOP-PLAN.md`, `PEOPLE-ALBUMS-PLAN.md`,
`SERVER-REFACTOR-PLAN.md`, `UI-REFACTOR-PLAN.md`, `FEATURE-COMPARISON.md`),
cross-checked against actual code — not just what the docs claim. Everything
below was verified absent (grepped for the relevant function/route/file and
found nothing) or explicitly noted as partial.

## Foundation / safety

- **Trash + undo** — deletes (KB, batch, duplicates) are still hard `rm`; no `data/.trash/` + undo toast + 30-day sweep.
- **`.env` hygiene** — `.env` is currently tracked in git (confirmed via `git ls-files`). Check it for secrets, then `git rm --cached .env` + add to `.gitignore` + commit `.env.example`.
- **Unit tests for pure helpers** — `chunkText`, `numericCol`, `buildProvenance`, `hammingHex`, `parseRecords` have no `node --test` coverage.
- **Database** — deliberately deferred; JSON stores are fine at current scale (not a real gap, just a documented non-goal until KB size grows).

## Personal assistant / agent

- **Remaining agent items** — connector result cap, context-overflow guard/compaction, research-mode scratchpad, tool-arg schema validation.
- **Finance copilot** — Money view combining the Kite MCP connector, receipt/statement extraction, chart/KPI renderers.
- **Conversation importers** — WhatsApp (.txt), email (.mbox), Apple Notes → searchable KB documents grouped per contact.
- **Reminders & tasks** — natural-language reminders, local macOS notifications (`osascript`), sidebar upcoming-list.
- **Voice mode** — push-to-talk via whisper.cpp + replies via macOS `say`. The single biggest modality gap vs. ChatGPT/Claude (see `FEATURE-COMPARISON.md`).
- **Smart inbox** — `fs.watch` on chosen folders; auto-describe/tag/rename/file new files per natural-language rules.
- **Follow-up chips** — 2-3 clickable suggested follow-up questions after each agent answer.

## Knowledge tool / ingestion

- **Flashcards / study mode** — Q&A card generation from a document + spaced-repetition review.
- **Read-later library** — *partial*: `read_url` (agent tool) fetches/reads pages on demand, but nothing persists the article into `KB/Reading/` with auto-summary/tags yet.
- **YouTube/podcast ingestion** — transcript via optional `yt-dlp` → indexed and chat-able. Zero `yt-dlp` references in the codebase — not started at all.
- **Report writer** — `write_document` agent tool producing a cited markdown report; "Export as report" on deep-research answers.

## Photos & media

- **Timeline view** — gallery grouped by month/year (EXIF date-taken), scrubber, "On this day" row.
- **Smart albums** — saved semantic searches pinned in the sidebar as virtual albums; `create_album` tool.
- **Places view** — cluster geotagged photos by GPS proximity (offline grid clustering). Distinct from the shipped Photo Map (`map.jsx`), which plots individual markers but doesn't cluster.
- **Video search** — keyframes via optional `ffmpeg` → vision descriptions → index.
- **Audio transcription** — optional `whisper-cli` → searchable transcripts.
- **Auto-OCR screenshots** — detect screenshot-like images, auto-index their text via `visionTranscribe`.
- **Static album export** — self-contained HTML gallery file (thumbnails inlined), shareable without a server.

## Product / ecosystem

- **Ship it** — package as a desktop app / Docker image, README demo GIF, publish.
- **Plugin system** — load user tools from `data/tools/*.js` into `TOOL_REGISTRY` at startup.
- **Mobile-responsive layout** — UI is desktop-first; needs a responsive pass (collapsible nav, single-column gallery, full-width chat).
- **Grow the MCP server** — `src/mcp/server.js`'s exposed tool list is unchanged from the original set; `find_duplicates`, `autotag`, `extract_table` still aren't exposed over `/mcp`.

## Competitor-parity gaps (from `FEATURE-COMPARISON.md`, not on ROADMAP yet)

- **Live web search as a first-class default tool** (vs. ChatGPT/Claude) — a `web_search` tool exists but isn't a simple always-on toggle the way the competitors frame it.
- **Canvas / artifacts** — a side-by-side editable output pane; chat here is linear only.
- **Shareable chat links / export** — no way to export or share a conversation.
- **Code execution sandbox** — no general sandboxed interpreter (Cortex's tools are file/KB-oriented).
- **Multiple model backends** — Ollama-only; no OpenAI/Anthropic fallback like Open WebUI offers.
- **RAG citation highlighting** — sources are cited but not visually anchored to the retrieved passage.

---

## Confirmed already shipped (so you don't re-propose these)

People/face recognition, Photo Map, Knowledge graph, typed + episodic memory,
Skills, Profile ("what Cortex knows about you"), Reflection, Scheduler/digests
(feed + note + desktop notify), Projects, Custom agents, Deep-work multi-agent
roster, DrawThings image gen (create + edit), Multi-tenant login + RBAC folder
grants, Duplicate finder, Batch AI actions (Ask AI / Auto-tag / Smart rename),
MCP server mode (base tool set), Phone/PWA access, esbuild + ES-modules
frontend rebuild, server.js → `src/` module split.
