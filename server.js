/* ============================================================
   Heap Chat — local server
   - Browses the real filesystem for the folder picker
   - Lists a folder's files with metadata for the gallery
   - Streams file bytes for thumbnails / previews
   - Proxies file-scoped chat to a local Ollama instance
   ============================================================ */

require("dotenv").config();
const express = require("express");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const multer = require("multer");     // knowledge-base file uploads
const exifr = require("exifr");        // photo EXIF (date, camera, GPS)
const { Jimp } = require("jimp");       // pixel access for perceptual image hashing (visual "related")

/* ---- extracted modules (see SERVER-REFACTOR-PLAN.md) — re-bound into local scope
   so existing call sites are unchanged ---- */
const { DATA_DIR, PORT, HOST, OLLAMA_MODEL, OLLAMA_VISION_MODEL, OLLAMA_AGENT_MODEL, OLLAMA_KEEP_ALIVE } = require("./src/config");
const ollamaConn = require("./src/llm/ollama-conn");
const { writeJSONAtomic } = require("./src/util/json-store");
const { TEXTLIKE, MIME, DESCRIBABLE_IMG, extOf, kindOf, fmtSize, fmtDate, isImageFile, safeName } = require("./src/util/files");
const { buildProvenance } = require("./src/util/text");
const { wantsVisual } = require("./src/media/render");
const {  } = require("./src/web/search");
const { imageMeta, persistImageMeta, tagStore, persistTags, getTags, setTags, pdfOcrStore, persistPdfOcr, phashStore, persistPhash, geoStore, persistGeo, faceStore, persistFaces, entityStore, persistEntities, placeNames, persistPlaceNames } = require("./src/state/sidecars");
const { USERS_DIR, userStores, storesFor, kbDirFor, projectKbDirFor, isKbDir } = require("./src/state/user-stores");
const serverSettings = require("./src/state/server-settings");
const { users, authSessions, persistUsers, persistAuthSessions, newToken, hashPassword, verifyPassword, publicUser, cleanFolders, createUser, parseCookies, userFromRequest, startSession, migrateLegacyData } = require("./src/auth/accounts");
const { grantedRoots, canAccessPath, guardPath, accessibleOnly, realResolve } = require("./src/auth/access");
const { authWall, requireAdmin, loginLimiter, recordLoginFailure, clearLoginFailures } = require("./src/auth/middleware");
const { describeImage } = require("./src/llm/vision");
const { extractText, buildFileContext } = require("./src/rag/extract");
const { INDEX_DIR, KB_THRESHOLD, indexPath, loadIndex, walkFiles, embed, buildIndex } = require("./src/rag/index");
const { cosine, retrieve } = require("./src/rag/retrieve");
const { mapLimit } = require("./src/util/concurrency");
const { getPhash, hammingHex, warmPhashes, relatedFor, DUP_EXACT, DUP_NEAR } = require("./src/media/phash");
const { FACE_SCAN_VERSION, geoFor, faceDist, tagPhotos, personDescs, upsertPerson } = require("./src/media/photos");
const { reverseGeocode, graphCache, graphFor, ensurePhotoGeo, docExcerptsFor, graphRetrieve } = require("./src/media/graph");
const { dtEcho, dtGenerate, dtEdit } = require("./src/media/drawthings");
const { enhancePrompt, saveGeneratedImage } = require("./src/media/image-prompt");
const { completeJSON, completeText } = require("./src/llm/ollama");
const { providerOf: modelProviderOf, bareModel: routedBareModel, completeJSON: routedCompleteJSON, completeText: routedCompleteText } = require("./src/llm/router");
const providerLLM = require("./src/llm/providers");
const { mcpEnabled, mcpPublic, forgetSession, dropMcpClient, mcpListTools, mcpCallTool } = require("./src/mcp/client");
const { addMemory, memPublic, sysInfoBlock, memoryBlock, scheduleEpisode, scheduleTitle, cancelUserTimers } = require("./src/llm/memory");
const { addSkill, updateSkill, removeSkill, skillsBlock, skillPublic } = require("./src/llm/skills");
const { rebuildProfile, profileBlock } = require("./src/llm/profile");
const { startScheduler, runJob, deliver, normalizeJob, jobPublic, CADENCES } = require("./src/agent/scheduler");
const { runExtraction, contentBasis } = require("./src/rag/extract-batch");
const { findFileOnDisk, VERIFY_SYS, TOOL_REGISTRY, RETRIEVAL_TOOLS, ROSTER_DEFAULTS, agentToolDefs, agentToolMechanics, agentSys, execTool, makeThinkSplitter, deepResearchPipeline, rosterFor, multiAgentPipeline, chatImageRefs, resolveImageRef, materializeChatImage } = require("./src/agent/core");
const { makeMcpServer } = require("./src/mcp/server");

const app = express();
app.use(express.json({ limit: "64mb" }));   // base64 file uploads from chat attachments come through JSON
app.use(express.static(path.join(__dirname, "public")));

// DATA_DIR resolved in src/config.js (honors HEAPCHAT_DATA_DIR for the desktop wrapper).
fs.mkdirSync(DATA_DIR, { recursive: true });

/* ============================================================
   Accounts & sessions (multi-tenant).
   Users in data/users.json (scrypt-hashed passwords); browser sessions
   in data/sessions.json via an HttpOnly cookie. Each user's content
   (KB, chats, memory, MCP connectors) lives under data/users/<id>/.
   Path-keyed sidecars (tags, image descriptions, pHashes, folder
   indexes) stay shared — they describe disk files all users can see.
   ============================================================ */
// Accounts/sessions → src/auth/accounts.js · per-user stores → src/state/user-stores.js
// folder-grant access guards → src/auth/access.js · auth wall + requireAdmin → src/auth/middleware.js

/* ---------------- auth wall: every /api route needs a signed-in user ---------------- */
app.use(authWall);

app.get("/api/auth/me", (req, res) => {
  if (!users.length) return res.json({ setup: true });
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: "Not signed in" });
  res.json({ user: publicUser(user) });
});
app.post("/api/auth/setup", (req, res) => {
  if (users.length) return res.status(403).json({ error: "Already set up" });
  try {
    const u = createUser({ ...(req.body || {}), role: "admin" });
    migrateLegacyData(u);
    startSession(res, u);
    res.json({ user: publicUser(u) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post("/api/auth/login", loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  const u = users.find(x => x.username === String(username || "").trim().toLowerCase());
  if (!u || !verifyPassword(u, password)) { recordLoginFailure(req); return res.status(401).json({ error: "Wrong username or password" }); }
  clearLoginFailures(req);
  startSession(res, u);
  res.json({ user: publicUser(u) });
});
app.post("/api/auth/logout", (req, res) => {
  delete authSessions[parseCookies(req).heapchat_sid];
  persistAuthSessions();
  res.setHeader("Set-Cookie", "heapchat_sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0");
  res.json({ ok: true });
});

/* ---------------- user management (admin) + per-user MCP token ---------------- */
app.get("/api/users", (req, res) => { if (!requireAdmin(req, res)) return; res.json({ users: users.map(publicUser) }); });
app.post("/api/users", (req, res) => {
  if (!requireAdmin(req, res)) return;
  try { res.json(publicUser(createUser(req.body || {}))); } catch (e) { res.status(400).json({ error: e.message }); }
});
// edit a user's display name, role, or granted folder roots
app.put("/api/users/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const u = users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: "No such user" });
  const b = req.body || {};
  if (b.name !== undefined) u.name = String(b.name).trim() || u.username;
  if (b.role !== undefined && req.params.id !== req.user.id) u.role = b.role === "admin" ? "admin" : "user";   // can't demote yourself
  if (b.folders !== undefined) u.folders = cleanFolders(b.folders);
  persistUsers();
  res.json(publicUser(u));
});
app.delete("/api/users/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (req.params.id === req.user.id) return res.status(400).json({ error: "You can't delete your own account" });
  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: "No such user" });
  users.splice(idx, 1); persistUsers();   // mutate in place — `users` is shared by reference with src/auth/accounts.js
  for (const [sid, s] of Object.entries(authSessions)) if (s.userId === req.params.id) delete authSessions[sid];
  persistAuthSessions();
  userStores.delete(req.params.id);   // their data dir stays on disk (recoverable); just no way to sign in
  res.json({ ok: true });
});
app.post("/api/users/:id/password", (req, res) => {
  if (req.user.role !== "admin" && req.user.id !== req.params.id) return res.status(403).json({ error: "Not allowed" });
  const u = users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: "No such user" });
  if (String((req.body || {}).password || "").length < 4) return res.status(400).json({ error: "Password must be at least 4 characters" });
  u.salt = newToken(8); u.passHash = hashPassword(req.body.password, u.salt); persistUsers();
  res.json({ ok: true });
});
app.get("/api/auth/mcp-token", (req, res) => {
  const user = userFromRequest(req);   // /api/auth/* skips the wall — re-check here
  if (!user) return res.status(401).json({ error: "Not signed in" });
  res.json({ token: user.mcpToken });
});
app.post("/api/auth/mcp-token", (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: "Not signed in" });
  user.mcpToken = newToken(); persistUsers();
  res.json({ token: user.mcpToken });
});

/* ============================================================
   Chat history store — per-user, per-file sessions.
   Shape: { [fileId]: { [sessionId]: {id,title,createdAt,updatedAt,messages[]} } }
   ============================================================ */
function sessionSummary(s) {
  return { id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt, count: (s.messages || []).length, source: s.source || null, pinned: !!s.pinned, projectId: s.projectId || null, agentId: s.agentId || null };
}

/* Long-term memory (typed, per-user) + episodic distillation + auto chat titles
   (addMemory/memoryBlock/sysInfoBlock/scheduleEpisode/scheduleTitle/…) → src/llm/memory.js */

/* MCP connectors (per-user remote servers) — mcpEnabled/mcpPublic, connect/session
   handling, getMcpClient/withMcp, mcpListTools/mcpCallTool → src/mcp/client.js */

function describeFile(full, name, st) {
  return {
    id: Buffer.from(full).toString("base64url"),
    name,
    path: full,
    kind: kindOf(name),
    ext: extOf(name),
    bytes: st.size,
    mtime: st.mtimeMs,
    tags: getTags(full),
    meta: { size: fmtSize(st.size), date: fmtDate(st.mtimeMs) },
  };
}

/* ---------------- config ---------------- */
app.get("/api/config", (req, res) => {
  const kb = kbDirFor(req.user);
  // per-user folder where generated / AI-edited images land (browsable as "Created images")
  const generated = path.join(kb, "generated");
  try { fs.mkdirSync(generated, { recursive: true }); } catch {}
  res.json({
    endpoint: ollamaConn.baseUrl(),
    model: OLLAMA_MODEL,
    visionModel: OLLAMA_VISION_MODEL,
    agentModel: OLLAMA_AGENT_MODEL,
    home: req.user.role === "admin" ? os.homedir() : ((req.user.folders || [])[0] || ""),
    kb,
    generated,
    user: req.user.name,
    role: req.user.role,
    userId: req.user.id,
    folders: req.user.folders || [],
    // public info only (no keys) — which OpenAI-compatible provider connections are live, for
    // the model pickers to know a "<providerId>/<model>" string is real; see src/llm/router.js
    providers: serverSettings.listProviders().filter(p => p.apiKey).map(p => ({ id: p.id, name: p.name, models: p.models || [], agentModel: p.agentModel || "" })),
  });
});

