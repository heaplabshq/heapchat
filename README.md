# Cortex

Browse any local folder like a Pinterest board, then chat with a **local Ollama model** about any file in it. Light-mode, professional UI implemented from the Cortex design handoff.

## Features

- **Open a folder _or_ a single file** via a real filesystem picker (navigate, go up, home, refresh). Picking a file jumps straight into its preview + chat.
- **Masonry gallery** of the folder's contents — real image thumbnails, video frames, audio waveforms, and document cards. Filter by type, sort by recent/name/type, and **search by name *and content*** — the search box matches file contents (and image descriptions) via the index, not just filenames (`GET /api/search`).
- **Focus + chat** — click a file to see a full preview (image / video player / audio player / PDF embed) with an AI chat sidebar **scoped to that one file**.
  - Images are sent to the vision model; **text/code/markdown/csv, PDF, and Word (.docx)** files have their contents extracted and passed as context; other files use filename + metadata.
  - Multi-turn: the full conversation history is sent, so follow-up questions work.
  - **Multiple saved chats per file.** Start a new chat (`+`), and switch between past conversations from the history menu (clock icon). Sessions are stored **server-side** in `data/chats.json` (survives browser clears; not tied to one browser). Delete individual sessions from the menu.
- **Agentic chat everywhere.** Chat is powered by a **multi-step tool-using agent** (native Ollama tool-calling on your local model) that loops until it can answer, with the **chain of steps shown live** in the UI before the final cited answer streams in. Simple questions that need no documents are answered directly (no wasted tool calls). Its tools (all formats — PDF, Word, Markdown, CSV, code, text):
  - `search_docs` — semantic search · `find_text` — exact word/number/phrase search
  - `list_files` — list/count/recent with metadata & tags · `read_file` — whole file or relevant sections (`focus`)
  - `query_csv` — spreadsheet column/row stats · `compare_files` — read two files to compare
  - `save_note` — write a note into the KB · `find_related` — files similar to a given one (semantic/visual)
  - `image_tool` — **describe** an image with the vision model (lets the text agent "see" photos/screenshots) or read its **EXIF**
  - `manage_file` — open / rename / delete / tag, and **edit text files** (append, overwrite, find-and-replace) — only when explicitly asked

  (Kept to a focused ~8 tools: local models route reliably across a small set but get overwhelmed by too many.) The index auto-refreshes incrementally each request, so newly added files are picked up. Tools live in a **registry** (`TOOL_REGISTRY` in `server.js`) — add one by appending a single `{ def, run }` entry. The agent runs over:
  - **Main Chat** (sidebar → Chat) → your whole **knowledge base**.
  - **Ask folder / Ask KB** → the open **folder** (and subfolders).
  - **A single text file** (focus view) → that file (its text is pre-loaded; tools handle very large files).

  Single **image** files still use direct **vision** chat (the model sees the image). Every chat keeps its own multi-session history.
- **MCP connectors.** Point the agent at **remote MCP servers by URL** (it doesn't host any) in **Settings → Connectors (MCP)** — add a URL (+ optional `Authorization` header), **Test** it (shows discovered tools), and **toggle on/off**. Rather than flattening every MCP tool into the agent (which would overwhelm a local model), the agent gets two meta-tools — **`list_connectors`** (discover enabled servers + their tools) and **`use_connector(server, tool, args)`** (invoke one) — so any number of connectors adds only 2 tools. Connector calls appear in the live step trace. Supports Streamable-HTTP and SSE transports. (This is the one feature that makes outbound network calls — to the connector URLs you add.) **Sessions persist across restarts:** for stateful servers like Kite that tie your login to a session id, Cortex saves the session id to `data/mcp-sessions.json` and **resumes it on reconnect**, so restarting the server no longer forces a re-login — you only log in again when the upstream server actually expires the session. (The id is invalidated automatically if you change the connector's URL/auth or delete it.)
- **Rich rendering (gated).** When a tool returns clearly tabular/numeric data (a `query_csv` result, an MCP connector payload that's an array of objects), the agent renders it as **interactive chart/table/KPI components** inline with the answer — not just text. The **server picks the right visual** for the data:
  - **Table** — always, for the raw rows (clickable, scrollable).
  - **Vertical bar (columns)** — few categories (≤12), with a zero baseline so +/- values draw up and down.
  - **Horizontal bar** — many categories (so labels stay readable); diverging (red) for negatives like P&L.
  - **Line** — when the x-axis looks like a time series (dates, months, quarters, weeks).
  - **Pie / donut** — for composition (a column named like share/weight/allocation/percent, all-positive, ≤8 slices), with a legend + percentages.
  - **KPI stat cards** — Total / Average / Max / Min for the charted column.

  It's **threshold-gated**: visuals only appear when the data actually fits (≥3 rows, a real numeric column that isn't all-zero/constant), so the model **doesn't try to render everything** — plain Markdown stays the default. A **Settings → Rich rendering** toggle turns it off entirely. No client charting library; all charts are dependency-free SVG/CSS, fully offline.
