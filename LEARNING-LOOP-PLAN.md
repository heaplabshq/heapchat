# Learning Loop & Proactive Agent — Implementation Plan

> **Status (verified against code):** Part A (Skills, Profile, Reflection) and
> Part B (Scheduler) are **fully shipped** — `src/llm/skills.js`, `src/llm/profile.js`,
> `reflectOnSession` in `src/llm/memory.js`, `src/agent/scheduler.js`, all their
> routes (`/api/skills`, `/api/profile`, `/api/jobs`), and UI in `manage.jsx`/`activity.jsx`.
> Part C is **partial**: `read_url` (agent tool, on-demand page fetch) is shipped,
> but there's no persisted "read-later" KB flow and **no YouTube/yt-dlp ingestion at all**
> (zero references in the codebase) — that's the one item left from this whole plan.
>
> Inspired by **Hermes Agent** (Nous Research) and **Open WebUI**, scoped to what
> fits Cortex's local-first architecture. The headline focus (your call) is a
> **persistent memory + learning loop that builds a deepening model of you across
> sessions**. Scheduling and ingestion are the proactivity/throughput layers that
> make that loop visible and useful.
>
> Companion to [AGENT-MEMORY.md](AGENT-MEMORY.md) (the shipped typed/episodic
> memory design) and [ROADMAP.md](ROADMAP.md) (lists "Scheduled digests" and
> "YouTube ingestion" as TODO — this plan fleshes them out).

---

## 0. Where Cortex already is (don't rebuild this)

The hard parts of the learning loop are **already shipped** (AGENT-MEMORY.md, ROADMAP "Personal assistant"):

- **Typed memory** — `preference` / `instruction` (always injected) + `fact` / `episode` (top-K retrieved by embedding similarity). Supersede via LLM arbitration, usage-based eviction, provenance. All in `src/llm/memory.js`, stored at `data/users/<id>/memory.json` via `storesFor(user)` (`src/state/user-stores.js`).
- **Episodic distillation (the existing learning loop)** — `scheduleEpisode()` arms a per-session idle timer; `distillEpisode()` turns a finished real task (≥4 user turns) into one reusable "past task" sentence. This is already a learn-from-experience loop.
- **`remember` agent tool** (`src/agent/core.js` ~L442) writes durable user facts/prefs; `memoryBlock()` injects the relevant slice each turn.
- **Per-session timer pattern** — `episodeTimers` / `titleTimers` Maps keyed `userId:fileId:sessionId` (memory.js). Reuse this pattern for any new "after idle" work.
- **Stores pattern** — `storesFor(user)` loads `*.json` once; `st.save("name.json")` debounces persist. Add a new store by adding a key in `user-stores.js`.

**Gap vs Hermes:** Cortex learns *facts and lessons* but has no concept of (a) reusable **skills** (how-to procedures it can re-apply), nor (b) a synthesized **user profile** (the "deepening model of you" — today memory is a flat list, never consolidated into a picture). Those two are Part A below.

---

## Part A — Persistent memory + learning loop (PRIMARY)

Three additions, smallest/safest first. All per-user, local, no new deps.

### A1. Skills — reusable procedure memory (the core Hermes idea)

A *skill* is distinct from a fact/episode: it's a **how-to** the agent wrote after
solving something ("how to reconcile the monthly statement from my bank PDFs"),
that it can find and re-apply later instead of re-deriving.