/* ---------------- folder browser (for the picker) ---------------- */
app.get("/api/browse", async (req, res) => {
  try {
    const isAdmin = req.user.role === "admin";
    const roots = grantedRoots(req.user);
    // members with no path land on a virtual root listing their granted folders
    if (!isAdmin && !req.query.path) {
      return res.json({
        path: "", parent: null, files: [],
        dirs: roots.map(r => ({ name: path.basename(r) || r, path: r })),
      });
    }
    let dir = req.query.path ? String(req.query.path) : os.homedir();
    dir = path.resolve(dir);
    if (!guardPath(req, res, dir)) return;
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const files = [];
    for (const e of entries) {
      if (!e.isFile() || e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      let st; try { st = await fsp.stat(full); } catch { continue; }
      files.push(describeFile(full, e.name, st));
    }
    files.sort((a, b) => a.name.localeCompare(b.name));
    let parent = path.dirname(dir);
    if (parent === dir) parent = null;
    else if (!isAdmin && !canAccessPath(req.user, parent)) parent = "";   // "up" from a granted root → back to the grants list
    res.json({ path: dir, parent, dirs, files });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ---------------- list files in a folder ---------------- */
app.get("/api/list", async (req, res) => {
  try {
    const dir = path.resolve(String(req.query.path || ""));
    if (!guardPath(req, res, dir)) return;
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const files = [];
    const dirs = [];
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { dirs.push({ name: e.name, path: full }); continue; }
      if (!e.isFile()) continue;
      let st; try { st = await fsp.stat(full); } catch { continue; }
      files.push(describeFile(full, e.name, st));
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => b.mtime - a.mtime);
    const parent = path.dirname(dir);
    res.json({ path: dir, name: path.basename(dir) || dir, parent: parent === dir ? null : parent, dirs, files });
    warmPhashes(files.filter(f => isImageFile(f.name)).map(f => f.path));   // background pre-hash this folder's images
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ---------------- describe a single file (restore a file recent) ---------------- */
app.get("/api/fileinfo", async (req, res) => {
  try {
    const full = path.resolve(String(req.query.path || ""));
    if (!guardPath(req, res, full)) return;
    const st = await fsp.stat(full);
    if (!st.isFile()) throw new Error("Not a file");
    res.json(describeFile(full, path.basename(full), st));
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

/* ---------------- chat history (per-file sessions) ---------------- */
// list a file's sessions (summaries, newest first)
// every saved chat across all files/folders/KB — for the global Chats hub (optional ?q= searches title + message text)
// wipe every conversation for the signed-in user (Settings → Clear all chats)
app.delete("/api/chats", (req, res) => {
  const st = storesFor(req.user);
  const n = Object.values(st.chats).reduce((a, b) => a + Object.keys(b).length, 0);
  st.chats = {};
  st.save("chats.json");
  res.json({ ok: true, deleted: n });
});
app.get("/api/chats", (req, res) => {
  const st = storesFor(req.user);
  const q = String(req.query.q || "").trim().toLowerCase();
  const filterProjectId = String(req.query.projectId || "").trim() || null;
  const out = [];
  for (const [fileId, bucket] of Object.entries(st.chats)) {
    for (const s of Object.values(bucket)) {
      if (filterProjectId !== null && (s.projectId || null) !== filterProjectId) continue;
      if (q) {
        const hit = (s.title || "").toLowerCase().includes(q) || (s.messages || []).some(m => (m.text || "").toLowerCase().includes(q));
        if (!hit) continue;
      }
      out.push({ fileId, ...sessionSummary(s) });
    }
  }
  out.sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));
  res.json({ sessions: out });
});
app.get("/api/chats/:fileId", (req, res) => {
  const f = storesFor(req.user).chats[req.params.fileId] || {};
  const list = Object.values(f).map(sessionSummary).sort((a, b) => b.updatedAt - a.updatedAt);
  res.json({ sessions: list });
});
// full session (with messages)
app.get("/api/chats/:fileId/:sessionId", (req, res) => {
  const s = (storesFor(req.user).chats[req.params.fileId] || {})[req.params.sessionId];
  if (!s) return res.status(404).json({ error: "Session not found" });
  res.json(s);
});
// create / update a session
app.put("/api/chats/:fileId/:sessionId", (req, res) => {
  const st = storesFor(req.user);
  const { fileId, sessionId } = req.params;
  const { title, messages, source, projectId, agentId } = req.body || {};
  if (!Array.isArray(messages)) return res.status(400).json({ error: "messages[] required" });
  const bucket = st.chats[fileId] || (st.chats[fileId] = {});
  const now = Date.now();
  const existing = bucket[sessionId];
  const locked = !!(existing && existing.titleLocked);   // a generated or hand-edited title wins over the client's placeholder
  bucket[sessionId] = {
    id: sessionId,
    title: locked ? existing.title : (title || "New chat").slice(0, 80),
    titleLocked: locked,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
    source: source || (existing && existing.source) || null,   // where this chat lives (scope/name/path) — for the hub
    projectId: projectId || (existing && existing.projectId) || null,
    agentId: agentId !== undefined ? (agentId || null) : (existing && existing.agentId) || null,   // which custom agent drove this chat
    pinned: existing ? !!existing.pinned : false,
    messages: messages.slice(-200),
  };
  st.save("chats.json");
  if (!locked) scheduleTitle(req.user, fileId, sessionId);   // name the chat from its content once it has a real exchange
  if ((req.body || {}).autoMemory !== false) scheduleEpisode(req.user, fileId, sessionId);
  res.json(sessionSummary(bucket[sessionId]));
});
// rename / pin without resending messages
app.patch("/api/chats/:fileId/:sessionId", (req, res) => {
  const st = storesFor(req.user);
  const s = (st.chats[req.params.fileId] || {})[req.params.sessionId];
  if (!s) return res.status(404).json({ error: "Session not found" });
  const { title, pinned } = req.body || {};
  if (typeof title === "string") { s.title = title.slice(0, 80); s.titleLocked = true; }   // a hand-picked title is final — never auto-rename over it
  if (typeof pinned === "boolean") s.pinned = pinned;
  st.save("chats.json");
  res.json(sessionSummary(s));
});
// delete a session
app.delete("/api/chats/:fileId/:sessionId", (req, res) => {
  const st = storesFor(req.user);
  const bucket = st.chats[req.params.fileId];
  if (bucket) { delete bucket[req.params.sessionId]; if (!Object.keys(bucket).length) delete st.chats[req.params.fileId]; st.save("chats.json"); }
  res.json({ ok: true });
});

/* ---------------- stream file bytes (thumb / preview) ---------------- */
app.get("/api/file", (req, res) => {
  try {
    const full = path.resolve(String(req.query.path || ""));
    if (!canAccessPath(req.user, full)) return res.status(403).end();
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return res.status(404).end();
    const ext = extOf(full);
    // sendFile handles Range (video/audio seeking) and ETag/Last-Modified (304s);
    // no-cache = always revalidate, so edited files are never served stale
    res.sendFile(full, {
      headers: { "Cache-Control": "private, no-cache", ...(MIME[ext] ? { "Content-Type": MIME[ext] } : {}) },
      dotfiles: "allow",
    }, err => { if (err && !res.headersSent) res.status(err.status || 500).end(); });
  } catch {
    res.status(400).end();
  }
});

// save edits from the in-app text/code/markdown editor (focus view). Text-like files only —
// same TEXTLIKE allowlist manage_file's overwrite action already trusts. Overwrites directly (no
// approval-card flow here — that's the chat path; clicking Save in the editor IS the confirmation).
app.put("/api/file", async (req, res) => {
  try {
    const full = path.resolve(String((req.body || {}).path || ""));
    if (!canAccessPath(req.user, full)) return res.status(403).json({ error: "No access to that file." });
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return res.status(404).json({ error: "File not found." });
    if (!TEXTLIKE.has(extOf(full))) return res.status(400).json({ error: "Only text/code/markdown files can be edited here." });
    const content = String((req.body || {}).content ?? "");
    await fsp.writeFile(full, content);
    await buildIndex(path.dirname(full));   // keep RAG/search current for this folder
    const kb = kbDirFor(req.user);
    if (full.startsWith(kb + path.sep)) { try { await buildIndex(kb); } catch {} }   // KB copies are indexed separately from their folder
    res.json({ ok: true, size: fmtSize(Buffer.byteLength(content)) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------------- thumbnails — resized once per (file, mtime, width), cached forever ---------------- */
const THUMBS_DIR = path.join(DATA_DIR, "thumbs");
let thumbActive = 0; const thumbWaiters = [];   // cap concurrent decodes so a gallery load doesn't pin the CPU
const thumbSlot = () => thumbActive >= 3 ? new Promise(r => thumbWaiters.push(r)).then(() => thumbActive++) : void thumbActive++;
const thumbDone = () => { thumbActive--; const w = thumbWaiters.shift(); if (w) w(); };
app.get("/api/thumb", async (req, res) => {
  const sendOriginal = (full) => res.sendFile(full, { headers: { "Cache-Control": "private, no-cache" }, dotfiles: "allow" }, () => { if (!res.headersSent) res.status(404).end(); });
  try {
    const full = path.resolve(String(req.query.path || ""));
    if (!canAccessPath(req.user, full)) return res.status(403).end();
    let st; try { st = fs.statSync(full); } catch { return res.status(404).end(); }
    if (!st.isFile() || !isImageFile(full)) return res.status(404).end();
    if (st.size < 50 * 1024) return sendOriginal(full);   // already small — resizing wouldn't pay for itself
    const w = Math.min(Math.max(parseInt(req.query.w) || 480, 64), 1024);
    const cached = path.join(THUMBS_DIR, crypto.createHash("sha1").update(full + ":" + st.mtimeMs + ":" + w).digest("hex") + ".jpg");
    if (!fs.existsSync(cached)) {
      await thumbSlot();
      try {
        let img;
        try { const t = await exifr.thumbnail(full); if (t) { img = await Jimp.read(Buffer.from(t)); if (img.bitmap.width < w * 0.8) img = null; } } catch {}
        if (!img) img = await Jimp.read(full);
        if (img.bitmap.width > w) img.resize({ w });
        fs.mkdirSync(THUMBS_DIR, { recursive: true });
        fs.writeFileSync(cached, await img.getBuffer("image/jpeg", { quality: 82 }));
      } catch { return sendOriginal(full); }   // undecodable (e.g. HEIC) → browser gets the original, as before
      finally { thumbDone(); }
    }
    res.sendFile(cached, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=31536000, immutable" } },
      err => { if (err && !res.headersSent) res.status(500).end(); });
  } catch { if (!res.headersSent) res.status(500).end(); }
});

/* Image understanding (vision captions) → src/llm/vision.js
   Text extraction + PDF OCR + buildFileContext → src/rag/extract.js */

/* RAG engine — folder index (embeddings) → src/rag/index.js
   RAG retrieval (cosine + MMR + keyword) → src/rag/retrieve.js */

/* ============================================================
   Knowledge base — per-user uploads in data/users/<id>/kb, auto-indexed for RAG
   ============================================================ */
const KB_OK = new Set([...TEXTLIKE, "pdf", "docx", ...DESCRIBABLE_IMG]);   // extractable text + describable images
// safeName → src/util/files.js
const kbUpload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => cb(null, kbDirFor(req.user)),
    filename: (req, file, cb) => {
      const kb = kbDirFor(req.user);
      let base = safeName(file.originalname);
      const ext = path.extname(base), stem = base.slice(0, base.length - ext.length);
      let full = path.join(kb, base), i = 1;
      while (fs.existsSync(full)) { base = `${stem} (${i})${ext}`; full = path.join(kb, base); i++; }
      cb(null, base);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, KB_OK.has(extOf(file.originalname))),
});

app.post("/api/kb/upload", kbUpload.array("files", 50), async (req, res) => {
  try {
    const files = req.files || [];
    const saved = files.map(f => f.filename);
    // auto-describe uploaded images with the vision model so they're searchable
    let described = 0;
    for (const f of files) {
      if (isImageFile(f.filename)) {
        try { await describeImage(f.path, ""); described++; } catch (e) { console.error("describe:", e.message); }
      }
    }
    const stats = await buildIndex(kbDirFor(req.user));   // incremental — only new files embed
    res.json({ saved, savedPaths: files.map(f => f.path), described, ...stats });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/kb", async (req, res) => {
  try {
    const kb = kbDirFor(req.user);
    const p = path.resolve(String(req.query.path || ""));
    if (!p.startsWith(kb + path.sep)) return res.status(400).json({ error: "Not a knowledge-base file" });
    await fsp.rm(p, { force: true });
    delete imageMeta[p]; persistImageMeta();
    await buildIndex(kb);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ============================================================
   Projects — named workspaces with custom instructions + per-project KB
   ============================================================ */
function findProject(user, id) { return storesFor(user).projects.find(p => p.id === id) || null; }

app.get("/api/projects", (req, res) => {
  res.json({ projects: storesFor(req.user).projects });
});

app.post("/api/projects", (req, res) => {
  const { name, description = "", instructions = "", color = "#6366f1", icon = "sparkles" } = req.body || {};
  if (!String(name || "").trim()) return res.status(400).json({ error: "name required" });
  const st = storesFor(req.user);
  const project = {
    id: "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: String(name).trim().slice(0, 80),
    description: String(description).slice(0, 500),
    instructions: String(instructions).slice(0, 4000),
    color: String(color || "#6366f1"),
    icon: String(icon || "sparkles"),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  st.projects.push(project);
  st.save("projects.json");
  fs.mkdirSync(path.join(USERS_DIR, req.user.id, "projects", project.id, "kb"), { recursive: true });
  res.json({ project });
});

app.put("/api/projects/:id", (req, res) => {
  const st = storesFor(req.user);
  const p = st.projects.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: "Project not found" });
  const { name, description, instructions, color, icon } = req.body || {};
  if (name !== undefined) p.name = String(name).trim().slice(0, 80);
  if (description !== undefined) p.description = String(description).slice(0, 500);
  if (instructions !== undefined) p.instructions = String(instructions).slice(0, 4000);
  if (color !== undefined) p.color = String(color);
  if (icon !== undefined) p.icon = String(icon);
  p.updatedAt = Date.now();
  st.save("projects.json");
  res.json({ project: p });
});

app.delete("/api/projects/:id", async (req, res) => {
  const st = storesFor(req.user);
  const idx = st.projects.findIndex(x => x.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: "Project not found" });
  const [project] = st.projects.splice(idx, 1);
  st.save("projects.json");
  for (const bucket of Object.values(st.chats)) {
    for (const [sid, s] of Object.entries(bucket)) { if (s.projectId === project.id) delete bucket[sid]; }
  }
  st.save("chats.json");
  try { await fsp.rm(path.join(USERS_DIR, req.user.id, "projects", project.id), { recursive: true, force: true }); } catch {}
  res.json({ ok: true });
});

// walk a project's KB dir (including subfolders like generated/, where agent-created artifacts land)
// and return real files only — a flat readdir would otherwise report a subfolder itself as a "file".
async function listKbFilesRecursive(dir, rel = "") {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name.endsWith(".idx.json")) continue;
    const full = path.join(dir, e.name);
    const relName = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { out.push(...await listKbFilesRecursive(full, relName)); continue; }
    if (!e.isFile()) continue;
    try { const s = await fsp.stat(full); out.push({ name: relName, path: full, size: s.size, mtime: s.mtimeMs }); } catch {}
  }
  return out;
}
app.get("/api/projects/:id/kb", async (req, res) => {
  if (!findProject(req.user, req.params.id)) return res.status(404).json({ error: "Project not found" });
  const dir = projectKbDirFor(req.user, req.params.id);
  const files = await listKbFilesRecursive(dir);
  res.json({ files: files.sort((a, b) => b.mtime - a.mtime) });
});

const projectKbUpload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      if (!findProject(req.user, req.params.id)) return cb(new Error("Project not found"));
      cb(null, projectKbDirFor(req.user, req.params.id));
    },
    filename: (req, file, cb) => {
      const dir = projectKbDirFor(req.user, req.params.id);
      let base = safeName(file.originalname);
      const ext = path.extname(base), stem = base.slice(0, base.length - ext.length);
      let full = path.join(dir, base), i = 1;
      while (fs.existsSync(full)) { base = `${stem} (${i})${ext}`; full = path.join(dir, base); i++; }
      cb(null, base);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, KB_OK.has(extOf(file.originalname))),
});

app.post("/api/projects/:id/kb/upload", projectKbUpload.array("files", 50), async (req, res) => {
  try {
    if (!findProject(req.user, req.params.id)) return res.status(404).json({ error: "Project not found" });
    const files = req.files || [];
    let described = 0;
    for (const f of files) {
      if (isImageFile(f.filename)) { try { await describeImage(f.path, ""); described++; } catch {} }
    }
    const dir = projectKbDirFor(req.user, req.params.id);
    const stats = await buildIndex(dir);
    res.json({ saved: files.map(f => f.filename), described, ...stats });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/projects/:id/kb", async (req, res) => {
  try {
    if (!findProject(req.user, req.params.id)) return res.status(404).json({ error: "Project not found" });
    const dir = projectKbDirFor(req.user, req.params.id);
    const p = path.resolve(String(req.query.path || ""));
    if (!p.startsWith(dir + path.sep)) return res.status(400).json({ error: "Not a project KB file" });
    await fsp.rm(p, { force: true });
    delete imageMeta[p]; persistImageMeta();
    await buildIndex(dir);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ============================================================
   Custom agents — user-defined assistants with their own system prompt
   (full replace of the default persona), model/sampling overrides, and
   per-agent tool capability toggles. Stored in data/users/<id>/agents.json.
   ============================================================ */
function findAgent(user, id) { return storesFor(user).agents.find(a => a.id === id) || null; }
const DEFAULT_AGENT_TOOLS = { files: true, web: false, memory: true, connectors: true };
function cleanAgentTools(t) {
  t = t || {};
  return { files: t.files !== false, web: t.web === true, memory: t.memory !== false, connectors: t.connectors !== false };
}

app.get("/api/agents", (req, res) => {
  res.json({ agents: storesFor(req.user).agents });
});

app.post("/api/agents", (req, res) => {
  const { name, description = "", systemPrompt = "", model = "", temperature, maxTokens, topP, tools, color = "#0ea5e9", icon = "bolt" } = req.body || {};
  if (!String(name || "").trim()) return res.status(400).json({ error: "name required" });
  const st = storesFor(req.user);
  const agent = {
    id: "a" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: String(name).trim().slice(0, 80),
    description: String(description).slice(0, 500),
    systemPrompt: String(systemPrompt).slice(0, 8000),
    model: String(model || ""),
    temperature: typeof temperature === "number" ? temperature : null,
    maxTokens: typeof maxTokens === "number" ? maxTokens : null,
    topP: typeof topP === "number" ? topP : null,
    tools: cleanAgentTools(tools),
    color: String(color || "#0ea5e9"),
    icon: String(icon || "bolt"),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  st.agents.push(agent);
  st.save("agents.json");
  res.json({ agent });
});

app.put("/api/agents/:id", (req, res) => {
  const st = storesFor(req.user);
  const a = st.agents.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: "Agent not found" });
  const { name, description, systemPrompt, model, temperature, maxTokens, topP, tools, color, icon } = req.body || {};
  if (name !== undefined) a.name = String(name).trim().slice(0, 80);
  if (description !== undefined) a.description = String(description).slice(0, 500);
  if (systemPrompt !== undefined) a.systemPrompt = String(systemPrompt).slice(0, 8000);
  if (model !== undefined) a.model = String(model || "");
  if (temperature !== undefined) a.temperature = typeof temperature === "number" ? temperature : null;
  if (maxTokens !== undefined) a.maxTokens = typeof maxTokens === "number" ? maxTokens : null;
  if (topP !== undefined) a.topP = typeof topP === "number" ? topP : null;
  if (tools !== undefined) a.tools = cleanAgentTools(tools);
  if (color !== undefined) a.color = String(color);
  if (icon !== undefined) a.icon = String(icon);
  a.updatedAt = Date.now();
  st.save("agents.json");
  res.json({ agent: a });
});

app.delete("/api/agents/:id", (req, res) => {
  const st = storesFor(req.user);
  const idx = st.agents.findIndex(x => x.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: "Agent not found" });
  st.agents.splice(idx, 1);
  st.save("agents.json");
  // chats keep their agentId but fall back to the default agent once the custom one is gone
  res.json({ ok: true });
});

/* ============================================================
   Deep work roster — the multi-agent team (planner/researcher/drafter/critic) used by "Deep work"
   mode. Editable per user: enabled, prompt, whenToUse, temperature, maxTokens, researcher tools.
   The stable `kind` (not editable) drives the pipeline; overrides persist to roster.json, merged
   over code defaults by rosterFor(). See ROSTER_DEFAULTS / multiAgentPipeline.
   ============================================================ */
app.get("/api/roster", (req, res) => {
  res.json({ roster: rosterFor(req.user) });
});

app.put("/api/roster/:kind", (req, res) => {
  const def = ROSTER_DEFAULTS.find(d => d.kind === req.params.kind);
  if (!def) return res.status(404).json({ error: "Unknown agent" });
  const st = storesFor(req.user);
  let o = st.roster.find(a => a.kind === def.kind);
  if (!o) { o = { kind: def.kind }; st.roster.push(o); }
  const b = req.body || {};
  if (b.enabled !== undefined && !def.required) o.enabled = b.enabled !== false;
  if (typeof b.model === "string") o.model = b.model.slice(0, 200);   // "" = use the chat's chosen model
  if (typeof b.role === "string") o.role = b.role.slice(0, 8000);
  if (typeof b.whenToUse === "string") o.whenToUse = b.whenToUse.slice(0, 500);
  if (typeof b.temperature === "number") o.temperature = Math.max(0, Math.min(1, b.temperature));
  if (typeof b.maxTokens === "number") o.maxTokens = Math.max(128, Math.min(8192, Math.round(b.maxTokens)));
  if (Array.isArray(b.toolNames) && def.allToolNames) o.toolNames = b.toolNames.map(String).filter(n => def.allToolNames.includes(n));
  st.save("roster.json");
  res.json({ roster: rosterFor(req.user) });
});

app.post("/api/roster/reset", (req, res) => {
  const st = storesFor(req.user);
  st.roster = [];
  st.save("roster.json");
  res.json({ roster: rosterFor(req.user) });
});

/* ---------------- image: describe (vision) + read its searchable description ---------------- */
app.get("/api/image/meta", (req, res) => {
  const p = path.resolve(String(req.query.path || ""));
  if (!guardPath(req, res, p)) return;
  const m = imageMeta[p];
  res.json({ described: !!m, context: m ? m.context : "", description: m ? m.description : "" });
});
app.post("/api/image/describe", async (req, res) => {
  try {
    const { path: imgPath, context = "", instructions = "" } = req.body || {};
    const p = path.resolve(String(imgPath || ""));
    if (!guardPath(req, res, p)) return;
    if (!fs.existsSync(p) || !isImageFile(p)) return res.status(400).json({ error: "Not an image file" });
    const meta = await describeImage(p, context, instructions);
    // refresh the KB/main index (described images are globally searchable) + the file's own folder
    const kb = kbDirFor(req.user);
    try { await buildIndex(kb); } catch {}
    if (!p.startsWith(kb + path.sep)) { try { await buildIndex(path.dirname(p)); } catch {} }
    res.json({ described: true, context: meta.context, description: meta.description });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

/* ---------------- content search (gallery search box: name + meaning + exact) ---------------- */
app.get("/api/search", async (req, res) => {
  try {
    const folder = path.resolve(String(req.query.path || ""));
    if (!guardPath(req, res, folder)) return;
    const q = String(req.query.q || "").trim();
    if (!q) return res.json({ names: [] });
    if (!loadIndex(folder)) { try { await buildIndex(folder); } catch {} }
    const names = new Set();
    try {
      const { hits } = await retrieve(folder, q, 12);
      hits.filter(h => h.score >= 0.5).forEach(h => names.add(h.name));   // natural-language recall
    } catch {}
    const idx = loadIndex(folder);
    if (idx) {
      const needle = q.toLowerCase();
      for (const f of Object.values(idx.files)) if (f.chunks.some(c => c.text.toLowerCase().includes(needle))) names.add(f.name);
    }
    res.json({ names: [...names] });
  } catch { res.json({ names: [] }); }
});

/* ---------------- folder index (RAG) endpoints ---------------- */
// build / update a folder's vector index
app.post("/api/index", async (req, res) => {
  try {
    const folderPath = String((req.body || {}).path || "");
    if (!folderPath) return res.status(400).json({ error: "path required" });
    if (!guardPath(req, res, folderPath)) return;
    const stats = await buildIndex(folderPath);
    res.json(stats);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});
// index status for a folder
app.get("/api/index", (req, res) => {
  const folderPath = String(req.query.path || "");
  if (folderPath && !guardPath(req, res, folderPath)) return;
  const idx = folderPath && loadIndex(folderPath);
  if (!idx) return res.json({ indexed: false });
  const chunks = Object.values(idx.files).reduce((n, f) => n + f.chunks.length, 0);
  res.json({ indexed: true, files: Object.keys(idx.files).length, chunks, updatedAt: idx.updatedAt });
});

/* Perceptual image hashing + related-files (computeDHash/getPhash/hammingHex/
   warmPhashes/relatedImages/relatedFor, DUP_EXACT/DUP_NEAR) → src/media/phash.js */

// findFileOnDisk → src/agent/core.js
app.get("/api/related", async (req, res) => {
  try {
    const p = path.resolve(String(req.query.path || ""));
    if (!canAccessPath(req.user, p)) return res.json({ related: [] });
    res.json({ related: await relatedFor(p, kbDirFor(req.user)) });
  }
  catch { res.json({ related: [] }); }
});

/* ============================================================
   Duplicate finder — cluster a folder's images by perceptual-hash
   distance (union-find). "exact" = byte-near re-saves/copies,
   "similar" = bursts, crops, edits. Reuses the mtime-cached pHashes.
   DUP_EXACT/DUP_NEAR thresholds → src/media/phash.js
   ============================================================ */
app.get("/api/duplicates", async (req, res) => {
  try {
    const root = path.resolve(String(req.query.path || ""));
    if (!guardPath(req, res, root)) return;
    let st; try { st = fs.statSync(root); } catch { return res.status(400).json({ error: "Folder not found" }); }
    if (!st.isDirectory()) return res.status(400).json({ error: "Not a folder" });
    const images = (await walkFiles(root)).filter(p => isImageFile(p));
    const hashed = (await mapLimit(images, 4, async p => ({ path: p, h: await getPhash(p) }))).filter(x => x.h);
    const parent = hashed.map((_, i) => i);
    const find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
    for (let i = 0; i < hashed.length; i++)
      for (let j = i + 1; j < hashed.length; j++)
        if (hammingHex(hashed[i].h, hashed[j].h) <= DUP_NEAR) parent[find(i)] = find(j);
    const clusters = new Map();
    hashed.forEach((_, i) => { const r = find(i); (clusters.get(r) || clusters.set(r, []).get(r)).push(i); });
    const groups = [];
    for (const idxs of clusters.values()) {
      if (idxs.length < 2) continue;
      let maxD = 0;
      for (let a = 0; a < idxs.length; a++) for (let b = a + 1; b < idxs.length; b++)
        maxD = Math.max(maxD, hammingHex(hashed[idxs[a]].h, hashed[idxs[b]].h));
      const files = [];
      for (const i of idxs) {
        let s; try { s = await fsp.stat(hashed[i].path); } catch { continue; }
        files.push({ name: path.basename(hashed[i].path), path: hashed[i].path, bytes: s.size, mtime: s.mtimeMs });
      }
      if (files.length < 2) continue;
      files.sort((a, b) => b.bytes - a.bytes);   // largest first — usually the original / highest-res
      groups.push({ kind: maxD <= DUP_EXACT ? "exact" : "similar", files, wasted: files.slice(1).reduce((n, f) => n + f.bytes, 0) });
    }
    groups.sort((a, b) => (a.kind === b.kind ? b.wasted - a.wasted : a.kind === "exact" ? -1 : 1));
    res.json({ scanned: hashed.length, groups });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// delete the duplicates the user chose (images only) and clean their sidecar entries
app.post("/api/duplicates/delete", async (req, res) => {
  try {
    const paths = accessibleOnly(req, Array.isArray((req.body || {}).paths) ? req.body.paths : []);
    let deleted = 0;
    for (const p0 of paths) {
      const p = path.resolve(String(p0));
      if (!isImageFile(p)) continue;
      let s; try { s = await fsp.stat(p); } catch { continue; }
      if (!s.isFile()) continue;
      await fsp.rm(p, { force: true });
      delete tagStore[p]; delete imageMeta[p]; delete phashStore[p];
      deleted++;
    }
    if (deleted) { persistTags(); persistImageMeta(); persistPhash(); }
    res.json({ deleted });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// one-click structured extraction over a folder (the "Extract to table" button) — runs directly, no agent routing
app.post("/api/extract", async (req, res) => {
  try {
    const b = req.body || {};
    let files;
    if (Array.isArray(b.paths) && b.paths.length) {   // specific files (e.g. just-uploaded docs)
      files = accessibleOnly(req, b.paths.map(p => path.resolve(String(p)))).filter(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }).slice(0, 30);
    } else {
      const dir = path.resolve(String(b.path || ""));
      if (!guardPath(req, res, dir)) return;
      try { const st = fs.statSync(dir); files = st.isFile() ? [dir] : (await walkFiles(dir)).slice(0, 30); } catch { return res.status(400).json({ error: "Path not found" }); }
    }
    if (!files.length) return res.json({ columns: [], rows: [], total: 0 });
    const fields = Array.isArray(b.fields) ? b.fields : (typeof b.fields === "string" && b.fields.trim() ? b.fields.split(",").map(s => s.trim()).filter(Boolean) : null);
    const { columns, rows } = await runExtraction(files, fields);
    res.json({ columns, rows, total: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------------- photo locations (map view) ----------------
   GPS read from EXIF, cached per path+mtime so we don't re-parse every visit. */
// EXIF GPS cache + geoFor → src/media/photos.js (geoStore/persistGeo → src/state/sidecars.js)
// every geotagged image under a folder (or the KB) → markers for the map
app.get("/api/geo", async (req, res) => {
  const p = path.resolve(String(req.query.path || ""));
  if (!guardPath(req, res, p)) return;
  try {
    const files = (await walkFiles(p)).filter(f => isImageFile(f));
    const photos = [];
    for (const f of files) {
      const gps = await geoFor(f);
      if (gps) photos.push({ path: f, name: path.basename(f), lat: gps.lat, lng: gps.lng, taken: gps.taken || null });
    }
    res.json({ photos, scanned: files.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------------- faces (people albums) ----------------
   Per-image face descriptors computed in the renderer by face-api.js, cached by path+mtime.
   Shared path-keyed sidecar (describes disk files, like geo/phash). Names live per-user (people.json). */
// face-descriptor cache (faceStore/persistFaces) → src/state/sidecars.js
// FACE_SCAN_VERSION + face/people helpers (faceDist/tagPhotos/personDescs/upsertPerson) → src/media/photos.js

// the scanner asks what images are in scope and which still need processing
app.get("/api/faces/list", async (req, res) => {
  const p = path.resolve(String(req.query.path || ""));
  if (!guardPath(req, res, p)) return;
  try {
    const files = (await walkFiles(p)).filter(f => isImageFile(f));
    const images = files.map(f => {
      let mtime = 0; try { mtime = fs.statSync(f).mtimeMs; } catch {}
      const c = faceStore[f];
      return { path: f, name: path.basename(f), mtime, cached: !!(c && c.mtime === mtime && c.v === FACE_SCAN_VERSION) };
    });
    res.json({ images });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// save one image's detected faces
app.post("/api/faces", (req, res) => {
  const { path: p, mtime, faces } = req.body || {};
  const fp = path.resolve(String(p || ""));
  if (!canAccessPath(req.user, fp)) return res.status(403).json({ error: "No access" });
  if (!Array.isArray(faces)) return res.status(400).json({ error: "faces[] required" });
  // keep payload sane: 128-float descriptor + normalized box per face
  faceStore[fp] = {
    mtime: Number(mtime) || 0,
    v: FACE_SCAN_VERSION,
    faces: faces.slice(0, 50).map(f => ({
      descriptor: Array.isArray(f.descriptor) ? f.descriptor.slice(0, 128).map(Number) : [],
      box: f.box ? { x: +f.box.x || 0, y: +f.box.y || 0, w: +f.box.w || 0, h: +f.box.h || 0 } : null,
    })).filter(f => f.descriptor.length === 128),
  };
  persistFaces();
  res.json({ ok: true, count: faceStore[fp].faces.length });
});

// all cached faces under a folder, flattened (one entry per face) — for clustering on the client.
// includes any authoritative person assignment so corrections survive re-clustering.
app.get("/api/faces", async (req, res) => {
  const p = path.resolve(String(req.query.path || ""));
  if (!guardPath(req, res, p)) return;
  try {
    const st = storesFor(req.user);
    const files = (await walkFiles(p)).filter(f => isImageFile(f));
    const out = [];
    for (const f of files) {
      const c = faceStore[f];
      if (!c || !c.faces) continue;
      c.faces.forEach((face, i) => out.push({
        path: f, name: path.basename(f), index: i, descriptor: face.descriptor, box: face.box,
        personId: face.personId || null,
        personName: face.personId && st.people[face.personId] ? st.people[face.personId].name : null,
      }));
    }
    res.json({ faces: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------------- named people (per user) ----------------
   A named person = a label + the descriptor centroid (so new/unscanned faces auto-match by nearest
   centroid). Naming also tags the photos so they're searchable by the person's name everywhere. */
app.get("/api/people", (req, res) => {
  const st = storesFor(req.user);
  res.json({ people: Object.entries(st.people).map(([id, p]) => ({
    id, name: p.name, count: (p.photos || []).length,
    descriptors: personDescs(p),                                  // for cross-scan auto-matching on the client
    rep: p.rep || null,                                           // representative face {path, box} for the tile
    photo: (p.photos || []).find(ph => canAccessPath(req.user, ph)) || null,
  })).sort((a, b) => b.count - a.count) });
});
// one person's photos (accessible to this user)
app.get("/api/people/:id", (req, res) => {
  const st = storesFor(req.user);
  const p = st.people[req.params.id];
  if (!p) return res.status(404).json({ error: "Person not found" });
  res.json({ id: req.params.id, name: p.name, rep: p.rep || null, photos: (p.photos || []).filter(ph => canAccessPath(req.user, ph)) });
});
// assign a face (cluster or single) to a person → upsertPerson in src/media/photos.js
app.post("/api/people", (req, res) => {
  const b = req.body || {};
  const descriptors = Array.isArray(b.descriptors) ? b.descriptors : [Array.isArray(b.descriptor) ? b.descriptor : b.centroid];
  const pid = upsertPerson(req.user, { id: b.id, name: b.name, descriptors, photos: b.photos, rep: b.rep });
  if (!pid) return res.status(400).json({ error: "name and a 128-d descriptor are required" });
  res.json({ id: pid, name: String(b.name).trim().slice(0, 60) });
});
// faces in one photo (with any authoritative person assignment) — used by the lightbox
app.get("/api/faces/one", (req, res) => {
  const fp = path.resolve(String(req.query.path || ""));
  if (!canAccessPath(req.user, fp)) return res.status(403).json({ error: "No access" });
  const st = storesFor(req.user);
  const rec = faceStore[fp];
  let mtime = 0; try { mtime = fs.statSync(fp).mtimeMs; } catch {}
  // scanned = a current-version scan exists for the file as it is on disk now; lets the UI tell
  // "scanned, genuinely no faces" apart from "never scanned / stale" (which is re-scannable).
  const scanned = !!(rec && rec.v === FACE_SCAN_VERSION && rec.mtime === mtime);
  const faces = ((rec && rec.faces) || []).map((f, i) => ({
    index: i, box: f.box, descriptor: f.descriptor, personId: f.personId || null,
    name: f.personId && st.people[f.personId] ? st.people[f.personId].name : null,
  }));
  res.json({ faces, scanned, mtime });
});
// assign one face in a photo to a person AUTHORITATIVELY (overrides the auto-suggestion permanently).
// Empty name clears the assignment.
app.post("/api/faces/assign", (req, res) => {
  const { path: p, index, name } = req.body || {};
  const fp = path.resolve(String(p || ""));
  if (!canAccessPath(req.user, fp)) return res.status(403).json({ error: "No access" });
  const rec = faceStore[fp];
  const face = rec && rec.faces && rec.faces[Number(index)];
  if (!face) return res.status(404).json({ error: "face not found" });
  const nm = String(name || "").trim().slice(0, 60);
  if (!nm) { delete face.personId; persistFaces(); return res.json({ ok: true, cleared: true }); }
  const pid = upsertPerson(req.user, { name: nm, descriptors: [face.descriptor], photos: [fp], rep: { path: fp, box: face.box } });
  if (!pid) return res.status(400).json({ error: "could not assign" });
  face.personId = pid; persistFaces();
  res.json({ id: pid, name: nm });
});
// assign a whole cluster of faces to a person AUTHORITATIVELY (each face is stamped, so a later
// re-match honors the correction instead of re-guessing from loose descriptor similarity).
app.post("/api/faces/assign-bulk", (req, res) => {
  const { faces, name } = req.body || {};
  const nm = String(name || "").trim().slice(0, 60);
  if (!nm || !Array.isArray(faces) || !faces.length) return res.status(400).json({ error: "faces[] and name required" });
  const descriptors = [], photos = []; let rep = null; const stamp = [];
  for (const a of faces) {
    const fp = path.resolve(String(a.path || ""));
    if (!canAccessPath(req.user, fp)) continue;
    const rec = faceStore[fp]; const face = rec && rec.faces && rec.faces[Number(a.index)];
    if (!face) continue;
    descriptors.push(face.descriptor); photos.push(fp); stamp.push(face);
    if (!rep) rep = { path: fp, box: face.box };
  }
  if (!descriptors.length) return res.status(400).json({ error: "no faces found" });
  const pid = upsertPerson(req.user, { name: nm, descriptors: descriptors.slice(0, 12), photos, rep });
  if (!pid) return res.status(400).json({ error: "could not assign" });
  for (const face of stamp) face.personId = pid;   // authoritative per-face stamp
  persistFaces();
  res.json({ id: pid, name: nm, count: stamp.length });
});
// rename a person (keeps centroid + photos; re-tags)
app.put("/api/people/:id", (req, res) => {
  const st = storesFor(req.user);
  const p = st.people[req.params.id];
  if (!p) return res.status(404).json({ error: "Person not found" });
  const nm = String((req.body || {}).name || "").trim().slice(0, 60);
  if (!nm) return res.status(400).json({ error: "name required" });
  if (p.name) tagPhotos(p.photos || [], p.name, false);
  p.name = nm; p.updatedAt = Date.now();
  tagPhotos(p.photos || [], nm, true);
  st.save("people.json");
  res.json({ id: req.params.id, name: nm });
});
app.delete("/api/people/:id", (req, res) => {
  const st = storesFor(req.user);
  const p = st.people[req.params.id];
  if (p && p.name && p.photos) tagPhotos(p.photos, p.name, false);
  delete st.people[req.params.id];
  st.save("people.json");
  res.json({ ok: true });
});

/* ============================================================
   Knowledge graph — entity layer over photos + documents.
   LLM-light by design: the chat model is NEVER called to build the graph. Nodes/edges
   come from signals we already compute — named people (face clusters), GPS places,
   autotags — plus deterministic NER over the text that's ALREADY in the search index.
   Per-doc entities cache by mtime (data/entities.json), so it's incremental.
   ============================================================ */
// Knowledge graph — entity NER, buildGraph/graphFor (+graphCache), ensurePhotoGeo,
// docExcerptsFor, graphRetrieve, reverseGeocode → src/media/graph.js
// the whole graph (nodes carry counts, not the underlying item lists)
app.get("/api/graph", async (req, res) => {
  try {
    // on Rebuild, scan known photos for GPS so Places appear without visiting the Photo Map first
    if (req.query.refresh === "1") { try { await ensurePhotoGeo(req.user); graphCache.delete(req.user.id); } catch {} }
    // opt-in place naming: reverse-geocode up to N un-named place clusters in this user's graph, cache, rebuild
    if (req.query.geocode === "1") {
      const g0 = graphFor(req.user, true);
      const missing = g0.nodes.filter(n => n.kind === "place" && !placeNames[n.id.slice(6)]).slice(0, 16);
      let done = 0;
      for (const n of missing) {
        const key = n.id.slice(6); const [lat, lng] = key.split(",").map(Number);
        try { const name = await reverseGeocode(lat, lng); if (name) { placeNames[key] = name; done++; } } catch {}
      }
      if (done) { persistPlaceNames(); graphCache.delete(req.user.id); }
    }
    const g = graphFor(req.user, req.query.refresh === "1" || req.query.geocode === "1");
    const unnamedPlaces = g.nodes.filter(n => n.kind === "place" && !placeNames[n.id.slice(6)]).length;
    res.json({
      nodes: g.nodes.map(n => ({ id: n.id, label: n.label, kind: n.kind, weight: n.weight, photos: n.photos.size, docs: n.docs.size })),
      edges: g.edges,
      stats: { nodes: g.nodes.length, edges: g.edges.length, unnamedPlaces },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// one entity's neighborhood + the photos/docs behind it (for the detail panel)
app.get("/api/graph/entity", (req, res) => {
  const g = graphFor(req.user, false);
  const n = g.nodes.find(x => x.id === String(req.query.id || ""));
  if (!n) return res.status(404).json({ error: "Not found" });
  const byId = Object.fromEntries(g.nodes.map(x => [x.id, x]));
  const nb = {};
  for (const e of g.edges) { const other = e.a === n.id ? e.b : e.b === n.id ? e.a : null; if (other) nb[other] = (nb[other] || 0) + e.w; }
  const neighbors = Object.entries(nb).sort((a, b) => b[1] - a[1]).slice(0, 30)
    .map(([id, w]) => byId[id] && { id, label: byId[id].label, kind: byId[id].kind, w }).filter(Boolean);
  const photos = [...n.photos].filter(p => { try { return fs.existsSync(p); } catch { return false; } }).slice(0, 60);
  const docs = [...n.docs].filter(p => { try { return fs.existsSync(p); } catch { return false; } }).slice(0, 60).map(p => ({ path: p, name: path.basename(p) }));
  res.json({ id: n.id, label: n.label, kind: n.kind, weight: n.weight, neighbors, photos, docs });
});

/* ---------------- photo EXIF (date, camera, GPS) ---------------- */
app.get("/api/exif", async (req, res) => {
  try {
    const p = path.resolve(String(req.query.path || ""));
    if (!canAccessPath(req.user, p)) return res.json({});
    if (!isImageFile(p)) return res.json({});
    const x = await exifr.parse(p, { gps: true }).catch(() => null);
    if (!x) return res.json({});
    const camera = [x.Make, x.Model].filter(Boolean).join(" ").trim();
    const lensSettings = [x.FocalLength ? `${Math.round(x.FocalLength)}mm` : null, x.FNumber ? `f/${x.FNumber}` : null, x.ISO ? `ISO ${x.ISO}` : null].filter(Boolean).join(" · ");
    const taken = x.DateTimeOriginal || x.CreateDate || null;
    const dims = (x.ExifImageWidth && x.ExifImageHeight) ? `${x.ExifImageWidth}×${x.ExifImageHeight}` : null;
    const gps = (typeof x.latitude === "number" && typeof x.longitude === "number") ? { lat: x.latitude, lng: x.longitude } : null;
    res.json({ camera, settings: lensSettings, taken: taken ? new Date(taken).toLocaleString() : null, dims, gps });
  } catch { res.json({}); }
});

/* ---------------- batch actions (gallery multi-select) ---------------- */
app.post("/api/tag", async (req, res) => {
  try {
    const { tags = [] } = req.body || {};
    const paths = accessibleOnly(req, (req.body || {}).paths || []);
    const dirs = new Set();
    for (const p0 of paths) {
      const p = path.resolve(p0);
      setTags(p, [...new Set([...getTags(p), ...tags.map(String)])]);
      dirs.add(path.dirname(p));
    }
    for (const d of dirs) { try { await buildIndex(d); } catch {} }
    try { await buildIndex(kbDirFor(req.user)); } catch {}
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/kb/add", async (req, res) => {
  try {
    const kb = kbDirFor(req.user);
    const paths = accessibleOnly(req, (req.body || {}).paths || []);
    const added = [];
    for (const p0 of paths) {
      const src = path.resolve(p0);
      if (src.startsWith(kb + path.sep)) continue;   // already in KB
      let st; try { st = await fsp.stat(src); } catch { continue; }
      if (!st.isFile()) continue;
      let base = safeName(path.basename(src)), dest = path.join(kb, base), i = 1;
      const ext = path.extname(base), stem = base.slice(0, base.length - ext.length);
      while (fs.existsSync(dest)) { dest = path.join(kb, `${stem} (${i})${ext}`); i++; }
      await fsp.copyFile(src, dest);
      if (isImageFile(dest)) { try { await describeImage(dest, ""); } catch {} }
      added.push(path.basename(dest));
    }
    await buildIndex(kb);
    res.json({ added });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// what a file is "about", for AI tagging/renaming: vision description for images, extracted text for docs
// contentBasis (autotag/rename reasoning text) → src/rag/extract-batch.js
const AUTOTAG_SYS ='You tag files for a personal library. Reply ONLY with a JSON object {"tags":["…"]} of 2-4 lowercase tags (1-2 words each) capturing the file\'s subject and useful categories. Never use generic tags like "file", "image", "document", "photo".';
app.post("/api/batch/autotag", async (req, res) => {
  try {
    const paths = accessibleOnly(req, (Array.isArray((req.body || {}).paths) ? req.body.paths : []).map(p => path.resolve(String(p)))).slice(0, 40);
    const tagged = {}, dirs = new Set();
    for (const p of paths) {
      const basis = await contentBasis(p);
      if (!basis.trim()) continue;
      const j = await completeJSON(OLLAMA_MODEL, AUTOTAG_SYS, `FILENAME: ${path.basename(p)}\n\nCONTENT:\n${basis}`, 120);
      const tags = (j && Array.isArray(j.tags) ? j.tags : []).map(t => String(t).toLowerCase().trim()).filter(t => t && t.length <= 30).slice(0, 4);
      if (!tags.length) continue;
      tagged[p] = setTags(p, [...getTags(p), ...tags]);
      dirs.add(path.dirname(p));
    }
    for (const d of dirs) { try { await buildIndex(d); } catch {} }
    if (dirs.size) { try { await buildIndex(kbDirFor(req.user)); } catch {} }
    res.json({ tagged });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
const RENAME_SYS = 'You suggest descriptive filenames. Reply ONLY with JSON {"name":"…"} — a short lowercase kebab-case filename stem (3-6 words, no extension, only letters/digits/hyphens) saying what the file IS from its content, e.g. "receipt-uniqlo-2024-03" or "kids-birthday-cake-candles".';
app.post("/api/batch/rename/suggest", async (req, res) => {
  try {
    const paths = accessibleOnly(req, (Array.isArray((req.body || {}).paths) ? req.body.paths : []).map(p => path.resolve(String(p)))).slice(0, 40);
    const proposals = [];
    for (const p of paths) {
      let st; try { st = await fsp.stat(p); } catch { continue; }
      if (!st.isFile()) continue;
      const basis = await contentBasis(p);
      const ext = path.extname(p);
      let stem = "";
      if (basis.trim()) {
        const j = await completeJSON(OLLAMA_MODEL, RENAME_SYS, `CURRENT NAME: ${path.basename(p)}\n\nCONTENT:\n${basis}`, 80);
        stem = String((j && j.name) || "").toLowerCase().replace(/\.[a-z0-9]+$/i, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
      }
      proposals.push({ path: p, current: path.basename(p), proposed: stem ? stem + ext : path.basename(p) });
    }
    res.json({ proposals });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/batch/rename/apply", async (req, res) => {
  try {
    const renames = Array.isArray((req.body || {}).renames) ? req.body.renames : [];
    const renamed = [], dirs = new Set();
    for (const r of renames) {
      const src = path.resolve(String(r.path || ""));
      if (!canAccessPath(req.user, src)) continue;
      let st; try { st = await fsp.stat(src); } catch { continue; }
      if (!st.isFile()) continue;
      const base = safeName(String(r.name || ""));
      if (!base || base === path.basename(src)) continue;
      const ext = path.extname(base), stem = base.slice(0, base.length - ext.length);
      let dest = path.join(path.dirname(src), base), i = 1;
      while (fs.existsSync(dest)) { dest = path.join(path.dirname(src), `${stem} (${i})${ext}`); i++; }
      await fsp.rename(src, dest);
      for (const store of [tagStore, imageMeta, phashStore]) {
        if (store[src]) { store[dest] = store[src]; delete store[src]; }
      }
      persistTags(); persistImageMeta(); persistPhash();
      dirs.add(path.dirname(src));
      renamed.push({ from: path.basename(src), to: path.basename(dest) });
    }
    for (const d of dirs) { try { await buildIndex(d); } catch {} }
    if (dirs.size) { try { await buildIndex(kbDirFor(req.user)); } catch {} }
    res.json({ renamed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------------- long-term memory ---------------- */
app.get("/api/memory", (req, res) => res.json({ memory: storesFor(req.user).memory.map(memPublic) }));
app.post("/api/memory", async (req, res) => {
  const t = String((req.body || {}).text || "").trim();
  if (!t) return res.status(400).json({ error: "text required" });
  res.json(await addMemory(req.user, t, "manual", (req.body || {}).type));
});
// edit a memory's text or type (Manage page)
app.patch("/api/memory/:id", async (req, res) => {
  const st = storesFor(req.user);
  const m = st.memory.find(x => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: "Not found" });
  const b = req.body || {};
  if (typeof b.text === "string" && b.text.trim() && b.text.trim() !== m.text) {
    m.text = b.text.trim(); m.updatedAt = Date.now();
    try { [m.vec] = await embed([m.text]); } catch {}
  }
  if (MEM_TYPES.has(b.type)) m.type = b.type;
  st.save("memory.json");
  res.json(memPublic(m));
});
app.delete("/api/memory/:id", (req, res) => {
  const st = storesFor(req.user);
  st.memory = st.memory.filter(m => m.id !== req.params.id);
  st.save("memory.json");
  res.json({ ok: true });
});
// wipe ALL memory for the signed-in user (Settings → danger zone)
app.delete("/api/memory", (req, res) => {
  const st = storesFor(req.user);
  const n = st.memory.length;
  st.memory = [];
  st.save("memory.json");
  res.json({ ok: true, deleted: n });
});

/* ---------------- per-user feature settings (e.g. reflection) ---------------- */
app.get("/api/user-settings", (req, res) => res.json({ settings: storesFor(req.user).settings || {} }));
app.patch("/api/user-settings", (req, res) => {
  const st = storesFor(req.user);
  const b = req.body || {};
  if (typeof b.reflection === "boolean") st.settings.reflection = b.reflection;
  st.save("settings.json");
  res.json({ settings: st.settings });
});

// probe a local Draw Things HTTP API server: confirm reachability and list installed model files
app.post("/api/drawthings/test", async (req, res) => {
  const { url, secret } = req.body || {};
  // only an admin may point this at a non-default host — a member-supplied url is an SSRF vector (server-side fetch to an attacker-chosen host)
  const effectiveUrl = (req.user.role === "admin" && url) || "http://localhost:7860";
  try {
    const echo = await dtEcho({ url: effectiveUrl, sharedSecret: secret || undefined });
    // prefer model-looking filenames, but fall back to whatever the server reported
    const named = (echo.files || []).filter(f => /\.(ckpt|safetensors|pt|gguf)$/i.test(f));
    const models = named.length ? named : (echo.files || []);
    res.json({ ok: true, models, files: echo.files, sharedSecretMissing: echo.sharedSecretMissing });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// pick the kb dir for the request (project-scoped if a valid projectId is supplied)
function imageKbDir(req) {
  const pid = req.body && req.body.projectId;
  return (pid && findProject(req.user, pid)) ? projectKbDirFor(req.user, pid) : kbDirFor(req.user);
}
// members can't redirect the server's outbound request to an arbitrary host (SSRF) — only an
// admin's supplied url is honored; everyone else always hits the local default.
function drawThingsFrom(req) {
  const url = (req.user.role === "admin" && req.body.drawThingsUrl) || "http://localhost:7860";
  return { url, model: req.body.drawThingsModel || undefined, secret: req.body.drawThingsSecret || undefined };
}
// shape a saved generated image for the client (matches the renders.jsx "images" item)
function imageItem(p) {
  const enc = encodeURIComponent(p);
  return { path: p, url: "/api/file?path=" + enc, image: "/api/file?path=" + enc, thumb: "/api/thumb?path=" + enc + "&w=384", title: path.basename(p) };
}

// direct text-to-image: enhance the prompt (optional), generate via Draw Things, save under <kb>/generated/
app.post("/api/image/create", async (req, res) => {
  try {
    const b = req.body || {};
    const prompt = String(b.prompt || "").trim();
    if (!prompt) return res.json({ ok: false, error: "A prompt is required." });
    const dt = drawThingsFrom(req);
    const enhance = b.enhance !== false;
    const finalPrompt = enhance ? await enhancePrompt(b.model || OLLAMA_MODEL, prompt, "create") : prompt;
    const { images } = await dtGenerate({
      url: dt.url, sharedSecret: dt.secret, model: dt.model,
      prompt: finalPrompt, negativePrompt: b.negativePrompt || "",
      width: Number(b.width) || 512, height: Number(b.height) || 512,
      steps: Number(b.steps) || 4, guidanceScale: b.guidanceScale != null ? Number(b.guidanceScale) : 1.5,
    });
    const kb = imageKbDir(req);
    const items = [];
    for (const im of images) items.push(imageItem(await saveGeneratedImage(kb, im.png, prompt)));
    res.json({ ok: true, original: prompt, prompt: finalPrompt, enhanced: enhance && finalPrompt !== prompt, items });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// edit an image (image-to-image): the source (a library path, access-checked, or a data URL)
// is loaded as the canvas base and regenerated with the user's change applied. `strength`
// controls how much it preserves the original (lower = closer to the source).
app.post("/api/image/edit", async (req, res) => {
  try {
    const b = req.body || {};
    const prompt = String(b.prompt || "").trim();
    if (!prompt) return res.json({ ok: false, error: "A prompt is required." });
    let imageBuffer = null, label = prompt;
    if (b.path) {
      const p = path.resolve(String(b.path));
      if (!canAccessPath(req.user, p) || !fs.existsSync(p) || !isImageFile(p)) return res.json({ ok: false, error: "No access to that image, or it isn't an image file." });
      imageBuffer = await fsp.readFile(p);
      label = `edit of ${path.basename(p)}`;
    } else if (b.dataUrl) {
      imageBuffer = Buffer.from(String(b.dataUrl).replace(/^data:[^,]*,/, ""), "base64");
    }
    if (!imageBuffer || !imageBuffer.length) return res.json({ ok: false, error: "A base image (path or dataUrl) is required to edit." });
    const dt = drawThingsFrom(req);
    const enhance = b.enhance !== false;
    const finalPrompt = enhance ? await enhancePrompt(b.model || OLLAMA_MODEL, prompt, "edit") : prompt;
    const strength = typeof b.strength === "number" ? Math.max(0.05, Math.min(1, b.strength)) : 0.99;
    const maxDim = b.maxDim != null ? Number(b.maxDim) : 1024;   // 0 = original resolution
    const { images } = await dtEdit({
      url: dt.url, sharedSecret: dt.secret, model: dt.model, imageBuffer, maxDim,
      prompt: finalPrompt, negativePrompt: b.negativePrompt || "", strength,
      steps: Number(b.steps) || 4, guidanceScale: b.guidanceScale != null ? Number(b.guidanceScale) : 1.5,
    });
    const kb = imageKbDir(req);
    const items = [];
    for (const im of images) items.push(imageItem(await saveGeneratedImage(kb, im.png, label)));
    res.json({ ok: true, original: prompt, prompt: finalPrompt, enhanced: enhance && finalPrompt !== prompt, items });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

/* ---------------- skills: reusable how-to procedures (learning loop) ---------------- */
app.get("/api/skills", (req, res) => res.json({ skills: storesFor(req.user).skills.map(skillPublic) }));
app.post("/api/skills", async (req, res) => {
  const b = req.body || {};
  const sk = await addSkill(req.user, { title: b.title, steps: b.steps, trigger: b.trigger, tags: b.tags });
  if (!sk) return res.status(400).json({ error: "title and steps required" });
  res.json(sk);
});
app.patch("/api/skills/:id", async (req, res) => {
  const sk = await updateSkill(req.user, req.params.id, req.body || {});
  if (!sk) return res.status(404).json({ error: "Not found" });
  res.json(sk);
});
app.delete("/api/skills/:id", (req, res) => {
  res.json({ ok: removeSkill(req.user, req.params.id) });
});

/* ---------------- user profile: the synthesized "what Heap Chat knows about you" ---------------- */
app.get("/api/profile", (req, res) => res.json({ profile: storesFor(req.user).profile || null }));
app.post("/api/profile/rebuild", async (req, res) => {
  try {
    const profile = await rebuildProfile(req.user, { force: true });   // user asked → build from whatever exists
    // distinguish "synthesized nothing" (no memories yet) from a real profile so the UI can explain
    const hasMemories = storesFor(req.user).memory.length > 0;
    res.json({ profile, empty: !profile, reason: !profile && !hasMemories ? "no-memories" : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// let the user correct the summary (transparency — they own their profile)
app.patch("/api/profile", (req, res) => {
  const st = storesFor(req.user);
  const summary = String((req.body || {}).summary || "").trim();
  st.profile = summary ? { ...(st.profile || { traits: {} }), summary, updatedAt: Date.now(), edited: true } : null;
  st.save("profile.json");
  res.json({ profile: st.profile });
});
app.delete("/api/profile", (req, res) => {
  const st = storesFor(req.user);
  st.profile = null; st.save("profile.json");
  res.json({ ok: true });
});

/* ---------------- scheduled agents (jobs) + activity feed (digests) ---------------- */
app.get("/api/jobs", (req, res) => res.json({ jobs: storesFor(req.user).jobs.map(jobPublic), cadences: Object.keys(CADENCES) }));
app.post("/api/jobs", (req, res) => {
  const b = req.body || {};
  if (!String(b.prompt || "").trim()) return res.status(400).json({ error: "prompt required" });
  const st = storesFor(req.user);
  const job = normalizeJob(b);
  st.jobs.unshift(job); st.save("jobs.json");
  res.json(jobPublic(job));
});
app.patch("/api/jobs/:id", (req, res) => {
  const st = storesFor(req.user);
  const i = st.jobs.findIndex(j => j.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: "Not found" });
  st.jobs[i] = normalizeJob(req.body || {}, st.jobs[i]);
  st.save("jobs.json");
  res.json(jobPublic(st.jobs[i]));
});
app.delete("/api/jobs/:id", (req, res) => {
  const st = storesFor(req.user);
  const before = st.jobs.length;
  st.jobs = st.jobs.filter(j => j.id !== req.params.id);
  if (st.jobs.length !== before) st.save("jobs.json");
  res.json({ ok: before !== st.jobs.length });
});
// run a job immediately (out of band) — useful to preview what a schedule produces
app.post("/api/jobs/:id/run", async (req, res) => {
  const st = storesFor(req.user);
  const job = st.jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: "Not found" });
  try {
    const out = await runJob(req.user, job);
    await deliver(req.user, job, out);
    job.lastRunAt = Date.now(); job.lastResult = { ok: true, summary: (out.text || "").slice(0, 200), at: job.lastRunAt };
    st.save("jobs.json");
    res.json({ ok: true, text: out.text, steps: out.steps });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// pending desktop notifications: scheduled-job digests that requested the "notify" channel and
// haven't been shown yet. Marked delivered on read so each fires exactly once (the renderer polls this).
app.get("/api/notifications", (req, res) => {
  const st = storesFor(req.user);
  const pending = st.digests.filter(d => d.notify && !d.notified);
  if (pending.length) { pending.forEach(d => { d.notified = true; }); st.save("digests.json"); }
  res.json({ notifications: pending.map(d => ({
    id: d.id, title: d.jobName || "Heap Chat",
    body: (d.text || "").replace(/[#*`>_]/g, "").replace(/\s+/g, " ").trim().slice(0, 160),
  })) });
});
app.get("/api/digests", (req, res) => res.json({ digests: storesFor(req.user).digests }));
app.delete("/api/digests/:id", (req, res) => {
  const st = storesFor(req.user);
  st.digests = st.digests.filter(d => d.id !== req.params.id);
  st.save("digests.json");
  res.json({ ok: true });
});
app.delete("/api/digests", (req, res) => {
  const st = storesFor(req.user);
  st.digests = []; st.save("digests.json");
  res.json({ ok: true });
});

/* ---------------- start fresh: wipe everything for the signed-in user ----------------
   Clears chats, memory, projects, people, connectors and the private KB +
   its vector indexes and path-keyed sidecars. The account itself stays (still signs in).
   Custom agents and the deep-work roster are DELIBERATELY preserved across a reset. */
app.delete("/api/account/data", async (req, res) => {
  try {
    const st = storesFor(req.user);
    const userDir = path.join(USERS_DIR, req.user.id);
    const counts = {
      chats: Object.values(st.chats).reduce((a, b) => a + Object.keys(b).length, 0),
      memory: st.memory.length,
      projects: st.projects.length,
      people: Object.keys(st.people).length,
      connectors: st.mcp.length,
    };
    // cancel any pending per-session idle passes (episode/skill/reflection distillation + auto-title)
    // so a queued timer can't fire against — or re-seed — the data we're about to wipe
    cancelUserTimers(req.user);
    // empty the in-memory stores and persist them empty — NOTE: agents.json / roster.json are
    // intentionally left out so custom agents and the deep-work roster survive a "start fresh".
    st.projects = []; st.people = {}; st.chats = {}; st.memory = []; st.mcp = []; st.mcpSessions = {};
    st.skills = []; st.profile = null; st.jobs = []; st.digests = []; st.settings = {};   // learning-loop stores reset too
    for (const f of ["projects.json", "people.json", "chats.json", "memory.json", "mcp.json", "mcp-sessions.json", "skills.json", "profile.json", "jobs.json", "digests.json", "settings.json"]) st.save(f);
    // remove the private KB and all project workspaces from disk, then recreate an empty KB dir
    await fsp.rm(st.kbDir, { recursive: true, force: true });
    await fsp.rm(path.join(userDir, "projects"), { recursive: true, force: true });
    fs.mkdirSync(st.kbDir, { recursive: true });
    // a path counts as "this user's" if it lives in their own dir, or in a shared folder they
    // can access that isn't inside ANY user's private dir (so other users' KBs are left untouched).
    // Paths are realpath-normalized first so the comparison matches canAccessPath's scope exactly —
    // otherwise sidecars keyed under a symlink/firmlink form (e.g. macOS /Users vs /System/Volumes/Data)
    // slip through deletion yet still get rebuilt into the knowledge graph (which uses canAccessPath).
    const userDirReal = realResolve(userDir), usersDirReal = realResolve(USERS_DIR);
    const ownsPath = p => {
      const rp = realResolve(p);
      return rp.startsWith(userDirReal + path.sep) ||
        (!rp.startsWith(usersDirReal + path.sep) && canAccessPath(req.user, p));
    };
    // drop path-keyed sidecars: vision descriptions, tags, perceptual hashes, OCR text, GPS cache,
    // graph entities, and cached face descriptors (so re-scanning People doesn't resurrect old clusters)
    for (const store of [imageMeta, tagStore, phashStore, pdfOcrStore, geoStore, entityStore, faceStore]) {
      for (const k of Object.keys(store)) if (ownsPath(k)) delete store[k];
    }
    persistImageMeta(); persistTags(); persistPhash(); persistPdfOcr(); persistGeo(); persistEntities(); persistFaces();
    graphCache.delete(req.user.id);   // force the knowledge graph to rebuild empty
    // delete the vector indexes for those folders (KB, project KBs, and shared folders they indexed; they rebuild on next use)
    try {
      for (const f of fs.readdirSync(INDEX_DIR)) {
        if (!f.endsWith(".json")) continue;
        try {
          const idx = JSON.parse(fs.readFileSync(path.join(INDEX_DIR, f), "utf8"));
          if (idx.folder && ownsPath(idx.folder)) fs.rmSync(path.join(INDEX_DIR, f), { force: true });
        } catch {}
      }
    } catch {}
    console.log(`[account] reset all data for user ${req.user.username || req.user.id}`);
    res.json({ ok: true, counts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------------- MCP connectors ---------------- */
app.get("/api/mcp", (req, res) => res.json({ servers: storesFor(req.user).mcp.map(mcpPublic) }));
app.post("/api/mcp", (req, res) => {
  const st = storesFor(req.user);
  const { name, url, authHeader, enabled = true } = req.body || {};
  if (!url) return res.status(400).json({ error: "url required" });
  const s = { id: "c" + Date.now() + Math.random().toString(16).slice(2, 6), name: (name || new URL(url).host).trim(), url: String(url).trim(), authHeader: authHeader ? String(authHeader).trim() : "", enabled: !!enabled };
  st.mcp.push(s); st.save("mcp.json"); res.json(mcpPublic(s));
});
app.put("/api/mcp/:id", (req, res) => {
  const st = storesFor(req.user);
  const s = st.mcp.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: "not found" });
  const b = req.body || {};
  if (b.url !== undefined && b.url !== s.url) { dropMcpClient(req.user, s.id); forgetSession(req.user, s.id); }            // url changed → invalidate session
  if (b.authHeader !== undefined && b.authHeader !== s.authHeader) { dropMcpClient(req.user, s.id); forgetSession(req.user, s.id); }
  if (b.enabled === false) dropMcpClient(req.user, s.id);                       // disabled → close client, but keep session to resume on re-enable
  if (b.name !== undefined) s.name = String(b.name).trim();
  if (b.url !== undefined) s.url = String(b.url).trim();
  if (b.authHeader !== undefined) s.authHeader = String(b.authHeader).trim();
  if (b.enabled !== undefined) s.enabled = !!b.enabled;
  st.save("mcp.json"); res.json(mcpPublic(s));
});
app.delete("/api/mcp/:id", (req, res) => {
  const st = storesFor(req.user);
  dropMcpClient(req.user, req.params.id); forgetSession(req.user, req.params.id);
  st.mcp = st.mcp.filter(x => x.id !== req.params.id);
  st.save("mcp.json"); res.json({ ok: true });
});
app.post("/api/mcp/:id/test", async (req, res) => {
  const s = storesFor(req.user).mcp.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: "not found" });
  try { const tools = await mcpListTools(req.user, s); res.json({ ok: true, tools }); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});

/* ---------------- admin / management ---------------- */
// mask a secret for display: enough to recognize it, never enough to reuse ("nvapi-ab••••wxyz")
function maskSecret(s) {
  if (!s || s.length < 10) return s ? "••••" : "";
  return s.slice(0, 6) + "••••" + s.slice(-4);
}
// network access: read + toggle the bind address live (no restart). Provider connections
// (Ollama + any OpenAI-compatible ones) live under /api/admin/providers below.
app.get("/api/admin/server", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const scfg = serverSettings.get();
  res.json({ lanAccess: !!scfg.lanAccess, urls: scfg.lanAccess ? lanUrls() : [], port: PORT });
});
app.put("/api/admin/server", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const b = req.body || {};
  const scfg = serverSettings.get();
  const want = b.lanAccess !== undefined ? !!b.lanAccess : !!scfg.lanAccess;
  const changed = want !== !!scfg.lanAccess;
  serverSettings.update({ lanAccess: want });
  res.json({ lanAccess: want, urls: want ? lanUrls() : [], rebinding: changed });
  if (!changed) return;
  setTimeout(() => {   // after the response flushes: release the listener, rebind on the new interface
    const old = httpServer;
    old.close(() => {});
    bindServer();
    setTimeout(() => { try { old.closeAllConnections(); } catch {} }, 2000);   // drop lingering keep-alive sockets on the old bind
  }, 300);
});

/* ---------------- provider connections: Ollama (built-in) + any number of OpenAI-compatible
   providers (NVIDIA, OpenAI, Groq, a local vLLM, ...) — admin-only, server-side. "Test" probes a
   URL/key live and returns its model list, used both to validate the connection and to populate
   the model dropdown before it's even saved. Keys are never echoed back raw (see maskSecret). */
app.get("/api/admin/providers", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const oll = serverSettings.getOllamaConfig();
  res.json({
    ollama: { baseUrl: oll.baseUrl, hasKey: !!oll.apiKey, keyPreview: maskSecret(oll.apiKey) },
    providers: serverSettings.listProviders().map(p => ({
      id: p.id, name: p.name, baseUrl: p.baseUrl, models: p.models || [], agentModel: p.agentModel || "",
      configured: !!p.apiKey, keyPreview: maskSecret(p.apiKey),
    })),
  });
});
// probe any base URL/key combo live, before it's saved — "type" picks the wire protocol used to
// list models: Ollama's native /api/tags, or the OpenAI-compatible GET /models.
app.post("/api/admin/providers/test", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { type, apiKey } = req.body || {};
  const baseUrl = String((req.body || {}).baseUrl || "").trim().replace(/\/+$/, "");
  if (!baseUrl) return res.json({ ok: false, error: "Base URL is required" });
  const authHeaders = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  try {
    if (type === "ollama") {
      const r = await fetch(`${baseUrl}/api/tags`, { headers: authHeaders, signal: AbortSignal.timeout(6000) });
      if (!r.ok) return res.json({ ok: false, error: `HTTP ${r.status}` });
      const j = await r.json();
      return res.json({ ok: true, models: (j.models || []).map(m => m.name).sort((a, b) => a.localeCompare(b)) });
    }
    const r = await fetch(`${baseUrl}/models`, { headers: authHeaders, signal: AbortSignal.timeout(8000) });
    if (!r.ok) { const d = await r.text().catch(() => ""); return res.json({ ok: false, error: `HTTP ${r.status}${d ? ": " + d.slice(0, 200) : ""}` }); }
    const j = await r.json();
    const models = (j.data || []).map(m => m.id).sort((a, b) => a.localeCompare(b));
    return res.json({ ok: true, models });
  } catch (e) {
    return res.json({ ok: false, error: e.message || "Connection failed" });
  }
});
// the built-in Ollama connection: URL + optional API key (for a secured/proxied Ollama-compatible
// endpoint — real local Ollama doesn't need one). Always exists, can't be removed, only edited.
app.put("/api/admin/providers/ollama", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const b = req.body || {};
  const patch = {};
  if (b.baseUrl !== undefined) patch.baseUrl = String(b.baseUrl).trim().replace(/\/+$/, "");
  if (b.apiKey !== undefined) patch.apiKey = String(b.apiKey).trim();
  const oll = serverSettings.updateOllama(patch);
  res.json({ baseUrl: oll.baseUrl, hasKey: !!oll.apiKey, keyPreview: maskSecret(oll.apiKey) });
});
app.post("/api/admin/providers", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const b = req.body || {};
  const name = String(b.name || "").trim();
  const baseUrl = String(b.baseUrl || "").trim().replace(/\/+$/, "");
  if (!name || !baseUrl) return res.status(400).json({ error: "Name and base URL are required" });
  const p = serverSettings.createProvider({
    name, baseUrl, apiKey: String(b.apiKey || "").trim(),
    models: Array.isArray(b.models) ? b.models.map(String) : [], agentModel: String(b.agentModel || "").trim(),
  });
  res.json({ id: p.id, name: p.name, baseUrl: p.baseUrl, models: p.models, agentModel: p.agentModel, configured: !!p.apiKey, keyPreview: maskSecret(p.apiKey) });
});
app.put("/api/admin/providers/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const existing = serverSettings.getProvider(req.params.id);
  if (!existing) return res.status(404).json({ error: "Not found" });
  const b = req.body || {};
  const patch = {};
  if (b.name !== undefined) patch.name = String(b.name).trim();
  if (b.baseUrl !== undefined) patch.baseUrl = String(b.baseUrl).trim().replace(/\/+$/, "");
  if (b.apiKey !== undefined && String(b.apiKey).trim()) patch.apiKey = String(b.apiKey).trim();   // blank = keep existing key
  if (b.clearApiKey) patch.apiKey = "";
  if (b.models !== undefined) patch.models = Array.isArray(b.models) ? b.models.map(String) : [];
  if (b.agentModel !== undefined) patch.agentModel = String(b.agentModel).trim();
  const p = serverSettings.updateProvider(req.params.id, patch);
  res.json({ id: p.id, name: p.name, baseUrl: p.baseUrl, models: p.models, agentModel: p.agentModel, configured: !!p.apiKey, keyPreview: maskSecret(p.apiKey) });
});
app.delete("/api/admin/providers/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (req.params.id === "ollama") return res.status(400).json({ error: "The built-in Ollama connection can't be removed" });
  serverSettings.deleteProvider(req.params.id);
  res.json({ ok: true });
});
// list every on-disk index with stats
app.get("/api/admin/indexes", (req, res) => {
  const myKb = kbDirFor(req.user);
  let out = [];
  try {
    for (const f of fs.readdirSync(INDEX_DIR)) {
      if (!f.endsWith(".json")) continue;
      try {
        const idx = JSON.parse(fs.readFileSync(path.join(INDEX_DIR, f), "utf8"));
        // hide other users' private KB indexes; show shared disk folders + your own KB
        if (isKbDir(idx.folder) && idx.folder !== myKb) continue;
        const files = Object.keys(idx.files || {}).length;
        const chunks = Object.values(idx.files || {}).reduce((n, x) => n + x.chunks.length, 0);
        out.push({ folder: idx.folder, files, chunks, updatedAt: idx.updatedAt || 0, isKB: idx.folder === myKb });
      } catch {}
    }
  } catch {}
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  res.json({ indexes: out, kb: myKb });
});
// delete (clear) a folder's index
app.delete("/api/admin/index", (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const folderPath = path.resolve(String(req.query.path || ""));
    fs.rmSync(indexPath(folderPath), { force: true });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// list all images that have a stored vision description
app.get("/api/admin/images", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const images = Object.entries(imageMeta)
    .filter(([p]) => fs.existsSync(p))
    .map(([p, m]) => ({ path: p, name: path.basename(p), context: m.context || "", description: m.description || "" }));
  res.json({ images });
});
// remove an image's description (it will no longer be searchable until re-analyzed)
app.delete("/api/admin/image", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const p = path.resolve(String(req.query.path || ""));
    delete imageMeta[p]; persistImageMeta();
    const kb = kbDirFor(req.user);
    try { await buildIndex(kb); } catch {}
    if (!p.startsWith(kb + path.sep)) { try { await buildIndex(path.dirname(p)); } catch {} }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* AGENT core — tool registry, tool-calling loop, deep-research & multi-agent
   pipelines, chat-image helpers → src/agent/core.js */

/* chat attachments: upload a file from the client device into the user's KB (Uploads/),
   where it gets indexed like everything else. Body: { name, data: dataURL|base64 }. */
app.post("/api/upload", async (req, res) => {
  try {
    const { name, data } = req.body || {};
    if (!name || !data) return res.status(400).json({ error: "name and data required" });
    const dir = path.join(kbDirFor(req.user), "Uploads");
    fs.mkdirSync(dir, { recursive: true });
    let base = safeName(name);
    const ext = path.extname(base), stem = base.slice(0, base.length - ext.length);
    let dest = path.join(dir, base);
    for (let i = 2; fs.existsSync(dest); i++) dest = path.join(dir, `${stem} (${i})${ext}`);   // never clobber
    const b64 = String(data).replace(/^data:[^,]*,/, "");
    await fsp.writeFile(dest, Buffer.from(b64, "base64"));
    res.json({ ok: true, name: path.basename(dest), path: dest });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* execute a destructive file action the user approved via the in-chat card.
   Body: { scope, path, paths, action: { action, name, new_name?, text? } } — same scope info the
   agent request carried, so the tool resolves the file inside the identical working context. */
app.post("/api/agent/approve", async (req, res) => {
  const b = req.body || {};
  const args = b.action || {};
  if (!["delete", "overwrite", "rename"].includes(String(args.action || ""))) return res.status(400).json({ error: "not an approvable action" });
  let ctx;
  const scope = b.scope || "kb";
  if (scope === "file" || scope === "folder") {
    if (!b.path) return res.status(400).json({ error: "path required" });
    const p = path.resolve(String(b.path));
    if (!guardPath(req, res, p)) return;
    ctx = { isFile: scope === "file", path: p, key: p };
  } else if (scope === "selection") {
    const sel = accessibleOnly(req, (Array.isArray(b.paths) ? b.paths : []).map(p => path.resolve(String(p))))
      .filter(p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
    if (!sel.length) return res.status(400).json({ error: "paths required" });
    sel.sort();
    const key = path.join(DATA_DIR, "selections", crypto.createHash("sha1").update(sel.join("\n")).digest("hex").slice(0, 16));
    ctx = { isFile: false, files: sel, path: path.dirname(sel[0]), key };
  } else {
    const kb = kbDirFor(req.user);
    ctx = { isFile: false, path: kb, key: kb };
  }
  ctx.user = req.user; ctx.kbDir = kbDirFor(req.user); ctx.model = OLLAMA_AGENT_MODEL; ctx.approved = true;
  try {
    const out = await TOOL_REGISTRY.manage_file.run(args, ctx);
    res.json({ ok: !/not found|missing|exists|can't|unknown/i.test(out.summary || ""), result: out.result, summary: out.summary });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// pull http(s) links out of the user's message so the agent can scrape them directly (no web search).
function extractUrls(text) {
  const out = []; const re = /\bhttps?:\/\/[^\s<>()\[\]{}"'`]+/gi; let m;
  while ((m = re.exec(String(text || ""))) && out.length < 5) {
    const u = m[0].replace(/[.,;:!?)\]}'"]+$/, "");   // trim trailing punctuation
    if (!out.includes(u)) out.push(u);
  }
  return out;
}

/* ---------------- rolling chat summarization ----------------
   When a session's history outgrows the context budget, fold the OLDEST turns into compact
   notes (cached per session, extended incrementally as the chat grows) and keep the recent
   exchange verbatim — the model keeps the whole chat's substance without carrying every token. */
const CHAT_SUMMARIES = new Map();   // sessionId → { upto, summary }
const SUMMARIZE_SYS = "You compress the earlier part of a conversation into notes the assistant will rely on to continue it seamlessly. Keep: the user's goals and standing instructions, decisions made, key facts/numbers/names discovered (with their source files or URLs), and unresolved threads. Drop pleasantries and dead ends. Output compact bullet points, at most ~350 words.";
const SUMMARY_PREFIX = "Summary of the earlier part of this conversation (it replaces messages omitted to save space):\n";
// "summarize/recap/take notes on THIS chat" — the request is about the conversation itself, so keep it
// verbatim instead of folding the old turns into lossy notes (num_ctx sizing then grows to fit it).
const RECAP_INTENT = /\b(summari[sz]e|summary|recap|tl;?dr|(?:take|taking|make|making|jot|write)\s+(?:down\s+|a\s+|some\s+)*notes?|minutes?|action items?|key points?|takeaways?|what (?:did|have) we (?:discuss|cover|talk|decide|say)|so far|this (?:chat|conversation|thread|discussion))\b/i;
function wantsConversationRecap(text) { return RECAP_INTENT.test(String(text || "")); }
// budget for compactHistory: much larger when the user is asking about the conversation itself
function histBudget(contextWindow, recap) { return (contextWindow || 8192) * (recap ? 8 : 2); }
async function compactHistory(model, sessionKey, history, budgetChars) {
  const size = m => String(m.content || "").length + 40;
  const total = history.reduce((n, m) => n + size(m), 0);
  if (total <= budgetChars) return { history, compacted: 0, foldedNew: false };   // fits → keep verbatim

  const cached = sessionKey ? CHAT_SUMMARIES.get(sessionKey) : null;
  // Sticky compaction: if we already folded up to `cached.upto`, reuse that summary and keep the
  // tail since then verbatim — only fold MORE (and re-announce it) once the kept tail ITSELF
  // outgrows the budget. This mirrors a one-shot compaction: we don't re-summarize, or flash the
  // "folded N earlier messages" step, on every subsequent turn.
  if (cached && cached.upto >= 2 && cached.upto <= history.length) {
    const tail = history.slice(cached.upto);
    const tailSize = tail.reduce((n, m) => n + size(m), 0) + cached.summary.length + SUMMARY_PREFIX.length + 40;
    if (tailSize <= budgetChars) {
      return {
        history: [{ role: "system", content: SUMMARY_PREFIX + cached.summary }, ...tail],
        compacted: cached.upto,
        foldedNew: false,
      };
    }
  }

  let i = history.length, kept = 0;   // keep the most recent turns verbatim (~half the budget)
  while (i > 0) {
    const s = size(history[i - 1]);
    if (kept + s > budgetChars / 2 && history.length - i >= 4) break;
    i--; kept += s;
  }
  if (i < 2) return { history, compacted: 0, foldedNew: false };   // nothing meaningful to fold
  let summary;
  if (cached && cached.upto === i) summary = cached.summary;
  else {
    const base = cached && cached.upto < i ? cached : { upto: 0, summary: "" };
    const fresh = history.slice(base.upto, i).map(m => m.role.toUpperCase() + ": " + String(m.content || "").slice(0, 1500)).join("\n\n");
    const input = (base.summary ? `NOTES ON THE CONVERSATION SO FAR:\n${base.summary}\n\nNEWER MESSAGES TO FOLD INTO THE NOTES:\n` : "") + fresh;
    summary = await routedCompleteText(model, SUMMARIZE_SYS, input.slice(-24000), 900, 0.2);
    if (!summary.trim()) return { history, compacted: 0, foldedNew: false };   // summarizer failed → num_ctx sizing/trim still protect
    if (sessionKey) {
      CHAT_SUMMARIES.set(sessionKey, { upto: i, summary });
      if (CHAT_SUMMARIES.size > 500) CHAT_SUMMARIES.delete(CHAT_SUMMARIES.keys().next().value);
    }
  }
  console.log(`[chat] folded ${i} earlier message(s) into summary notes (${summary.length} chars)`);
  return {
    history: [{ role: "system", content: SUMMARY_PREFIX + summary }, ...history.slice(i)],
    compacted: i,
    foldedNew: true,
  };
}

// chat-image attachment helpers (chatImageRefs/resolveImageRef/materializeChatImage) → src/agent/core.js

app.post("/api/agent", async (req, res) => {
  const { scope = "kb", path: targetPath, messages = [], model, temperature: reqTemp = 0.7, maxTokens: reqMaxTokens = 2048, topP: reqTopP = 0.9, autoMemory = true, contextWindow, richRender = true, thinking = false, webSearch = false, research = false, deepResearch = false, deepWork = false, factCheck = true, placeLookup = false,
    useFiles = true, useMemory = true, imageGen = false, projectId, agentId } = req.body || {};
  // a custom agent overrides the persona, sampling, model, and which tool capabilities are available;
  // the per-chat "Use my documents" / "Use memory" toggles can also switch files/memory off for one chat.
  const agent = agentId ? findAgent(req.user, agentId) : null;
  const caps = (agent && agent.tools) || null;
  const filesEnabled = (!caps || caps.files !== false) && useFiles !== false;
  const memoryEnabled = (!caps || caps.memory !== false) && useMemory !== false;
  const connectorsEnabled = !caps || caps.connectors !== false;
  const webEnabled = !!webSearch || !!(caps && caps.web === true);   // the per-chat Web toggle always works; a custom agent can also default it on
  const imageGenEnabled = !!imageGen;   // image generation is enabled per-chat from saved Settings (mirrors webSearch/placeLookup)
  const chosen = (agent && agent.model) || model || OLLAMA_AGENT_MODEL;
  const temperature = agent && typeof agent.temperature === "number" ? agent.temperature : reqTemp;
  const maxTokens = agent && typeof agent.maxTokens === "number" ? agent.maxTokens : reqMaxTokens;
  const topP = agent && typeof agent.topP === "number" ? agent.topP : reqTopP;
  const MAX_STEPS = research ? 18 : 8;               // (loop) research needs room to search + read several sources
  const write = (o) => res.write(JSON.stringify(o) + "\n");
  const _reqStart = Date.now();   // TIMING: measure pre-flight (memory recall + history compaction) before the model runs

  // resolve the agent's working context + a human label for the prompt
  let ctx, domainLabel;
  if (scope === "file") {
    if (!targetPath) return res.status(400).json({ error: "path required for file scope" });
    const fp = path.resolve(targetPath);
    if (!guardPath(req, res, fp)) return;
    ctx = { isFile: true, path: fp, key: fp };
    domainLabel = `the file "${path.basename(fp)}"`;
  } else if (scope === "folder") {
    if (!targetPath) return res.status(400).json({ error: "path required for folder scope" });
    const dir = path.resolve(targetPath);
    if (!guardPath(req, res, dir)) return;
    ctx = { isFile: false, path: dir, key: dir };
    domainLabel = `the folder "${path.basename(dir)}"`;
  } else if (scope === "selection") {
    const sel = accessibleOnly(req, (Array.isArray(req.body.paths) ? req.body.paths : []).map(p => path.resolve(String(p))))
      .filter(p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
    if (!sel.length) return res.status(400).json({ error: "paths required for selection scope" });
    sel.sort();
    const key = path.join(DATA_DIR, "selections", crypto.createHash("sha1").update(sel.join("\n")).digest("hex").slice(0, 16));
    ctx = { isFile: false, files: sel, path: path.dirname(sel[0]), key };
    domainLabel = `the ${sel.length} files the user selected`;
  } else {
    const project = projectId ? findProject(req.user, projectId) : null;
    const kb = project ? projectKbDirFor(req.user, project.id) : kbDirFor(req.user);
    ctx = { isFile: false, path: kb, key: kb };
    domainLabel = project ? `the "${project.name}" project` : "the user's knowledge base";
  }
  ctx.user = req.user;
  ctx.kbDir = projectId && findProject(req.user, projectId) ? projectKbDirFor(req.user, projectId) : kbDirFor(req.user);
  ctx.model = chosen;
  ctx.sessionId = String(req.body.sessionId || "") || null;
  const lastUserMsg = (([...messages].reverse().find(m => m.role === "user")) || {}).content || "";
  ctx.chartHint = wantsVisual(lastUserMsg);
  // visual intent → image search. Covers explicit "photo/picture/pic" AND "show me / see / what does X
  // look like / how does X look" so appearance questions about public figures return pictures, not just text.
  ctx.wantsImages = /\b(image|images|picture|pictures|photo|photos|pics?|headshot|poster|wallpaper)\b/i.test(lastUserMsg)
    || /\b(show|see|view)\s+(me\s+|us\s+)?(a\s+|some\s+|her|him|them|his|their)\b/i.test(lastUserMsg)
    || /\bwhat\s+(does|do|did)\b[^?]*\blooks?\s+like\b/i.test(lastUserMsg)
    || /\bhow\s+(does|do|is|are|did)\b[^?]*\blooks?\b/i.test(lastUserMsg);   // "how is her appearance look", "how does she look"
  const pastedUrls = extractUrls(lastUserMsg).slice(0, 3);   // links the user pasted → scrape them directly
  ctx.describePhotos = Math.max(1, Math.min(Number(req.body.describePhotos) || 5, 10));   // photos to vision-analyze for appearance
  ctx.placeLookup = !!placeLookup;   // when on, knowledge_graph may reverse-geocode place names on demand (online)
  // local Draw Things HTTP endpoint for generate_image/edit_image — only an admin's url override is honored (SSRF guard, see drawThingsFrom)
  ctx.drawThings = { url: (req.user.role === "admin" && req.body.drawThingsUrl) || "http://localhost:7860", model: req.body.drawThingsModel, secret: req.body.drawThingsSecret };
  // image generation defaults from the user's Settings — the agent tools use these (the model can't override steps/guidance/strength)
  ctx.imageDefaults = {
    steps: Number(req.body.imageSteps) || 4,
    guidance: req.body.imageGuidance != null ? Number(req.body.imageGuidance) : 1.5,
    strength: req.body.imageStrength != null ? Number(req.body.imageStrength) : 0.99,
    width: Number(req.body.imageWidth) || 512,
    height: Number(req.body.imageHeight) || 512,
    maxDim: req.body.imageMaxDim != null ? Number(req.body.imageMaxDim) : 1024,
  };
  ctx.convoImages = chatImageRefs(req.body.convoImages);   // images in this chat, materialized on demand by save_note
  // models won't reliably fill save_note's `images` param, so when the request is about the
  // conversation or its images, default to embedding all of them unless the model picks specific ones
  ctx.embedConvoImages = ctx.convoImages.length > 0 && (wantsConversationRecap(lastUserMsg) || ctx.wantsImages);
  console.log(`[agent] scope=${scope} hint=${ctx.chartHint || "none"} q="${String(lastUserMsg).slice(0, 90)}"`);

  try {
    // for single-file scope, pre-load the contents so the agent can answer directly
    let preload = "";
    if (ctx.files) preload = `\n\nThe user selected exactly these ${ctx.files.length} files (work only with them):\n` + ctx.files.map(p => `- ${path.basename(p)}`).join("\n");
    if (ctx.isFile) {
      const { text, status } = await extractText(ctx.path);
      if (status === "ok" && text.trim()) {
        const snip = text.length > 12000 ? text.slice(0, 12000) + "\n…[truncated — use search_docs/read_file for the rest]" : text;
        preload = `\n\n--- CONTENTS OF ${path.basename(ctx.path)} ---\n${snip}\n--- END CONTENTS ---\n`;
      }
    }
    // files attached in the chat composer: inject their content directly so the agent doesn't have to find them
    const attached = [];
    // Text from attached files rides with the latest user turn (below), not the system prompt, so the
    // model treats it as the subject of the question instead of searching the KB for an un-indexed upload.
    let attachBlock = "";
    {
      const aps = accessibleOnly(req, (Array.isArray(req.body.attachments) ? req.body.attachments : []).map(p => path.resolve(String(p))))
        .filter(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }).slice(0, 8);
      for (const ap of aps) {
        const nm = path.basename(ap);
        attached.push({ path: ap, name: nm });
        if (isImageFile(nm)) { preload += `\n\nThe user attached the image "${nm}" — call image_tool to look at it when relevant.`; continue; }
        try {
          const { text, status } = await extractText(ap);
          if (status === "ok" && text.trim()) {
            const snip = text.length > 32000 ? text.slice(0, 32000) + "\n…[truncated — call read_file on this filename for the rest]" : text;
            attachBlock += `\n\n--- ATTACHED FILE: ${nm} ---\n${snip}\n--- END ATTACHED FILE: ${nm} ---`;
          } else attachBlock += `\n\n(The user attached "${nm}" but its content could not be extracted as text.)`;
        } catch { attachBlock += `\n\n(The user attached "${nm}" but its content could not be read.)`; }
      }
    }
    const recalled = [];
    const memBlock = memoryEnabled ? await memoryBlock(req.user, lastUserMsg, recalled) : "";
    // learned skills relevant to this question (titles + triggers only; full steps via recall_skill)
    const skillBlock = memoryEnabled ? await skillsBlock(req.user, lastUserMsg) : "";
    // long chat → fold the oldest turns into summary notes so the convo fits the context budget;
    // but if the user is asking to summarize/recap/take notes on THIS chat, keep it verbatim
    const { history: hist, compacted, foldedNew } = await compactHistory(chosen, ctx.sessionId,
      messages.map(m => ({ role: m.role, content: m.content })), histBudget(contextWindow, wantsConversationRecap(lastUserMsg)));
    const activeProject = projectId ? findProject(req.user, projectId) : null;
    const projInstructions = activeProject && activeProject.instructions ? `PROJECT INSTRUCTIONS:\n${activeProject.instructions}\n\n` : "";
    // a custom agent's prompt fully replaces the default persona; tool mechanics are still appended so tools work
    // Memory is NOT baked into the system prompt: it varies per question and would break the cached
    // prefill of the (otherwise stable) persona+tools prefix. It rides with the latest user turn below.
    let baseSys = (agent && agent.systemPrompt.trim())
      ? agent.systemPrompt.trim() + "\n\n" + agentToolMechanics({ autoMem: memoryEnabled && autoMemory, web: webEnabled, memory: memoryEnabled, connectors: connectorsEnabled, imageGen: imageGenEnabled, user: req.user })
      : agentSys(domainLabel, autoMemory, webEnabled, research, req.user, "", imageGenEnabled);
    // per-chat "Use my documents" off → the file tools are gone; tell the model so it doesn't try to search them
    if (!filesEnabled) baseSys += "\n\nIMPORTANT: Access to the user's files/documents is OFF for this chat — the file-search tools are unavailable. Do NOT try to search or read their files. Answer from your general knowledge" + (webEnabled ? " and the web (web_search/read_url)" : "") + "; if the question is specifically about their personal files, tell them file access is turned off for this chat.";
    // the synthesized user profile rides at the very top — small, slow-changing → cache-friendly prefix
    const profBlock = memoryEnabled ? profileBlock(req.user) : "";
    const convo = [{ role: "system", content: profBlock + projInstructions + baseSys + sysInfoBlock() + preload }, ...hist];
    // Per-question memory + conversation-image hint vary every turn, so attach them to the latest user
    // message (end of the prompt) rather than the system block — keeps the system prefix cacheable.
    const imagesHint = (filesEnabled && ctx.convoImages.length)
      ? `\n\nIMAGES IN THIS CONVERSATION: ${ctx.convoImages.map(i => i.name).join(", ")}. When you save a note that is about this conversation or these images, embed the relevant ones by listing their filenames in save_note's \`images\` parameter (or pass ["all"]).`
      : "";
    const attachIntro = attachBlock
      ? `\n\nThe user attached the following file(s) directly to THIS message. Their full content is included below — read it and answer the user's question from it directly; do NOT search the knowledge base for these files, you already have them:${attachBlock}`
      : "";
    const trailingCtx = attachIntro + memBlock + skillBlock + imagesHint;
    if (trailingCtx) {
      for (let i = convo.length - 1; i >= 0; i--) {
        if (convo[i].role === "user") { convo[i] = { ...convo[i], content: convo[i].content + trailingCtx }; break; }
      }
    }
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    if (foldedNew) {   // transparency: announce ONLY when this turn actually folded new messages (not every turn after)
      write({ step: { name: "compact_history", args: {} } });
      write({ step_result: { name: "compact_history", summary: `folded ${compacted} earlier message${compacted === 1 ? "" : "s"} into notes`, detail: "" } });
    }
    if (recalled.length) {   // transparency: show which long-term memories were injected for this question
      const label = t => t === "episode" ? "past task" : t;
      const counts = {};
      recalled.forEach(m => { const t = label(m.type); counts[t] = (counts[t] || 0) + 1; });
      write({ step: { name: "recall_memory", args: {} } });
      write({ step_result: { name: "recall_memory",
        summary: Object.entries(counts).map(([t, n]) => `${n} ${t}${n === 1 ? "" : "s"}`).join(" · "),
        detail: recalled.map(m => `[${label(m.type)}] ${m.text}`).join("\n") } });
    }
    if (deepResearch) {   // server-orchestrated deep research pipeline (plan → research → synthesize)
      await deepResearchPipeline({ q: lastUserMsg, history: hist, urls: pastedUrls, chosen, ctx, write, temperature, contextWindow, web: webEnabled, files: filesEnabled });
      res.end();
      return;
    }
    if (deepWork) {   // multi-agent: a roster of specialists take turns, orchestrated dynamically
      await multiAgentPipeline({ q: lastUserMsg, history: hist, chosen, ctx, write, temperature, contextWindow,
        web: webEnabled, richRender, factCheck,
        toolOpts: { user: req.user, files: filesEnabled, memory: memoryEnabled, connectors: connectorsEnabled, imageGen: imageGenEnabled } });
      res.end();
      return;
    }
    const allSources = new Map();
    let ctxPeak = 0;   // largest real prompt-token count seen this turn → the composer's context-fill meter
    console.log(`[TIMING] pre-flight ${Date.now() - _reqStart}ms (memory recall + history compaction, before the model is called)`);

    async function callModel(withTools, noThink = false) {
      const npredict = research ? Math.max(maxTokens, 4096) : maxTokens;
      // Size num_ctx to what this call actually needs: the whole convo (system prompt, history,
      // tool results — read_url alone adds up to 8k chars per call) PLUS the generation budget.
      // Ollama silently truncates the FRONT of the prompt when it doesn't fit and stops generating
      // once the window fills — both look like the agent "stopping mid-answer". ~3 chars/token is
      // conservative (covers non-English text); bucketed so the model isn't reloaded every call.
      const promptChars = convo.reduce((n, m) => n + String(m.content || "").length + 50, withTools ? 6000 : 500);
      const need = Math.ceil(promptChars / 3) + npredict + 256;
      const numCtx = Math.max(contextWindow || 0, [4096, 8192, 16384, 32768, 65536, 131072].find(b => b >= need) || 131072);
      if (contextWindow && numCtx > contextWindow) console.log(`[agent] convo needs ~${need} tokens — raising num_ctx ${contextWindow} → ${numCtx} for this call`);
      let msgs = convo;
      if (need > numCtx) {   // even the max window can't fit everything — drop the OLDEST turns ourselves
        const keep = convo.slice(1); let chars = promptChars;   // (Ollama would silently drop the system prompt instead)
        while (keep.length > 6 && Math.ceil(chars / 3) + npredict + 256 > numCtx) chars -= String(keep.shift().content || "").length + 50;
        msgs = [convo[0], ...keep];
        console.log(`[agent] trimmed ${convo.length - msgs.length} oldest message(s) to fit the ${numCtx}-token window`);
      }
      // --- timing: Ollama withholds the HTTP response until load+prefill finish, so start the clock BEFORE the fetch ---
      const _t0 = Date.now(); let _tFirst = 0, _doneMeta = null;
      const markFirst = () => { if (!_tFirst) _tFirst = Date.now() - _t0; };
      let content = "", toolCalls = [], thinkAccum = "", doneReason = "";
      // Inline <think> tag parser: some models (e.g. Qwen3-MLX) embed tags in the content stream
      // instead of using a native reasoning field — shared by both providers below.
      const split = makeThinkSplitter(
        t => { markFirst(); thinkAccum += t; write({ message: { thinking: t } }); },
        c => { markFirst(); content += c; write({ message: { content: c } }); });
      const toolDefs = withTools ? agentToolDefs({ web: webEnabled, urls: pastedUrls.length > 0, user: req.user, files: filesEnabled, memory: memoryEnabled, connectors: connectorsEnabled, imageGen: imageGenEnabled }) : undefined;

      const _pid = modelProviderOf(chosen);
      if (_pid !== "ollama") {
        // an OpenAI-compatible provider is server-managed context (no num_ctx to size) —
        // reuses the same msgs/trimming above, just a different transport + response shape.
        const r = await providerLLM.streamChatTurn(_pid, {
          model: routedBareModel(chosen), messages: msgs, tools: toolDefs,
          temperature, maxTokens: npredict, topP,
          onContent: c => split.push(c),
          onThinking: t => { markFirst(); thinkAccum += t; write({ message: { thinking: t } }); },
        });
        split.flush();
        toolCalls = r.toolCalls; doneReason = r.doneReason;
        console.log(`[TIMING] ${withTools ? "tools " : "answer"} (${_pid}) stall-before-first-token=${_tFirst}ms`);
        return { content, toolCalls, thinking: thinkAccum, doneReason };
      }

      const up = await fetch(`${ollamaConn.baseUrl()}/api/chat`, {
        method: "POST", headers: ollamaConn.headers(),
        body: JSON.stringify({ keep_alive: OLLAMA_KEEP_ALIVE,
          model: chosen, messages: msgs, stream: true, think: noThink ? false : !!thinking,
          ...(toolDefs ? { tools: toolDefs } : {}),
          options: { temperature, num_predict: npredict, top_p: topP, num_ctx: numCtx },
        }),
      });
      if (!up.ok || !up.body) { const d = await up.text().catch(() => ""); throw new Error(`Ollama ${up.status}: ${d}`); }
      const reader = up.body.getReader(); const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!line) continue;
          let o; try { o = JSON.parse(line); } catch { continue; }
          markFirst();   // first chunk from Ollama of ANY kind = end of load+prefill stall
          const m = o.message || {};
          if (o.done) { doneReason = o.done_reason || doneReason; _doneMeta = o; }
          if (m.thinking) { markFirst(); thinkAccum += m.thinking; write({ message: { thinking: m.thinking } }); }
          if (m.content) split.push(m.content);
          if (m.tool_calls) toolCalls.push(...m.tool_calls);
        }
      }
      split.flush();
      const ms = d => Math.round((d || 0) / 1e6);   // Ollama durations are nanoseconds
      const load = _doneMeta ? ms(_doneMeta.load_duration) : 0;
      const prefill = _doneMeta ? ms(_doneMeta.prompt_eval_duration) : 0;
      console.log(`[TIMING] ${withTools ? "tools " : "answer"} stall-before-first-token=${_tFirst}ms  [load=${load}ms${load > 800 ? " ⚠️RELOAD" : ""} + prefill=${prefill}ms/${_doneMeta ? _doneMeta.prompt_eval_count || 0 : 0}tok]  gen=${_doneMeta ? ms(_doneMeta.eval_duration) : 0}ms/${_doneMeta ? _doneMeta.eval_count || 0 : 0}tok  num_ctx=${numCtx}`);
      // report REAL context usage to the composer meter: prompt_eval_count is the actual tokens read.
      // track the peak (later cached calls report fewer) and only emit when it grows, so the gauge never flickers.
      const promptTok = (_doneMeta && _doneMeta.prompt_eval_count) || 0;
      if (promptTok > ctxPeak) { ctxPeak = promptTok; write({ context: { used: promptTok, max: numCtx } }); }
      return { content, toolCalls, thinking: thinkAccum, doneReason };
    }
    // the answer hit the num_predict limit mid-sentence → let it continue with a fresh budget
    async function continueAnswer(r) {
      for (let i = 0; i < 2 && r.doneReason === "length" && r.content.trim(); i++) {
        console.log("[agent] answer truncated by token limit — asking the model to continue");
        convo.push({ role: "assistant", content: r.content });
        convo.push({ role: "user", content: "Your answer was cut off mid-sentence by the length limit. Continue EXACTLY where you left off — do not repeat anything, do not start over, no preamble." });
        r = await callModel(false, true);
        allText += r.content;
      }
    }
    // the model reasoned but stopped without writing an answer → ask it to answer, with thinking off
    function pushAnswerNudge(turnThink) {
      convo.push({ role: "assistant", content: "(internal reasoning — no answer was written)\n" + turnThink.slice(-3000) });
      convo.push({ role: "user", content: "You stopped after your reasoning without answering. Based on that reasoning, write your final answer for the user now — the answer only, no reasoning steps, no preamble about your thought process." });
    }

    let answered = false, allText = "", nudges = 0, searched = false, rethought = false;
    const opened = new Set();   // files the agent explicitly opened (always cite/show these)
    const forceSources = new Set();   // sources the agent explicitly fetched (web results) — always count as used
    attached.forEach(a => { allSources.set(a.path, { name: a.name, score: 1 }); forceSources.add(a.path); });   // attachments always cite
    const evidence = [];        // retrieved data the answer could be grounded in (for verify + provenance)
    // model said it would call a tool but didn't actually emit one
    const danglingCall = c => /(\bnow\s*[.…]{1,3}|[.…]{3})\s*$/i.test(c.trim()) || /\b(i['’]?ll|i will|let me|now)\b[^.]{0,50}\b(run|call|use|fetch|get|check|search|read)\b/i.test(c);
    // paste-a-link: if the user included URL(s), scrape them up front and hand the page text to the agent —
    // works with the Web toggle OFF and doesn't depend on the model deciding to call read_url.
    for (const url of pastedUrls) {
      try {
        write({ step: { name: "read_url", args: { url } } });
        const { result, sources, summary, render } = await execTool("read_url", JSON.stringify({ url }), ctx);
        const hit = sources && sources[0];
        write({ step_result: { name: "read_url", summary: summary || "read", detail: typeof result === "string" ? result.slice(0, 4000) : "" } });
        if (richRender && Array.isArray(render)) render.forEach(spec => write({ render: spec }));   // show the page's images inline
        if (hit && hit.path) {   // fetched OK → cite it and inject the page text
          allSources.set(hit.path, { name: hit.name, score: 1 }); forceSources.add(hit.path); searched = true;
          if (typeof result === "string" && result.trim()) evidence.push({ source: hit.name || url, text: result.slice(0, 4000) });
          convo.push({ role: "system", content: `The user pasted this link and it has ALREADY been fetched for you — answer from the page content below and cite it as [${hit.name || url}]. Do NOT web-search for this; you have the page.\n\n${typeof result === "string" ? result.slice(0, 12000) : ""}` });
        } else {   // blocked / non-text / error → let the model tell the user plainly
          convo.push({ role: "system", content: `Tried to fetch the link the user pasted (${url}) but it couldn't be read: ${typeof result === "string" ? result.slice(0, 300) : "fetch failed"}. Tell the user it couldn't be opened and why; do not invent its contents.` });
        }
      } catch (e) { /* best-effort; the read_url tool is still available to the model */ }
    }
    for (let step = 0; step < MAX_STEPS; step++) {
      const { content, toolCalls, thinking: turnThink, doneReason } = await callModel(true, rethought);
      allText += "\n" + content;
      if (!toolCalls.length) {
        if (nudges < 1 && content.trim() && danglingCall(content)) {   // recover: it announced a tool but didn't call it
          nudges++;
          convo.push({ role: "assistant", content });
          convo.push({ role: "user", content: "Go ahead — actually call the tool now and give the result." });
          continue;
        }
        // model spent the whole turn reasoning and never wrote the answer (common stall in think mode):
        // nudge it once to answer with thinking disabled, instead of showing the raw reasoning as the answer
        if (!content.trim() && (turnThink || "").trim()) {
          if (!rethought) { rethought = true; pushAnswerNudge(turnThink); continue; }
          write({ message: { content: turnThink } });   // nudge failed too — reasoning is better than silence
          allText += "\n" + turnThink;
        } else {
          await continueAnswer({ content, doneReason });   // finish an answer the token limit cut off
        }
        answered = true; break;   // final answer already streamed
      }
      convo.push({ role: "assistant", content, tool_calls: toolCalls });
      // launch every tool in this step concurrently; consume results in order so the convo stays deterministic
      const jobs = toolCalls.map(tc => {
        const fname = tc.function && tc.function.name;
        const fargs = tc.function && tc.function.arguments;
        if (RETRIEVAL_TOOLS.has(fname)) searched = true;   // the agent looked at the user's data
        write({ step: { name: fname, args: fargs } });
        return { fname, fargs, id: tc.id, p: execTool(fname, fargs, ctx) };
      });
      let askedUser = false;
      for (const job of jobs) {
        const fname = job.fname, fargs = job.fargs;
        const { result, sources, summary, action, render, askUser, pendingAction } = await job.p;
        if (askUser) {   // the agent needs input — surface the question as the answer and end the turn
          write({ step_result: { name: fname, summary, detail: "" } });
          write({ message: { content: askUser } });
          allText += "\n" + askUser;
          askedUser = true;
          continue;
        }
        if (pendingAction) {   // destructive action → Approve/Cancel card in chat; end the turn awaiting the user
          write({ step_result: { name: fname, summary, detail: "" } });
          write({ pending_action: pendingAction });
          askedUser = true;
          continue;
        }
        if (RETRIEVAL_TOOLS.has(fname) && typeof result === "string" && result.trim())
          evidence.push({ source: (sources && sources[0] && sources[0].name) || fname, text: result.slice(0, 4000) });
        if (fname === "web_search" || fname === "read_url") (sources || []).forEach(s => s.path && forceSources.add(s.path));   // web results count as used
        (sources || []).forEach(s => {   // aggregate by path, keep best score
          const cur = allSources.get(s.path);
          if (!cur || cur.score < s.score) allSources.set(s.path, { name: s.name, score: s.score });
        });
        write({ step_result: { name: fname, summary, detail: typeof result === "string" ? result.slice(0, 4000) : "" } });
        if (richRender && Array.isArray(render)) render.forEach(spec => write({ render: spec }));   // data → chart/table component
        if (action) {
          write({ action });   // e.g. open a file in the UI
          if (action.type === "open_file" && action.path) { allSources.set(action.path, { name: action.name, score: 1 }); opened.add(action.path); }
        }
        // tool_call_id is required by OpenAI-compatible providers (NVIDIA) to link this result back to
        // the assistant's tool call; Ollama doesn't need it and job.id is simply absent for that path.
        convo.push({ role: "tool", content: typeof result === "string" ? result : JSON.stringify(result), ...(job.id ? { tool_call_id: job.id } : {}) });
      }
      if (askedUser) { answered = true; break; }   // waiting on the user's reply — stop the loop here
    }
    if (!answered) {   // ran out of steps → force a final answer
      let r = await callModel(false, rethought);
      if (!r.content.trim() && (r.thinking || "").trim()) {   // stalled in think mode here too
        pushAnswerNudge(r.thinking);
        r = await callModel(false, true);
        if (!r.content.trim() && (r.thinking || "").trim()) { write({ message: { content: r.thinking } }); r = { ...r, content: r.thinking }; }
      }
      allText += "\n" + r.content;
      await continueAnswer(r);   // finish an answer the token limit cut off
    }
    // cite sources the model referenced, any file it opened, plus any relevant IMAGE that was
    // retrieved (the model rarely types out image filenames, but the thumbnails are useful)
    let used = [...allSources.entries()].filter(([p, v]) =>
      opened.has(p) || forceSources.has(p) || allText.includes(v.name) || (isImageFile(v.name) && v.score >= 0.5));
    // for grounded answers: self-verify, and let the verifier narrow the sources to the one(s) actually used
    let verification = null;
    if (factCheck && (used.length || (searched && allSources.size)) && evidence.length && allText.trim()) {
      write({ step: { name: "fact_check", args: {} } });   // the end-of-answer pause is this — show it
      const evidenceText = evidence.map(e => `[${e.source}]\n${e.text}`).join("\n\n").slice(0, 7000);
      const v = await routedCompleteJSON(chosen, VERIFY_SYS, `EVIDENCE:\n${evidenceText}\n\nANSWER:\n${allText.trim().slice(0, 3500)}`);
      if (v && v.verdict) {
        const cleanIssues = arr => Array.isArray(arr) ? arr.map(s => String(s).trim()).filter(s => s && !/^(none|n\/?a|null|no issues?|nothing)$/i.test(s)).slice(0, 3) : [];
        const issues = cleanIssues(v.issues);
        verification = { verdict: String(v.verdict).toLowerCase(), issues };
        if (Array.isArray(v.used) && v.used.length && !opened.size) {
          const u = v.used.map(x => String(x).toLowerCase());
          const match = ([p, val]) => u.some(name => val.name.toLowerCase().includes(name) || name.includes(val.name.toLowerCase()));
          if (used.length) {            // narrow the name-matched sources to the one(s) the verifier confirmed
            const keep = used.filter(match);
            if (keep.length) used = keep;
          } else {                      // model never typed the filename → the verifier's attribution IS the source list
            used = [...allSources.entries()].filter(match);
          }
        }
        // Reflexion-lite: the fact-check found problems → one corrective pass with the exact issues,
        // then re-verify so the badge reflects the FIXED answer, not the draft.
        if (issues.length) {
          const fixed = await routedCompleteText(chosen,
            "You correct a draft answer so every claim is supported by the EVIDENCE. Fix or remove each problem claim listed; if the evidence does not contain the requested information, say that plainly instead. Keep the same language, format, tone and [bracketed] citations. Do not add new unsupported claims. Do not mention this correction process — output only the corrected answer.",
            `EVIDENCE:\n${evidenceText}\n\nDRAFT ANSWER:\n${allText.trim().slice(0, 3500)}\n\nPROBLEM CLAIMS:\n- ${issues.join("\n- ")}`, 1200, 0.2);
          if (fixed && fixed.trim() && fixed.trim() !== allText.trim()) {
            write({ revision: { text: fixed.trim() } });
            allText = fixed.trim();
            console.log("[agent] self-corrected after fact-check flagged " + issues.length + " claim(s)");
            const v2 = await routedCompleteJSON(chosen, VERIFY_SYS, `EVIDENCE:\n${evidenceText}\n\nANSWER:\n${allText.slice(0, 3500)}`);
            verification = v2 && v2.verdict
              ? { verdict: String(v2.verdict).toLowerCase(), issues: cleanIssues(v2.issues), revised: true }
              : { ...verification, revised: true };
          }
        }
      }
      const fcIssues = verification && verification.issues && verification.issues.length ? verification.issues : null;
      write({ step_result: { name: "fact_check",
        summary: !verification ? "check inconclusive"
          : verification.revised ? "issues found · answer corrected & re-checked"
          : fcIssues ? `${fcIssues.length} claim${fcIssues.length === 1 ? "" : "s"} to double-check`
          : verification.verdict === "supported" ? "all claims supported by sources" : verification.verdict,
        detail: fcIssues ? "Flagged claims:\n- " + fcIssues.join("\n- ") : "" } });
    }
    if (used.length) {
      const sources = used.map(([p, v]) => ({ name: v.name, path: p, score: v.score })).sort((a, b) => b.score - a.score);
      write({ sources });
    }
    // transparency: was this answer grounded in the user's data, or from the model's own knowledge?
    write({ grounding: { mode: used.length ? "grounded" : (searched ? "unsupported" : "general"), sources: used.length } });
    // value-level provenance, scoped to the sources we actually show
    if (used.length && evidence.length && allText.trim()) {
      const usedNames = new Set(used.map(([p, v]) => v.name));
      const ev = evidence.filter(e => usedNames.has(e.source));
      const prov = buildProvenance(allText, ev.length ? ev : evidence);
      if (prov.length) write({ provenance: prov });
    }
    if (verification) write({ verification });
    res.end();
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: e.message });
    else { write({ error: e.message }); res.end(); }
  }
});

/* ---------------- chat proxy → Ollama (file or folder scope) ---------------- */
app.post("/api/chat", async (req, res) => {
  const {
    filePath,
    scope = "file",
    folderPath,
    messages = [],
    thinking = false,
    systemPrompt = "",
    model,
    temperature = 0.7,
    maxTokens = 2048,
    topP = 0.9,
    contextWindow,
    useFiles = true,    // per-chat: pull context from the user's docs/KB (RAG)
    useMemory = true,   // per-chat: apply long-term memory
  } = req.body || {};

  try {
    if (scope === "file" && filePath && !guardPath(req, res, filePath)) return;
    if (scope === "folder" && folderPath && !guardPath(req, res, folderPath)) return;
    // long chat → fold the oldest turns into summary notes so the convo fits the context budget;
    // but if the user is asking to summarize/recap/take notes on THIS chat, keep it verbatim
    const recapQ = (([...messages].reverse().find(m => m.role === "user")) || {}).content || "";
    const { history: turns } = await compactHistory(model || OLLAMA_MODEL, String(req.body.sessionId || "") || null,
      messages.map((m) => ({ role: m.role, content: m.content })), histBudget(contextWindow, wantsConversationRecap(recapQ)));
    let sys, images = [], chosenModel = model, sources = [];

    if (scope === "general") {
      chosenModel = model || OLLAMA_MODEL;
      sys = systemPrompt ||
        "You are Heap Chat, a helpful, knowledgeable assistant. Answer clearly and concisely in Markdown.";
    } else if (scope === "assistant") {
      // normal assistant + automatic KB grounding when the question is relevant
      chosenModel = model || OLLAMA_MODEL;
      const lastUser = [...turns].reverse().find(t => t.role === "user");
      const kb = kbDirFor(req.user);
      let excerpts = "";
      if (useFiles !== false && lastUser && loadIndex(kb)) {   // "Use my documents" off → skip KB grounding
        const { hits } = await retrieve(kb, lastUser.content, 6);
        const relevant = hits.filter(h => h.score >= KB_THRESHOLD);
        // GraphRAG: add documents relationally connected to entities named in the question (not gated
        // by the similarity threshold — they're selected by graph links, not chunk similarity)
        const gr = graphRetrieve(req.user, lastUser.content, { folder: kb, cap: 5 });
        const seen = new Set(relevant.map(h => (h.path || h.name) + "|" + h.text.slice(0, 60)));
        const graphHits = gr.hits.filter(h => { const k = (h.path || h.name) + "|" + h.text.slice(0, 60); if (seen.has(k)) return false; seen.add(k); return true; });
        if (relevant.length || graphHits.length) {
          const best = new Map();
          for (const h of [...relevant, ...graphHits]) if (!best.has(h.name) || best.get(h.name) < h.score) best.set(h.name, h.score);
          sources = [...best.entries()].map(([name, score]) => ({ name, score })).sort((a, b) => b.score - a.score);
          const parts = [];
          if (relevant.length) parts.push(relevant.map((h) => `SOURCE: ${h.name}\n${h.text}`).join("\n\n---\n\n"));
          if (graphHits.length) parts.push(`(Related via the knowledge graph — connected to ${gr.entities.map(e => e.label).join(", ")})\n\n` +
            graphHits.map((h) => `SOURCE: ${h.name}\n${h.text}`).join("\n\n---\n\n"));
          excerpts = parts.join("\n\n---\n\n");
        }
      }
      sys = (systemPrompt ||
        "You are Heap Chat, a helpful assistant. Answer normally and conversationally in Markdown using your own knowledge. " +
        "If the CONTEXT below is relevant to the question, use it and cite the source filename in square brackets like [report.pdf]. " +
        "If the context isn't relevant, ignore it and just answer normally — do not mention it.") +
        (excerpts ? `\n\n--- CONTEXT FROM KNOWLEDGE BASE ---\n${excerpts}\n--- END CONTEXT ---\n` : "");
    } else if (scope === "folder") {
      if (!folderPath) return res.status(400).json({ error: "folderPath required" });
      chosenModel = model || OLLAMA_MODEL;
      // ensure an index exists (build on first use)
      if (!loadIndex(folderPath)) { try { await buildIndex(folderPath); } catch {} }
      const lastUser = [...turns].reverse().find(t => t.role === "user");
      const { hits, indexed } = await retrieve(folderPath, lastUser ? lastUser.content : "", 8);
      // de-duplicate citations by filename, keep best score
      const best = new Map();
      for (const h of hits) if (!best.has(h.name) || best.get(h.name) < h.score) best.set(h.name, h.score);
      sources = [...best.entries()].map(([name, score]) => ({ name, score })).sort((a, b) => b.score - a.score);
      const excerpts = hits.length
        ? hits.map((h) => `SOURCE: ${h.name}\n${h.text}`).join("\n\n---\n\n")
        : "(No relevant excerpts found in the folder index.)";
      sys =
        (systemPrompt ||
          "You are Heap Chat, answering questions about a folder of files using the excerpts below. " +
          "Ground every claim in the excerpts; cite the source filename in square brackets like [report.pdf]. " +
          "If the excerpts don't contain the answer, say so plainly.") +
        `\n\nFOLDER: ${path.basename(path.resolve(folderPath))}` +
        `${indexed ? "" : " (not indexed yet)"}` +
        `\n\n--- RELEVANT EXCERPTS ---\n${excerpts}\n--- END EXCERPTS ---\n`;
    } else {
      if (!filePath) return res.status(400).json({ error: "filePath required" });
      const kind = kindOf(filePath);
      const useVision = kind === "photo";
      chosenModel = model || (useVision ? OLLAMA_VISION_MODEL : OLLAMA_MODEL);
      const ctx = await buildFileContext(filePath, useVision);
      images = ctx.images;
      sys =
        (systemPrompt ||
          "You are Heap Chat, a helpful assistant that answers questions about the user's selected file. " +
          "Be concise, specific, and ground every answer in the file's actual content and metadata.") +
        "\n\n" + ctx.text;
    }
    // files attached in the chat composer: inject their text directly so the model sees them
    const attachPaths = accessibleOnly(req, (Array.isArray(req.body.attachments) ? req.body.attachments : []).map(p => path.resolve(String(p))))
      .filter(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }).slice(0, 8);
    for (const ap of attachPaths) {
      const nm = path.basename(ap);
      if (isImageFile(nm)) continue;   // images go through the vision path, not text injection
      try {
        const { text, status } = await extractText(ap);
        if (status === "ok" && text.trim()) {
          const snip = text.length > 32000 ? text.slice(0, 32000) + "\n…[truncated]" : text;
          sys += `\n\n--- ATTACHED FILE: ${nm} ---\n${snip}\n--- END ATTACHED FILE ---`;
          if (!sources.some(s => s.name === nm)) sources.push({ name: nm, score: 1 });
        }
      } catch {}
    }
    sys += sysInfoBlock() + (useMemory !== false ? profileBlock(req.user) + await memoryBlock(req.user, (([...turns].reverse().find(t => t.role === "user")) || {}).content || "") : "");

    // Attach images to the latest user turn (file scope, vision).
    if (images.length) {
      for (let i = turns.length - 1; i >= 0; i--) {
        if (turns[i].role === "user") { turns[i].images = images; break; }
      }
    }

    const chatMsgs = [{ role: "system", content: sys }, ...turns];

    const _chatPid = modelProviderOf(chosenModel);
    if (_chatPid !== "ollama") {
      // No native tool-calling here (this route is the simple single-file/folder/assistant/general
      // chat, not the agent) — just re-emit the provider's stream as the same Ollama-shaped NDJSON
      // lines this route already writes, so the existing frontend consumer needs no changes.
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      if (sources.length) res.write(JSON.stringify({ sources }) + "\n");
      let usedTokens = 0;
      await providerLLM.streamChatTurn(_chatPid, {
        model: routedBareModel(chosenModel), messages: chatMsgs,
        temperature, maxTokens, topP,
        onContent: c => res.write(JSON.stringify({ message: { content: c } }) + "\n"),
        onThinking: t => res.write(JSON.stringify({ message: { thinking: t } }) + "\n"),
        onContext: used => { usedTokens = used; },
      });
      if (usedTokens) res.write(JSON.stringify({ context: { used: usedTokens, max: contextWindow || 8192 } }) + "\n");
      res.end();
      return;
    }

    const payload = { keep_alive: OLLAMA_KEEP_ALIVE,
      model: chosenModel,
      messages: chatMsgs,
      stream: true,
      options: { temperature, num_predict: maxTokens, top_p: topP, ...(contextWindow ? { num_ctx: contextWindow } : {}) },
    };
    // Explicitly drive the model's reasoning pass: true = think, false = answer directly.
    // (This model reasons by default, so `think: false` is what keeps answers direct.)
    payload.think = !!thinking;

    async function call(body) {
      return fetch(`${ollamaConn.baseUrl()}/api/chat`, {
        method: "POST",
        headers: ollamaConn.headers(),
        body: JSON.stringify(body),
      });
    }

    const _t0 = Date.now();   // TIMING: Ollama withholds the response until load+prefill finish
    let upstream = await call(payload);
    // Some models don't accept a `think` flag at all — retry once without it.
    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => "");
      if (/think/i.test(detail)) {
        const { think, ...noThink } = payload;
        upstream = await call(noThink);
        if (!upstream.ok) {
          const d2 = await upstream.text().catch(() => "");
          return res.status(502).json({ error: `Ollama ${upstream.status}: ${d2 || upstream.statusText}` });
        }
      } else {
        return res.status(502).json({ error: `Ollama ${upstream.status}: ${detail || upstream.statusText}` });
      }
    }
    if (!upstream.body) return res.status(502).json({ error: "Ollama returned no stream" });

    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    if (sources.length) res.write(JSON.stringify({ sources }) + "\n");   // citations first
    const reader = upstream.body.getReader();
    const dec = new TextDecoder();
    let _tFirst = 0, _doneMeta = null, _tbuf = "";   // TIMING
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!_tFirst) _tFirst = Date.now() - _t0;
      const chunk = dec.decode(value, { stream: true });
      res.write(chunk);
      _tbuf += chunk; let nl;
      while ((nl = _tbuf.indexOf("\n")) >= 0) { const ln = _tbuf.slice(0, nl).trim(); _tbuf = _tbuf.slice(nl + 1); if (!ln) continue; try { const o = JSON.parse(ln); if (o.done) _doneMeta = o; } catch {} }
    }
    // report real context usage to the composer meter (single call here, so no peak tracking needed)
    if (_doneMeta && _doneMeta.prompt_eval_count) res.write(JSON.stringify({ context: { used: _doneMeta.prompt_eval_count, max: contextWindow || 8192 } }) + "\n");
    res.end();
    const _ms = d => Math.round((d || 0) / 1e6);
    const _load = _doneMeta ? _ms(_doneMeta.load_duration) : 0;
    console.log(`[TIMING] chat  stall-before-first-token=${_tFirst}ms  [load=${_load}ms${_load > 800 ? " ⚠️RELOAD" : ""} + prefill=${_doneMeta ? _ms(_doneMeta.prompt_eval_duration) : 0}ms/${_doneMeta ? _doneMeta.prompt_eval_count || 0 : 0}tok]  gen=${_doneMeta ? _ms(_doneMeta.eval_duration) : 0}ms/${_doneMeta ? _doneMeta.eval_count || 0 : 0}tok`);
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: e.message });
    else res.end();
  }
});

/* ---------------- list installed Ollama models (+ any configured provider connections) ---------------- */
app.get("/api/models", async (_req, res) => {
  // provider models are addressed as "<providerId>/<real-id>" everywhere in the app — see src/llm/router.js
  const providerModels = serverSettings.listProviders().filter(p => p.apiKey).flatMap(p => (p.models || []).map(m => p.id + "/" + m));
  try {
    const r = await fetch(`${ollamaConn.baseUrl()}/api/tags`, { headers: ollamaConn.headers(), signal: AbortSignal.timeout(5000) });
    const j = await r.json();
    const models = (j.models || []).map(m => m.name).sort((a, b) => a.localeCompare(b));
    res.json({ models: [...models, ...providerModels] });
  } catch {
    res.json({ models: providerModels });
  }
});

/* ---------------- ad-hoc vision chat (image dragged into chat) ---------------- */
app.post("/api/vision", async (req, res) => {
  const { image, images, messages = [], model, temperature = 0.4, maxTokens = 1024, contextWindow } = req.body || {};
  try {
    const srcImgs = (Array.isArray(images) && images.length ? images : (image ? [image] : []));
    if (!srcImgs.length) return res.status(400).json({ error: "image required" });
    const b64s = srcImgs.map(s => String(s).replace(/^data:[^,]+,/, ""));
    const turns = messages.map(m => ({ role: m.role, content: m.content }));
    for (let i = turns.length - 1; i >= 0; i--) { if (turns[i].role === "user") { turns[i].images = b64s; break; } }
    const sys = "You are Heap Chat. The user attached an image; answer their questions about it clearly in Markdown." +
      sysInfoBlock() + profileBlock(req.user) +
      await memoryBlock(req.user, (([...turns].reverse().find(t => t.role === "user")) || {}).content || "");
    const payload = { keep_alive: OLLAMA_KEEP_ALIVE, model: model || OLLAMA_VISION_MODEL, messages: [{ role: "system", content: sys }, ...turns], stream: true, think: false, options: { temperature, num_predict: maxTokens, ...(contextWindow ? { num_ctx: contextWindow } : {}) } };
    const up = await fetch(`${ollamaConn.baseUrl()}/api/chat`, { method: "POST", headers: ollamaConn.headers(), body: JSON.stringify(payload) });
    if (!up.ok || !up.body) { const d = await up.text().catch(() => ""); return res.status(502).json({ error: `Ollama ${up.status}: ${d}` }); }
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    const reader = up.body.getReader(), dec = new TextDecoder();
    for (;;) { const { value, done } = await reader.read(); if (done) break; res.write(dec.decode(value, { stream: true })); }
    res.end();
  } catch (e) { if (!res.headersSent) res.status(502).json({ error: e.message }); else res.end(); }
});

/* ---------------- ollama health ---------------- */
app.get("/api/health", async (_req, res) => {
  try {
    const r = await fetch(`${ollamaConn.baseUrl()}/api/tags`, { headers: ollamaConn.headers(), signal: AbortSignal.timeout(4000) });
    res.json({ ok: r.ok });
  } catch {
    res.json({ ok: false });
  }
});

/* ---------------- first-run setup ----------------
   One call the setup screen polls: is Ollama reachable, what's installed, and how
   much RAM the box has (so the UI can recommend a right-sized model). */
app.get("/api/setup/status", async (_req, res) => {
  let ollama = false, models = [];
  try {
    const r = await fetch(`${ollamaConn.baseUrl()}/api/tags`, { headers: ollamaConn.headers(), signal: AbortSignal.timeout(4000) });
    if (r.ok) { ollama = true; const j = await r.json(); models = (j.models || []).map(m => m.name).sort((a, b) => a.localeCompare(b)); }
  } catch {}
  res.json({ ollama, endpoint: ollamaConn.baseUrl(), models, ramGB: Math.round(os.totalmem() / 1073741824) });
});

// stream a model download from Ollama to the client (NDJSON progress: status + total/completed bytes)
app.post("/api/ollama/pull", async (req, res) => {
  const model = String((req.body || {}).model || "").trim();
  if (!model) return res.status(400).json({ error: "model required" });
  try {
    // send both keys — older Ollama expects `name`, newer accepts `model`
    const up = await fetch(`${ollamaConn.baseUrl()}/api/pull`, {
      method: "POST", headers: ollamaConn.headers(),
      body: JSON.stringify({ name: model, model, stream: true }),
    });
    if (!up.ok || !up.body) { const d = await up.text().catch(() => ""); return res.status(502).json({ error: `Ollama ${up.status}: ${d}` }); }
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    const reader = up.body.getReader(), dec = new TextDecoder();
    for (;;) { const { value, done } = await reader.read(); if (done) break; res.write(dec.decode(value, { stream: true })); }
    res.end();
  } catch (e) { if (!res.headersSent) res.status(502).json({ error: e.message }); else res.end(); }
});

// SPA fallback: serve the app shell for client-side routes (/chat, /settings, /folder, …) so refresh/deep-links work
/* ============================================================
   MCP server mode — exposes the knowledge-base tools at /mcp so any MCP client
   (Claude Desktop, Claude Code, …) can search and read your KB. Stateless
   Streamable-HTTP: each POST gets a fresh server + transport. Auth: per-user
   bearer token (Settings → MCP token), scoped to that user's KB.
   makeMcpServer → src/mcp/server.js
   ============================================================ */
app.post("/mcp", async (req, res) => {
  try {
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const user = token && users.find(u => u.mcpToken === token);
    if (!user) return res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Invalid or missing bearer token — copy yours from Settings → MCP token" }, id: null });
    const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });   // stateless
    res.on("close", () => transport.close());
    await (await makeMcpServer(user)).connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: e.message }, id: null });
  }
});
// stateless server → no SSE stream or session lifecycle on GET/DELETE
const mcpNoSession = (_req, res) => res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
app.get("/mcp", mcpNoSession);
app.delete("/mcp", mcpNoSession);

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();   // let unmatched API routes 404 normally
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ---------------- network access: admin-toggleable bind (data/server.json) ---------------- */
function lanUrls() {
  const out = [];
  for (const ifs of Object.values(os.networkInterfaces()))
    for (const i of ifs || []) if (i.family === "IPv4" && !i.internal) out.push(`http://${i.address}:${PORT}`);
  return out;
}
let httpServer = null;
function bindServer() {
  const host = serverSettings.get().lanAccess ? "0.0.0.0" : "127.0.0.1";
  httpServer = app.listen(PORT, host, () => {
    console.log(`\n  Heap Chat running →  http://localhost:${PORT}`);
    if (serverSettings.get().lanAccess) lanUrls().forEach(u => console.log(`  On your network →  ${u}`));
    console.log(`  Ollama:  ${ollamaConn.baseUrl()}`);
    console.log(`  Model:   ${OLLAMA_MODEL}\n`);
    const active = serverSettings.listProviders().filter(p => p.apiKey);
    if (active.length) console.log(`  Providers:  ${active.map(p => `${p.name} (${p.models.length})`).join(", ")}\n`);
  });
}
bindServer();
startScheduler();   // process-wide ticker: runs due scheduled jobs + daily profile rebuild