- **Grounding & trust layer.** When an agent answer is actually backed by your files, it shows a small **✓ Grounded · N sources** badge (sources are clickable). General/own-knowledge answers show **no badge** — they're answered fully and directly and are **never refused** just because something isn't in your files. The agent decides per question whether grounding even applies; file questions are held to honesty rules (verify each excerpt is really on-topic, never attribute a fact to a source that doesn't state it, say plainly when something isn't in your files). The badge reflects what the agent actually did (which retrieval tools ran, which sources it cited), not the model's say-so.

  For **grounded** answers (only — general questions skip this, so they stay fast), two more layers kick in:
  - **Self-verification pass** — a second, strict fact-check call compares the answer against the exact evidence the agent retrieved. If it can't confirm specific claims, the badge becomes an expandable **"Double-check N claims"** that lists the exact claims worth verifying (not a vague count) — otherwise it reads **Grounded · N sources · verified**. This is what catches a local model conflating a similar-but-wrong document (e.g. answering a "Kareena" question from a "Deepika" file).
  - **Value-level provenance** — every distinctive number in the answer that traces back to a retrieved row is **underlined**; hover it to see the exact source row it came from (e.g. `47,200` → *"zorbax-policy.md: …the annual offsite budget is exactly 47,200 dollars…"*). Computed deterministically by matching figures to the evidence, so it doesn't depend on the model getting citations right.
- **Web search (opt-in, keyless).** Turn on **Settings → Web search** and the agent gains a `web_search` tool backed by **DuckDuckGo** — no API key, no account, no extra service to run. It returns **text results as clickable link cards** (title · url · snippet) and **image results as an inline thumbnail grid**, both rendered right in the chat; the model answers with **URL citations** that plug into the grounding badge, and clicking a web source opens it in your browser. Off by default — it's the only feature besides MCP connectors that makes outbound internet calls, so the app stays fully offline until you enable it. (Ask for "images/photos of …" and it fetches pictures; ask about current events and it searches the web.)
- **Long-term memory.** The assistant remembers facts/preferences about you across all chats. It **auto-captures** durable facts (guarded: strict criteria, dedup/merge, a 50-item cap, and `auto`-tagged for review), and you can say *"remember that…"* or manage entries in **Manage → Memory**. Memories inject into every chat. A **Settings → Memory** toggle turns auto-capture off (explicit *"remember…"* still works). Stored in `data/memory.json`.
- **Chat ergonomics.** **Copy** any answer, **regenerate** the last one, **edit & resend** a previous question, and **export the conversation to Markdown** (download icon in the chat header). Per-chat **model picker** in the composer.
- **Drag an image into chat** for ad-hoc vision Q&A — drop any image onto a chat and ask about it (answered by the vision model, no need to add it to a folder/KB first).
- **Lightbox** — click an image in the focus view for a fullscreen viewer with click-to-zoom and ←/→/Esc keyboard navigation through the folder's photos.
- **Manage page** (sidebar → Manage) — see every vector index (files, chunks, last updated), **reindex** or **clear** any of them, and review/remove the **image descriptions** the vision model generated.
- **Command palette (⌘K / Ctrl-K)** — jump to any file in the current folder, a recent, or an action (Open, Knowledge base, Chat, Manage, Settings) with the keyboard.
- **Natural-language gallery filter** — the gallery search box matches by **meaning + content** (incl. image descriptions), not just filenames, so "red swatch" or "invoice" filters the board.
- **Multi-select + batch actions** — hover a card's checkbox to select several, then **Add to KB**, **Tag**, **Make searchable** (images), or **Delete** (in the KB) from the batch bar. Plus three **AI batch actions**:
  - **Ask AI** — opens a chat scoped to *exactly* the selected files (its own agent context + saved sessions): "which of these is the signed copy?", "summarize these three".
  - **Auto-tag** — generates 2–4 content-based tags per file (vision descriptions for photos, extracted text for documents) and merges them into the tag store, so the tag chips/filters light up.
  - **Smart rename** — proposes descriptive kebab-case filenames from each file's *content* (`note.txt` → `invoice-uniqlo-singapore-2024-03.txt`), shown in a review modal where you can edit or untick each one before applying. Renames migrate tags, image descriptions, and hashes, then reindex.
