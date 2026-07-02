# Agent Memory Architecture — Design Doc

*Status: phases 1–3 implemented (typed schema + migration, selective retrieval, LLM-arbitrated supersede + usage-based decay); phase 4 (episodic distillation) shipped — sessions idle 10 min with ≥4 user turns are distilled into "episode" entries behind a model promotion gate; chit-chat is rejected; respects the auto-memory setting. Based on Oracle's ["From RAG to Memory Systems: Building Stateful Architectures"](https://blogs.oracle.com/developers/from-rag-to-memory-systems-building-stateful-ai-architecture), adapted for a local-first, small-model app.*

## The core idea from the article

> "RAG is retrieval. Memory is a **write path + retrieval + governance loop**."

RAG answers "what do my documents say?" — a stateless lookup. A memory system answers "what does the agent *know* by now?" — it distills durable artifacts out of interactions, stores them by **type**, retrieves them **selectively**, and updates them when reality changes instead of stacking contradictions. The payoff the article claims, and the one that matters most for Cortex: **lower context overhead and better continuity**, because the agent stops reconstructing the same context from scratch every turn.

The article's five memory types: **policy** (rules, exact-match), **preference** (user settings, keyed lookup), **fact** (durable assertions with provenance, hybrid retrieval), **episodic** (summaries of completed tasks), **trace** (raw logs for audit). Its per-turn loop: append to trace → retrieve typed memory by scope → reassemble the prompt from memory (*"never accumulate transcript"*) → invoke → **promotion gate** decides what becomes durable.

## Where Cortex is today

| Component | Status |
|---|---|
| RAG | ✅ Strong — per-folder/KB vector indexes, incremental re-embed, MMR, grounding badge + self-verification |
| Trace memory | ✅ Effectively exists — full chat history per session (`chats.json`) |
| Preference/fact memory | ⚠️ One flat list (`memory.json`, 50-entry cap, plain strings) |
| Memory retrieval | ❌ **All 50 entries are injected into every prompt**, relevant or not |
| Episodic memory | ❌ None — the agent re-learns everything about a task every session |
| Provenance / updates | ⚠️ Dedup-by-substring only; no timestamps shown, no source chat, no supersede-on-contradiction |
| Decay / forgetting | ❌ Hard cap evicts oldest regardless of usefulness |

The biggest mismatch with the article is the read path: injecting the whole memory list costs precious context on a local model (`num_ctx` is small and expensive) and dilutes attention — the exact failure mode the article calls "reconstructing context from scratch every turn", just inverted: we pay for *all* context every turn whether needed or not.

## Proposal — what we adopt, what we skip

**Skip** (over-engineering for a local single-box app): policy-memory tables, multi-tenant DB schemas, LangGraph-style checkpointers, a separate memory service. Our JSON stores and per-user dirs already cover scoping.

**Adopt** four things, in order of value:

### 1. Typed memory entries

`memory.json` entries gain a `type` (existing entries migrate as `fact`):

```json
{
  "id": "m…",
  "type": "preference | fact | instruction | episode",
  "text": "Prefers short bulleted answers",
  "source": "auto | manual",
  "origin": { "chatId": "…", "sessionId": "…" },
  "createdAt": 0, "updatedAt": 0,
  "lastUsedAt": 0, "useCount": 0,
  "vec": [ /* nomic-embed embedding, stored once at write time */ ]
}
```

- **preference** — how the user likes answers (format, tone, units, language).
- **fact** — durable facts about the user (name, role, projects, family).
- **instruction** — standing orders ("always cite sources", "never delete without asking"). These are the local-app stand-in for the article's *policy memory*.
- **episode** — distilled task summaries (see §3).

### 2. Selective retrieval instead of dump-all (the read path)

Per agent request:
- **Always inject** (cheap, small): all `instruction` entries + all `preference` entries. These are the exact-match/keyed classes the article says should never be similarity-gated.
- **Retrieve by relevance**: embed the user's question (we already embed it for `search_docs` anyway), cosine against stored memory vectors, inject the **top 3–5 `fact`/`episode` entries above a floor** (~0.45). Memories used get `lastUsedAt`/`useCount` bumped.
- **Budget**: hard cap the whole memory block (~600 tokens). This *reduces* prompt size for most questions while making memory *more* visible when it matters.

### 3. Episodic memory (the new capability)

After a session goes idle (or on session switch), a background distillation call produces at most one episode entry:

> "Episode: helped reorganize `~/Pictures/2023` — user prefers `yyyy-mm-event` folder names; duplicate scan found mostly burst shots which they keep."

- Promotion gate: only sessions with ≥ 4 user turns and a completed task shape; the distiller is instructed to return `null` for chit-chat (same strictness pattern as today's auto-capture).
- Retrieved semantically like facts. This is what makes the agent feel like it *learns your patterns* across sessions.

### 4. Governance: supersede, decay, provenance

- **Supersede on contradiction**: at write time, a near-paraphrase (cosine ≥ 0.80) of a same-type entry replaces it directly. *Measured reality:* the "update" and "different fact" similarity bands overlap (≈0.55–0.8 on nomic-embed), so the ambiguous band is arbitrated by one tiny model call ("is B an update of A?") — the article's manager-model-on-the-write-path, scoped to where embeddings genuinely can't decide.
- **Decay**: raise the cap (50 → 200 across types) but evict by score `staleness = (now − max(lastUsedAt, updatedAt))`, never-used-first — not by age of creation.
- **Provenance in UI**: Manage → Memory shows type chips, origin chat link, last-used; lets the user retype/edit/delete. Trust requires inspectability.

## What this is NOT

- Not a database migration — same JSON store, same per-user file, entries get richer.
- Not a new model call per turn — read path uses the embedding call we already make; only episodic distillation adds calls, and only after sessions end.
- Not a change to RAG — `search_docs`/indexes are untouched; memory and document retrieval stay separate systems that meet in the prompt, with memory clearly labeled so the verifier doesn't confuse memory with document evidence.

## Implementation order

1. **Schema + migration + typed UI** (small) — types, timestamps, vectors on write; migrate existing entries as `fact` with backfilled embeddings.
2. **Selective read path** (the win) — replace `memoryBlock(user)` dump with always-inject + top-k; usage bumps.
3. **Supersede + decay** (small, pairs with 2).
4. **Episodic distillation** (the feature) — idle-session hook + promotion gate + episode retrieval.

Each step ships independently and degrades gracefully (no vectors → fall back to inject-all).

## Sources

- [From RAG to AI Memory Systems — Oracle Developers Blog](https://blogs.oracle.com/developers/from-rag-to-memory-systems-building-stateful-ai-architecture) (primary; summarized via coverage as the page blocks non-browser fetches)
- [Building Stateful AI Agents That Actually Remember — Fahd Mirza](https://www.fahdmirza.com/2026/06/building-stateful-ai-agents-that.html) (detailed walkthrough of the Oracle piece)
- [Beyond RAG: Why AI Agents Need Long-Term Memory — XTrace](https://xtrace.ai/blog/rag-vs-long-term-memory-ai-agents) (semantic/episodic/state split, write-lifecycle)