- **Store:** new `skills.json` in `user-stores.js` (`skills: load("skills.json", [])`, add to the `save` map). Entry shape:
  ```
  { id, title, steps: "markdown how-to", tags: [..], trigger: "when to use this, one line",
    vec, source, createdAt, updatedAt, lastUsedAt, useCount, successCount }
  ```
  `vec` = embedding of `title + "\n" + trigger` (so retrieval matches on *when to use*, like memory's read path). Reuse `embed()` from `src/rag/index`.
- **Module:** `src/llm/skills.js` mirroring `memory.js` — `addSkill`, `updateSkill`, `findSkills(query, k=3)` (cosine over `vec`, floor ~0.45), `skillsBlock(query)` (compact injected list: title + trigger only, NOT full steps — steps fetched on demand to save context).
- **Agent tools** (register in `src/agent/core.js` TOOL_REGISTRY next to `remember`):
  - `save_skill({ title, steps, trigger, tags })` — write/update a skill. Gate like `remember`: only durable, reusable procedures, never one-offs.
  - `recall_skill({ query })` — return matching skills' full `steps`. (Cheap; the always-injected `skillsBlock` only lists titles+triggers, so the model calls this to expand the one it needs.)
- **Auto-capture (the loop):** extend `distillEpisode()` (or a sibling `distillSkill()`) — when a finished session solved a *procedural, repeatable* task, emit a skill instead of/in addition to an episode. One model call, JSON `{skill:{title,steps,trigger}}|null`, behind the same promotion gate. Bump `successCount`/`lastUsedAt` when a recalled skill is used in a later session.
- **Prompt wiring:** add `skillsBlock(query)` to the agent system prompt assembly alongside `memoryBlock()` (find where `memoryBlock` is concatenated in `src/agent/core.js`). Keep it tiny (titles+triggers, ~budget 800 chars).
- **UI:** a "Skills" section in the existing memory/manage surface — reuse the `GET/POST /api/memory` route style (`server.js` ~L1194). Add `GET /api/skills`, `POST /api/skills`, `DELETE /api/skills/:id`. Frontend: a small `skills.jsx` view (or a tab in settings/manage), following the global-eval module convention (see `frontend-build-and-ui-refactor` notes / `build/esbuild.mjs` ORDER).
- **agentskills.io compatibility (optional, later):** Hermes uses an open skill format. Export/import skills as Markdown-with-frontmatter so they're shareable. Defer until A1 core works.

### A2. User profile — the "deepening model of you"

Today memory is a flat list; there's no consolidated picture. Synthesize one.

- **Store:** `profile.json` (single object), e.g. `{ summary, traits: {...}, updatedAt, sourceCount }`. `summary` = a few sentences ("Sid is a developer building Cortex; prefers concise, opinionated answers with code; works in IST; …").
- **Builder:** `src/llm/profile.js` → `rebuildProfile(user)` — one model call over the user's `preference`+`instruction`+top `fact` memories (and recent episode titles) → a compact structured profile. Cap input; low temp.
- **When it runs:** debounced + cheap. Trigger `scheduleProfileRebuild(user)` from `addMemory()` when a `preference`/`instruction` is added/superseded, and on a daily idle tick. Reuse the timer-Map pattern. Never on every message.
- **Read path:** inject the profile `summary` as a short stable block at the *top* of the agent system prompt (it's small and changes rarely → good for Ollama's cached prefix; see the `sysInfoBlock` cache note in memory.js). `memoryBlock` still adds the per-question facts.
- **UI:** show the profile (editable) in the memory view — "What Cortex knows about you", with a Rebuild button (`POST /api/profile/rebuild`). Transparency matters; let the user correct it.

### A3. Tighten the loop (reflection)

- After a session distills (A1/A2 hooks already fire on idle), optionally run a tiny **reflection**: "did any existing skill/memory prove wrong or get improved?" → supersede via the existing `addMemory` supersede path / `updateSkill`. Keep it one call, gated, off by default behind a setting.
- **Decay/quality:** skills with low `successCount` and old `lastUsedAt` evict first (mirror memory's eviction in `memory.js` ~L79). Surfacing `useCount` in the UI builds trust.

**Why this is safe to build:** it extends shipped, well-tested machinery (typed memory, episodic distillation, the timer pattern, the store pattern) rather than inventing infra. Each piece degrades gracefully (embeddings/model unavailable → skip), exactly like `memory.js` already does.

---

## Part B — Scheduled agents / digests (proactivity + delivery)

Hermes's headline feature; ROADMAP already lists "Scheduled digests". Turns Cortex
from reactive to proactive. Build on the agent core + custom agents.

- **Store:** `jobs.json` per user. Entry: `{ id, name, agentId|null, scope, prompt, cron|interval, nextRunAt, lastRunAt, lastResult, enabled, deliver: ["feed","notify","note"] }`.
- **Runner:** a single process-wide ticker (one `setInterval` ~60s in a new `src/agent/scheduler.js`, started from `server.js` bootstrap). On each tick: for every user's enabled job whose `nextRunAt ≤ now`, run the saved agent (reuse the `/api/agent` core path — factor the agent-run into a callable so both the route and scheduler share it), capture the result, compute `nextRunAt`. Keep concurrency 1 (single local GPU — see the "summaries serialize through the single local GPU" note in ROADMAP). Use a tiny cron parser or just interval presets (daily/weekly/hourly) to avoid a dep.
- **Delivery:**
  - `feed` — append to a `digests.json` / activity feed shown in a new sidebar "Activity" view.
  - `note` — `save_note` into the KB (already a tool) so it's searchable.
  - `notify` — desktop notification via the Electron bridge (`window.cortex`); add a `notify` channel to `electron/main.js` + preload, mirroring the existing `onAction`/`onIngestFiles` subscriptions (see `app.jsx` desktop-bridge effects).
- **UI:** "Schedules" manager (reuse the agent/project edit-modal pattern — `modals.jsx` style). Create from a saved custom agent + a prompt + a cadence.
- **Safety:** scheduled runs must NOT auto-approve destructive actions — the approve-before-destructive card (`/api/agent/approve`) means destructive tool calls in a headless run should be skipped/queued, not executed. Add a `headless` flag to the agent run that disables write tools (or queues approvals to the feed).

---

## Part C — Ingestion quick wins (from Open WebUI)

Cheap, high-utility, feed the KB/RAG you already have. Both are on ROADMAP.

- **URL → KB ("read-later"):** `read_url` agent tool + a paste box. Fetch page, extract main text (reuse `src/rag/extract.js`; add a simple HTML→text path), auto-summarize + tag, store in `KB/Reading/`. Offline after fetch, searchable.
- **YouTube transcript → KB:** paste a link → transcript via **optional** `yt-dlp` (graceful "install yt-dlp to enable" if absent, matching how mermaid/optional deps are handled) → indexed and chat-able.
- (Open WebUI also has many OCR extractors; Cortex already has vision OCR — skip unless a specific format is needed.)

---

## Verification

- **Backend:** extend the eval harness (`npm run eval`, ROADMAP-shipped) with skill/profile fixtures; `scripts/smoke.sh` for the new routes. Memory-style modules are pure-ish and unit-testable.
- **UI:** the `scripts/ui-smoke.mjs` harness (6 routes; build + headless Chrome) covers new views' render; add the new routes to its ROUTES list. Skills/Activity views render with empty stores in smoke.
- **Loop correctness** needs real interaction — drive a multi-session scenario (teach a preference → confirm it lands in profile; solve a task → confirm a skill is captured → new session recalls it) with the `/verify` skill.

---

## Data & migration

- New stores (`skills.json`, `profile.json`, `jobs.json`, `digests.json`) all default-empty via `load(name, default)` in `user-stores.js` — no migration needed; absent files just start empty.
- Everything per-user under `data/users/<id>/`, fully local. No new network deps (yt-dlp optional).

---

## Implementation order (each step shippable + verifiable)

1. ✅ **A1 Skills — store + module + tools + prompt wiring** — DONE.
2. ✅ **A1 Skills — auto-capture** (extend `distillEpisode`) + **A1 UI** — DONE.
3. ✅ **A2 User profile** — builder + read-path injection + UI ("what Cortex knows about you") — DONE.
4. ✅ **B Scheduler** — store + runner + `feed` delivery + UI, plus `note` + desktop `notify` — DONE.
5. **C Ingestion** — `read_url` DONE (on-demand fetch tool); the persisted read-later KB flow and YouTube (yt-dlp) transcript ingestion are **NOT started**.
6. ✅ **A3 Reflection** + skill decay/quality polish — DONE.

**What's actually left from this doc: Part C only** — a persisted "save this URL to KB/Reading/" flow, and YouTube/podcast transcript ingestion via optional yt-dlp.

Steps 1–3 deliver the emphasized "memory + learning loop / deepening model of you".
Step 4 makes it proactive. Step 5 feeds it more to learn from.

## Non-goals / guardrails
- Stay fully local/offline; no telemetry, no cloud lock-in (Cortex's existing stance, and Hermes's too).
- No behavior change to the shipped memory read/write paths — only additive stores + blocks.
- Don't let headless/scheduled runs perform destructive file actions without approval.
- Keep injected blocks tiny (cached-prefix friendly); expand-on-demand via `recall_skill` rather than dumping everything.