- **Duplicate finder** — a **Duplicates** button appears in any folder with 2+ photos. It clusters images by perceptual-hash distance (the cached dHashes, so scans are fast): **Exact copies** (re-saves, copies, resizes) are preselected for deletion with the largest file kept; **Similar** groups (bursts, crops, edits) are shown for manual review. Pick the copies to drop and delete them in one click — sidecar data (tags, descriptions, hashes) is cleaned up too.
- **MCP server mode** — Cortex is an MCP *client* (connectors) **and an MCP server**: it exposes its knowledge-base tools (`search_docs`, `find_text`, `list_files`, `read_file`, `query_csv`, `compare_files`, `find_related`, `image_tool`, `save_note`) over Streamable HTTP at **`/mcp`**, so Claude Desktop, Claude Code, or any MCP client can search and read your KB. E.g.: `claude mcp add --transport http cortex http://localhost:5174/mcp`. Stateless — no sessions or auth (it's your local KB on your local port).
- **Collapsible sidebar** (icons-only) and a **drag-resizable chat panel** (both remembered).
- **Discovery & media smarts** — in a file's focus view: **EXIF** (date taken, camera, settings, dimensions) with a **View-on-map** link for geotagged photos, and a **Related files** strip — **documents** by content embedding (centroid-to-centroid, with a strict gate that shows nothing rather than weak matches), and **images by true visual similarity**: a 64-bit perceptual hash (dHash) compares actual pixels, so it finds the same shot, bursts, crops, and edits — not whatever the vision model happened to describe. Hashes are computed once and cached by file mtime (using the embedded JPEG thumbnail when present, so it barely touches the file), and the comparison itself is just integer distance — so browsing stays fast. In the gallery: filter by **tag** (chips) and **type**, sort by recent/name/type/size, and search names *and* contents.
- **Searchable images (multimodal RAG).** Images are described by the **vision model** and those descriptions are embedded into the index — so the agent can **find, read, and open images** by what they contain, not just their filename. KB images are auto-described on upload; for any image, open it and use the **AI search** panel to add context and (re)analyze it. **Making any image searchable (anywhere) also adds it to the main chat's knowledge** — its description joins the KB/main-chat corpus, so the global agent can use it even if the file lives in another folder. When the agent's answer cites an **image**, the chat renders it as a **clickable thumbnail**; every citation (image or doc) carries the file's real path, so clicking it opens that exact file wherever it lives — not just the KB folder.
- **Knowledge base (upload your own files).** A pinned **Knowledge base** in the sidebar: drag-and-drop or upload supported files (txt/md/csv/code, PDF, Word `.docx`) — they're stored in `data/kb/`, auto-indexed for RAG on upload, and you can **Ask KB** to chat across all of them with citations. Delete any file (removes it and re-indexes). Unsupported types are rejected.
- **Ask the whole folder (RAG).** Click **Ask folder** in the gallery to chat about *everything* in a folder (and its subfolders), not just one file. The server builds a vector index (`nomic-embed-text` embeddings, cached on disk per folder, re-embedding only changed files), retrieves the most relevant excerpts (cosine + MMR for diversity), and the model answers grounded in them with **source citations** you can click to open. Folder chats get their own multi-session history too.
  - Responses **stream** token-by-token from Ollama.
- **Settings / admin page**
  - Ollama endpoint + model (default from `.env`).
  - **Thinking toggle** — on sends `think: true`, off sends `think: false` (keeps this reasoning model giving direct answers). Default **off**.
  - Temperature, max tokens, top-p, and the system prompt. Saved to `localStorage`.

## Configuration

Edit `.env`:

```
PORT=5174
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=llama3.1:latest
OLLAMA_VISION_MODEL=llama3.2-vision:latest
OLLAMA_EMBED_MODEL=nomic-embed-text:latest
OLLAMA_AGENT_MODEL=llama3.1:latest
```

**Models are switchable in the UI.** A **model picker in the chat composer** lets you
change the model for the current conversation (badged "custom"; reset to default any
time), and **Settings** has dropdowns for the default model + default agent model,
populated from your installed Ollama models (`GET /api/models`).

**A note on the agent:** the agent reasons over retrieved excerpts, and Gemma tends to
over-trust/conflate matched text (e.g. answering a "Kareena Kapoor" question from a
Deepika document). A strong tool-caller like `qwen2.5` judges relevance correctly and
falls back to general knowledge. Defaults are Gemma for speed — switch the agent to
`qwen2.5` from the composer's model picker (or Settings) when a question needs careful
reasoning over your documents.

## Accounts & multi-tenant

Cortex is multi-user. On first launch you'll see a **setup screen** — create the admin
account, and any existing single-tenant data (knowledge base, chats, memory, connectors)
migrates into it automatically. Every API route requires a signed-in session (HttpOnly
cookie; passwords are scrypt-hashed in `data/users.json`).

- **Private per user:** knowledge base (`data/users/<id>/kb`), chat history, long-term
  memory, MCP connectors, and the MCP bearer token.
- **Disk access is role-based with default-deny.** Admins see the whole machine.
  Members see **only their private KB** until an admin grants them **folder roots**
  (Settings → Users → Folders; subfolders included). Grants are enforced server-side on
  every path-taking endpoint (browse, list, file streaming, search, indexing, agent
  scopes, duplicates, batch actions, EXIF…), with symlinks resolved so a link can't
  escape a grant. The folder picker shows members a virtual root of just their grants.
- Path-keyed sidecars (tags, image descriptions, perceptual hashes, folder indexes) are
  stored once and visible to any user whose grants cover those files.
- **Admin** (Settings → Account & users): add/delete users, reset passwords, edit
  per-user folder grants and roles.
- **MCP token:** the `/mcp` endpoint now requires `Authorization: Bearer <token>` (copy
  yours from Settings → Account); each token scopes tool calls to that user's KB:
  `claude mcp add --transport http cortex http://localhost:5174/mcp --header "Authorization: Bearer <token>"`.

## Phone / LAN access

Set `HOST=0.0.0.0` in `.env` and the startup banner prints your network URL
(e.g. `http://192.168.x.x:5174`) — open it on your phone, sign in, and use
**Add to Home Screen** to install Cortex as an app (PWA manifest + icons included).
Default is `HOST=127.0.0.1` (this machine only). Every request still requires login,
so LAN exposure is gated by accounts + folder grants.

## Agent evals

`npm run eval` boots a throwaway instance with a fixture knowledge base and runs
~12 golden questions through the agent (grounded facts, exact numbers, paraphrases,
conflation traps, general-knowledge routing), scoring answers, grounding, and cited
sources. Use `--model <name>` to compare models and `--filter <id>` for one case.
Run it after any change to retrieval, memory, prompts, or the agent loop. Results
land in `eval/results/`. Models stay loaded between requests via `keep_alive`
(`OLLAMA_KEEP_ALIVE`, default 30m) so answers after the first don't pay the cold-load stall.

## Run

```bash
npm install
npm start          # or: npm run dev  (auto-restart on changes)
```

Open **http://localhost:5174**.

## How it works

A small Express server (`server.js`) reads the filesystem and proxies chat to Ollama
(avoiding browser CORS and giving the model real file contents). The frontend in
`public/` is React + in-browser Babel reusing the design's exact CSS
(`public/css/app.css`, `public/css/views.css`).

**Fully offline:** every library (React, ReactDOM, Babel, `marked`, `DOMPurify`) is
vendored in `public/vendor/`, and the Manrope / Plus Jakarta Sans / JetBrains Mono
fonts are self-hosted as variable woff2 in `public/fonts/`. The app makes **no
network requests** except to your Ollama server. (`npm install` only needs the
network once to fetch the server's deps; after that nothing reaches the internet.)

| Endpoint | Purpose |
|---|---|
| `GET /api/config` | endpoint/model/home for the UI |
| `GET /api/browse?path=` | list subfolders (folder picker) |
| `GET /api/list?path=` | list a folder's files + metadata |
| `GET /api/file?path=` | stream file bytes (thumbnails/previews) |
| `POST /api/chat` | streaming chat → Ollama (`scope: file` / `folder` / `assistant` / `general`) |
| `POST /api/agent` | multi-step tool-calling agent over the KB (streams steps + answer) |
| `POST /api/kb/upload` | upload files into the knowledge base (multipart) |
| `DELETE /api/kb?path=` | remove a file from the knowledge base |
| `POST /api/image/describe` | run the vision model to describe an image (+ context) for search |
| `GET /api/image/meta?path=` | an image's stored context + description |
| `POST /api/index` | build / update a folder's vector index |
| `GET /api/index?path=` | index status for a folder |
| `GET /api/chats/:fileId` | list a file's saved chat sessions |
| `GET /api/chats/:fileId/:sessionId` | full session with messages |
| `PUT /api/chats/:fileId/:sessionId` | create / update a session |
| `DELETE /api/chats/:fileId/:sessionId` | delete a session |
| `GET /api/models` | list installed Ollama models (for the pickers) |
| `GET /api/health` | is Ollama reachable |
| `GET /api/duplicates?path=` | cluster a folder's photos into exact/similar duplicate groups |
| `POST /api/duplicates/delete` | delete chosen duplicate images (+ sidecar cleanup) |
| `POST /api/batch/autotag` | AI tags from content for the selected files |
| `POST /api/batch/rename/suggest` · `apply` | AI filename proposals → reviewed renames |
| `POST /mcp` | MCP server (Streamable HTTP) exposing the KB tools to any MCP client |

Chat history lives in `data/chats.json` (created on first save, git-ignored).
