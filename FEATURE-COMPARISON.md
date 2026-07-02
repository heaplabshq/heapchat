# Feature Comparison — Cortex vs. ChatGPT / Claude / Copilot / Open WebUI

Snapshot comparison to figure out what's missing relative to the popular AI
apps, and what's already ahead. Cross-references [ROADMAP.md](ROADMAP.md) and
[PEOPLE-ALBUMS-PLAN.md](PEOPLE-ALBUMS-PLAN.md) where an item is already planned there.

## Where Cortex is already ahead

- **Persistent memory + reflection loop** — typed agent memory with decay,
  episodic distillation of past sessions, profile learning
  ([AGENT-MEMORY.md](AGENT-MEMORY.md)). ChatGPT/Claude ship only shallow
  "memories" (flat facts, no reflection or decay).
- **Knowledge graph over your own files** — entities (people, places, tags)
  fused from photos + documents, LLM-free build. None of the big four expose
  this.
- **Local image generation tied into chat** — DrawThings integration for
  generate/edit, fully offline. ChatGPT/Claude route image gen through a
  hosted API; Copilot doesn't do image gen at all.
- **Runs entirely local** — Ollama-backed, no data leaves the machine. Open
  WebUI can do this too, but ChatGPT/Claude/Copilot cannot.
- **Multi-tenant + RBAC folder grants** — already shipped (per ROADMAP), which
  Open WebUI has but the hosted apps don't need (single-user by design).

## Gaps vs. ChatGPT / Claude

| Gap | Brief |
|---|---|
| **Voice mode** | No speech-in/speech-out. ChatGPT/Claude have full duplex voice conversation; Cortex is text-only today. Listed in ROADMAP as push-to-talk via whisper.cpp + macOS `say` — not built yet. |
| **Live web search tool** | ChatGPT/Claude can browse the live web for current info. Cortex's agent has `read_url`/deep-research patterns planned but no general "search the web" tool wired as a default capability. |
| **Canvas / artifacts** | Claude's Artifacts and ChatGPT's Canvas give a side-by-side editable output pane (code, documents) that persists and can be iterated on outside the chat scroll. Cortex has no equivalent split-pane workspace — chat is linear. |
| **Shareable chat links / export** | Both hosted apps let you generate a public link to a conversation. Cortex has no chat export/share mechanism (would need to be a deliberate local HTML/markdown export, similar to the planned "static album export"). |
| **Code execution sandbox** | ChatGPT's Code Interpreter/Claude's code execution run arbitrary code server-side for data analysis, plotting, etc. Cortex's agent tools are file/KB-oriented, not a general sandboxed interpreter. |

## Gaps vs. GitHub Copilot

| Gap | Brief |
|---|---|
| **Repo-aware code chat** | Copilot indexes an entire codebase and answers with jump-to-definition-level awareness; Cortex's `search_docs`/RAG treats code files like any other document — less structural understanding (no symbol graph, no per-language parsing). |
| **Inline IDE completions** | Copilot's core value is ghost-text completion inside the editor. Out of scope for Cortex, which is a standalone chat/photo app rather than an editor plugin — not worth chasing unless the product direction changes. |
| **PR / diff review automation** | Copilot can review pull requests directly on GitHub. Not applicable unless Cortex grows a dev-tooling angle; low priority given the personal-assistant/photos focus. |

## Gaps vs. Open WebUI

| Gap | Brief |
|---|---|
| **Multiple model backends** | Open WebUI can point at Ollama, OpenAI, Anthropic, etc. and switch per-chat. Cortex is Ollama-only — no fallback to a hosted API when a local model isn't good enough for a given task. |
| **Plugin / tool marketplace** | Open WebUI has a pipeline/plugin ecosystem for community-contributed tools. Cortex's ROADMAP has a "Plugin system" item (`data/tools/*.js` loaded into `TOOL_REGISTRY`) but it's unbuilt. |
| **RAG citation highlighting in UI** | Open WebUI highlights the exact retrieved chunk inline. Cortex cites sources but doesn't visually anchor the answer text to the specific passage it came from. |
| **Per-chat model/parameter switching UI** | Open WebUI exposes temperature/model/system-prompt overrides per conversation from a visible panel; Cortex's model picker is coarser (custom agents cover some of this, but not ad-hoc per-message tuning). |

## Gaps common to all four (biggest opportunities)

- **Voice mode** — appears as a gap against ChatGPT/Claude specifically, and is the single modality every competitor has that Cortex lacks entirely.
- **Mobile-responsive layout** — phone access exists (PWA + login wall) but the UI itself is desktop-first; every competitor above has a real mobile layout.
- **Web search as a first-class tool** — ChatGPT, Claude, and Open WebUI (via SearXNG/plugins) all have this; Cortex's research mode exists but isn't a simple "search the web" toggle.

## Recommendation

~~People/face recognition~~ — **already shipped** (`public/js/people.jsx`,
vendored `face-api.js`, `/api/faces*` + `/api/people*` routes;
[PEOPLE-ALBUMS-PLAN.md](PEOPLE-ALBUMS-PLAN.md) was stale and has been
corrected). Of what's actually still open, **voice mode** is the strongest
pick: it's the one modality every competitor above has that Cortex lacks
entirely, it's already scoped in ROADMAP.md (push-to-talk via whisper.cpp +
macOS `say`), and it's a natural fit for a hands-free photo-browsing session.
