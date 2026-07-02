# Cortex

**Browse your files like a Pinterest board. Chat with a local AI that actually knows what's in them.**

Cortex is a local-first knowledge workspace: point it at your folders and it turns them into a searchable, chattable knowledge base — powered entirely by a local [Ollama](https://ollama.com) model. No cloud dependency, no API keys, no telemetry. Everything — indexing, embeddings, vision, chat — runs on your machine.

It ships as both a desktop app (Electron, macOS/Windows) and a self-hosted web server you can run on your LAN and reach from your phone.

---

## Why Cortex

- **Fully local, fully private.** No data leaves your machine except to your own Ollama server (and only to the web/MCP endpoints you explicitly enable).
- **Not just search — an agent.** A multi-step, tool-using agent reasons over your files, cites its sources, and self-verifies grounded answers before you see them.
- **Everything, not just documents.** Photos, videos, audio, PDFs, Word docs, code, CSVs — with face recognition, a photo map, and a knowledge graph tying it all together.
- **Gets smarter over time.** A learning loop gives it persistent memory, a profile of how you like to be helped, and skills it teaches itself from repeated tasks.
- **Multi-user, real access control.** Admin/member roles with per-folder grants enforced server-side, not just hidden in the UI.
- **Extensible.** Connect to any MCP server, or expose Cortex's own knowledge base as an MCP server to Claude Desktop/Code.

---

## How Cortex compares

Cortex isn't trying to be a smaller ChatGPT — it's built around a different premise: **the AI lives with your files, permanently, instead of visiting them one upload at a time.**

| | ChatGPT / Claude | Open WebUI | Cortex |
|---|---|---|---|
| Runs fully offline / local-only | No | Yes | **Yes** |
| Memory that reflects, decays, and learns a profile of you | Shallow flat facts | No | **Yes** — typed memory, episodic reflection, auto-built profile |
| Knowledge graph over your own files | No | No | **Yes** — people, places, tags, and documents fused, LLM-free |
| Photo-native (face recognition, geotag map, visual dedup) | No | No | **Yes** |
| Local image generation tied into chat | Hosted API only | No | **Yes** — via Draw Things, fully offline |
| Multi-user with server-enforced, per-folder access control | N/A (single-user) | Yes | **Yes** |
| Background agent jobs on a schedule | No | No | **Yes** — digests to feed/note/notification |
| MCP client *and* server | Varies | Client only | **Both** |

Where Cortex is still catching up: it doesn't yet have voice conversation, a split-pane editable canvas, or a mobile-first layout — all real gaps against the hosted apps, tracked openly rather than glossed over. What it trades those for is an AI that actually accumulates context about your files and you, permanently, without any of it leaving your machine.

---

## Table of contents

- [How Cortex compares](#how-cortex-compares)
- [Features](#features)
- [Quick start](#quick-start)
- [Desktop app](#desktop-app)
- [Configuration](#configuration)
- [Accounts & multi-tenant](#accounts--multi-tenant)
- [Phone / LAN access](#phone--lan-access)
- [Security](#security)
- [How it works](#how-it-works)
- [API reference](#api-reference)
- [Development](#development)

---

## Features

### Browse & organize

- **Open a folder _or_ a single file** via a real filesystem picker. Picking a file jumps straight into its preview + chat.
- **Masonry gallery** — real image thumbnails, video frames, audio waveforms, and document cards. Filter by type, sort by recent/name/type/size, and **search by name *and content*** (matches file text and image descriptions, not just filenames).
- **Quick folder access** — the sidebar remembers the last folder you browsed for one-click return, alongside "Open another folder."
- **Duplicate finder** — clusters photos by perceptual hash: **exact copies** are preselected for deletion (largest kept), **similar** groups (bursts, crops, edits) are shown for manual review.
- **Multi-select + batch actions** — select several files and **Add to KB**, **Tag**, **Make searchable**, or **Delete**, plus three AI batch actions:
  - **Ask AI** — a chat scoped to exactly the selected files.
  - **Auto-tag** — content-based tags generated per file.
  - **Smart rename** — descriptive filenames proposed from each file's actual content, reviewed before applying.
- **Command palette (⌘K / Ctrl-K)** — jump to any file, recent, or action with the keyboard.

### Chat & agent

- **Focus + chat** — click any file for a full preview (image / video / audio / PDF) with an AI chat sidebar scoped to that one file. Multiple saved chats per file, stored server-side.
- **Agentic chat everywhere.** A multi-step, tool-using agent (native Ollama tool-calling) loops until it can answer, showing its **chain of steps live** before the final cited answer streams in. Tools include semantic + exact search, file listing/reading, CSV analysis, file comparison, image description/EXIF, note-taking, related-file discovery, and file management. The agent runs over your whole knowledge base, an open folder, a single file, or a Project — whichever scope you're in.
- **Deep work mode** — toggle **"Deep work — agent team"** in the composer for a coordinated multi-agent roster (planner → researcher → drafter → critic) on complex requests, instead of a single agent looping alone.
- **Grounding & trust layer.** Grounded answers show a **✓ Grounded · N sources** badge (clickable sources); general-knowledge answers show no badge and are never refused. A **self-verification pass** double-checks specific claims against the retrieved evidence, and **value-level provenance** underlines every number in an answer that traces back to a source row — hover to see exactly where it came from.
- **Rich rendering.** Tabular/numeric tool results render as interactive tables, bar/line/pie charts, and KPI cards inline — dependency-free SVG/CSS, gated so it only kicks in when the data actually fits.
- **Context meter** — a live donut gauge in the composer shows how much of the model's context window the conversation is using, with a breakdown on click.
- **Chat ergonomics** — copy, regenerate, edit & resend, export any conversation to Markdown or JSON, and a per-chat model picker.
- **Drag an image into chat** for ad-hoc vision Q&A, no need to add it to a folder first.

### Knowledge & memory

- **Knowledge base** — upload files (text/code, CSV, PDF, Word) into a personal KB, auto-indexed for retrieval, with **Ask KB** to chat across everything you've added.
- **Ask the whole folder (RAG)** — chat about everything in a folder and its subfolders, with a vector index cached and incrementally updated on disk, and clickable source citations.
- **Long-term memory** — the assistant remembers durable facts and preferences about you across every chat, auto-captured with strict dedup/merge rules, or added explicitly ("remember that…"). Manage entries any time.
- **Learning loop** — Cortex improves the more you use it:
  - **Skills** — reusable step-by-step procedures the agent saves after solving a repeatable task, recalled by similarity when a similar task comes up again.
  - **Profile** — a synthesized summary of who you are and how you like to be helped, injected into every conversation and rebuilt automatically as your memory grows.
  - **Reflection** — an opt-in pass that reviews finished chats and quietly corrects memory/skills.
  - **Scheduler** — background jobs that run on a cadence (hourly/every 6h/daily/weekly) over your KB, a folder, or a Project, delivering digests to your feed, as a note, or as a desktop notification. Managed under **Activity**.
- **Searchable images (multimodal RAG)** — photos are described by the vision model and indexed, so the agent can find, read, and cite images by what they actually show — not just their filename.

### Photos & people

- **Photo Map** — geotagged photos plotted on an interactive map (EXIF GPS), with popups linking straight back to each photo.
- **People** — on-device face detection and clustering. Name a cluster once (typing an existing name merges clusters), re-scan individual photos, and manage everyone Cortex has recognized.
- **Discovery & media smarts** — EXIF metadata with a map link for geotagged shots, and a **Related files** strip: documents by content-embedding similarity, images by true visual similarity (perceptual hashing — finds bursts, crops, and edits, not just similar-sounding descriptions).
- **Lightbox** — fullscreen image viewer with click-to-zoom and keyboard navigation through the folder.

### Knowledge graph

- A fully local, LLM-free entity graph built from named people, photo locations, tags, and document entities. Browse individual entities and their connections, or switch to a force-directed **Overview** of everything at once.

### Projects & custom agents

- **Projects** — named workspaces with their own custom instructions, private knowledge base, and grouped chat history, for keeping a client, topic, or task cleanly separated from your main KB.
- **Custom agents** — define your own agent with a full system-prompt override, model and sampling overrides, and per-agent tool capability toggles (files, web, memory, connectors). Pick one from the composer's agent picker, or chat with it directly from the Agents hub.
- **Export & import** — download any agent or any chat as a JSON file, and re-import it later (or on another machine) with one click. Every chat card and agent card has an export button; both hubs have an import button in the header.

### Local image generation

- **Create and edit images entirely offline** via a local [Draw Things](https://drawthings.ai) server — no cloud image API involved. Use the `/image-create` and `/image-edit` slash commands in chat, or the **Edit with AI** button on any generated image or gallery photo. *(Experimental / Beta.)*

### Integrations

- **MCP client.** Point the agent at any remote MCP server by URL (Settings → Connectors) — it gets two meta-tools (`list_connectors`, `use_connector`) so any number of connectors only ever adds two tools to the agent's toolbox. Sessions persist across restarts.
- **MCP server.** Cortex also exposes its own knowledge-base tools over Streamable HTTP at `/mcp`, so Claude Desktop, Claude Code, or any MCP client can search and read your KB directly.
- **Web search (opt-in, keyless)** — DuckDuckGo-backed search tool, no API key required. Returns link cards and image grids inline, with citations that plug into the grounding badge.
- **Paste a link, get it read** — drop a URL into a chat message and the agent automatically fetches and reads the page as context, no extra step needed (or use `/read` to do it on demand without the model deciding).

### Multi-tenant & access control

- Admin/member accounts with **per-folder grants enforced server-side** on every path-taking route — not just hidden in the UI. Each user gets a fully private KB, chat history, memory, and MCP token.
- Phone/PWA access over your LAN, gated by the same login + folder grants as the desktop app.

---

## Quick start

```bash
git clone https://github.com/sid7631/cortex.git
cd cortex
cp .env.example .env      # then edit .env — see Configuration below
npm install
npm start                 # or: npm run dev (auto-restart on changes)
```

Open **http://localhost:5174**. On first launch you'll be prompted to create the admin account.

You'll need [Ollama](https://ollama.com) running locally with at least a chat model and an embedding model pulled (e.g. `ollama pull llama3.1` and `ollama pull nomic-embed-text`).

## Desktop app

Cortex also runs as a native Electron app.

```bash
npm run desktop      # run the desktop shell locally
npm run dist:mac      # build a distributable macOS app (dist/)
npm run dist:win      # build a distributable Windows installer (dist/)
```

Packaged builds auto-update via GitHub Releases.

## Configuration

Copy `.env.example` to `.env` and set your own values:

```
PORT=5174

# Ollama server
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=llama3.1:latest
OLLAMA_VISION_MODEL=llama3.2-vision:latest
OLLAMA_EMBED_MODEL=nomic-embed-text:latest
OLLAMA_AGENT_MODEL=llama3.1:latest

# Bind address: 127.0.0.1 = this machine only; 0.0.0.0 = phones/devices on your network
HOST=127.0.0.1
```

**Models are switchable in the UI** — the composer's model picker changes the model for the current conversation, and Settings has dropdowns for the default chat and agent models, populated from whatever you have installed locally (`GET /api/models`).

`.env` is git-ignored; never committed.

## Accounts & multi-tenant

Cortex is multi-user from the first launch. Create the admin account on the setup screen; every API route then requires a signed-in session (HttpOnly cookie, scrypt-hashed passwords).

- **Private per user:** knowledge base, chat history, long-term memory, MCP connectors, and MCP token.
- **Disk access is role-based with default-deny.** Admins see the whole machine; members see only their private KB until an admin grants them specific folder roots (Settings → Users → Folders, subfolders included). Grants are enforced on every path-taking endpoint, with symlinks resolved so a grant can't be escaped.
- **Admin panel** (Settings → Account & users) — add/delete users, reset passwords, edit folder grants and roles.
- **MCP token** — the `/mcp` endpoint requires `Authorization: Bearer <token>` (copy yours from Settings → Account); each token scopes tool calls to that user's own KB.

## Phone / LAN access

Set `HOST=0.0.0.0` in `.env` and the startup banner prints your network URL (e.g. `http://192.168.x.x:5174`) — open it on your phone, sign in, and **Add to Home Screen** to install Cortex as a PWA. Every request still requires login, so LAN exposure is gated by accounts and folder grants. Default is `127.0.0.1` (this machine only).

## Security

- **Offline by default.** The only features that make outbound network calls are Web search, MCP connectors, and pasted-link auto-fetch — all explicit, none required.
- **Network-egress features are admin-gated.** The local image-generation endpoint's target address can only be overridden by an admin account; every other user is always pinned to `localhost`, closing off any request-driven redirection of the server's outbound calls.
- **No telemetry.** Every frontend library is vendored locally; nothing phones home.
- **Passwords are scrypt-hashed**, sessions are HttpOnly-cookie based, and file access is checked server-side on every request, not assumed from the UI.

Found a security issue? Please report it privately rather than opening a public issue.

## How it works

A small Express server (`server.js`, backed by focused modules under `src/`) reads the filesystem and proxies chat to Ollama — avoiding browser CORS and giving the model real file contents. The frontend in `public/` is React, bundled with esbuild.

**Fully offline by design:** every frontend library is vendored under `public/vendor/`, and fonts are self-hosted. The app makes no network requests except to your own Ollama server (plus whatever you explicitly enable — web search, MCP, image generation). `npm install` only needs the network once, to fetch server dependencies.

## API reference

| Endpoint | Purpose |
|---|---|
| `GET /api/config` | endpoint/model/home for the UI |
| `GET /api/browse?path=` | list subfolders (folder picker) |
| `GET /api/list?path=` | list a folder's files + metadata |
| `GET /api/file?path=` | stream file bytes (thumbnails/previews) |
| `POST /api/chat` | streaming chat → Ollama (file / folder / assistant / general scope) |
| `POST /api/agent` | multi-step tool-calling agent (streams steps + answer) |
| `POST /api/kb/upload` | upload files into the knowledge base |
| `DELETE /api/kb?path=` | remove a file from the knowledge base |
| `POST /api/image/describe` | vision model describes an image for search |
| `POST /api/image/create` · `/api/image/edit` | local image generation / editing |
| `POST /api/index` · `GET /api/index?path=` | build/check a folder's vector index |
| `GET /api/chats` · `/api/chats/:fileId/:sessionId` | list / load saved chat sessions |
| `PUT` · `DELETE /api/chats/:fileId/:sessionId` | create/update / delete a session |
| `GET /api/agents` · `POST /api/agents` | list / create custom agents |
| `GET /api/models` | list installed Ollama models |
| `GET /api/duplicates?path=` | cluster a folder's photos into duplicate groups |
| `POST /api/batch/autotag` · `/api/batch/rename/suggest` | AI batch actions |
| `POST /mcp` | MCP server (Streamable HTTP) exposing KB tools to any MCP client |

## Development

```bash
npm run dev          # server with auto-restart
npm run build:ui     # bundle the frontend (esbuild)
npm run eval          # run the agent eval suite against a fixture KB
```

`npm run eval` boots a throwaway instance with a fixture knowledge base and runs a set of golden questions through the agent (grounded facts, exact numbers, paraphrases, conflation traps, general-knowledge routing), scoring answers, grounding, and cited sources. Run it after any change to retrieval, memory, prompts, or the agent loop.

## License

Cortex is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE) — free to use, modify, and share for any noncommercial purpose (personal, research, education, nonprofit). Commercial use, including selling it or offering it as part of a paid product or service, is not permitted without a separate license from the author.

---

Built for people who want an AI that actually knows their files — without sending those files anywhere.
