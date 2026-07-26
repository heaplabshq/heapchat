/* ============================================================
   RAG engine — folder index (embeddings). Each indexed folder/file is stored on
   disk at data/index/<key>.json with a small in-memory LRU cache. Embeddings come
   from the local Ollama embed model; only changed files are re-embedded.
   (Retrieval/scoring lives in src/rag/retrieve.js.)
   ============================================================ */
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { DATA_DIR, OLLAMA_KEEP_ALIVE, OLLAMA_EMBED_MODEL } = require("../config");
const ollamaConn = require("../llm/ollama-conn");
const { writeJSONAtomic } = require("../util/json-store");
const { extOf, kindOf, TEXTLIKE, isImageFile } = require("../util/files");
const { getTags, imageMeta } = require("../state/sidecars");
const { USERS_DIR, isKbDir } = require("../state/user-stores");
const { users } = require("../auth/accounts");
const { canAccessPath } = require("../auth/access");
const { extractText } = require("./extract");

const EMBED_MODEL = OLLAMA_EMBED_MODEL;   // server default; callers can pass a different model per index (see indexFiles)
const INDEX_DIR = path.join(DATA_DIR, "index");
const MAX_INDEX_FILES = 400;     // safety cap per folder tree
const MAX_CHUNKS_PER_FILE = 60;
const CHUNK_SIZE = 1200, CHUNK_OVERLAP = 200;
const KB_THRESHOLD = 0.5;   // min cosine score to treat a KB chunk as relevant in assistant mode

function indexKey(folderPath) { return Buffer.from(path.resolve(folderPath)).toString("base64url"); }
function indexPath(folderPath) { return path.join(INDEX_DIR, indexKey(folderPath) + ".json"); }
// in-memory cache so a 10–30 MB index isn't re-read + re-parsed on every retrieve/related/agent call.
// keyed by file mtime (picks up external rebuilds), small LRU to bound memory.
const indexCache = new Map();   // indexPath -> { mtime, idx }
const INDEX_CACHE_MAX = 5;
function cacheGet(fp) { const v = indexCache.get(fp); if (v) { indexCache.delete(fp); indexCache.set(fp, v); } return v; }   // touch = move to MRU
function cacheSet(fp, mtime, idx) {
  indexCache.set(fp, { mtime, idx });
  while (indexCache.size > INDEX_CACHE_MAX) indexCache.delete(indexCache.keys().next().value);   // evict LRU
}
function loadIndex(folderPath) {
  const fp = indexPath(folderPath);
  let st; try { st = fs.statSync(fp); } catch { indexCache.delete(fp); return null; }
  const hit = cacheGet(fp);
  if (hit && hit.mtime === st.mtimeMs) return hit.idx;
  try { const idx = JSON.parse(fs.readFileSync(fp, "utf8")); cacheSet(fp, st.mtimeMs, idx); return idx; }
  catch { indexCache.delete(fp); return null; }
}
function saveIndex(folderPath, idx) {
  const fp = indexPath(folderPath);
  try {
    writeJSONAtomic(fp, JSON.stringify(idx));
    let st; try { st = fs.statSync(fp); } catch {}
    cacheSet(fp, st ? st.mtimeMs : Date.now(), idx);   // keep cache hot with the just-written index
  } catch (e) { console.error("index save:", e.message); }
}
function chunkText(text) {
  const clean = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const out = []; let i = 0;
  while (i < clean.length && out.length < MAX_CHUNKS_PER_FILE) {
    out.push(clean.slice(i, i + CHUNK_SIZE));
    i += CHUNK_SIZE - CHUNK_OVERLAP;
  }
  return out;
}
// recursively collect text-extractable files (capped)
async function walkFiles(root, depth = 0, acc = []) {
  if (acc.length >= MAX_INDEX_FILES || depth > 6) return acc;
  let entries; try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) { await walkFiles(full, depth + 1, acc); }
    else if (e.isFile()) {
      const ext = extOf(e.name);
      if (TEXTLIKE.has(ext) || ext === "pdf" || ext === "docx" || isImageFile(ext)) acc.push(full);
    }
    if (acc.length >= MAX_INDEX_FILES) break;
  }
  return acc;
}
async function embed(inputs, model = EMBED_MODEL) {
  const out = [];
  for (let i = 0; i < inputs.length; i += 32) {
    const batch = inputs.slice(i, i + 32);
    const r = await fetch(`${ollamaConn.baseUrl()}/api/embed`, {
      method: "POST", headers: ollamaConn.headers(),
      body: JSON.stringify({ keep_alive: OLLAMA_KEEP_ALIVE, model, input: batch }),
    });
    if (!r.ok) throw new Error(`embed ${r.status}: ${await r.text().catch(() => "")}`);
    const j = await r.json();
    for (const v of (j.embeddings || [])) out.push(v);
  }
  return out;
}
// core: index a specific set of files under `key`, re-embedding only changed ones.
// `model` lets a caller pick a non-default embedding model (per-user Settings override); if it
// differs from whatever model built the existing index, ALL cached vectors are discarded — mixing
// vectors from two different embedding spaces in one cosine comparison would be silently wrong,
// not just stale, so a model change forces a full re-embed rather than an incremental one.
async function indexFiles(key, filePaths, model = EMBED_MODEL) {
  let prev = loadIndex(key) || { folder: key, files: {} };
  if (prev.embedModel && prev.embedModel !== model) prev = { folder: key, files: {} };
  const next = { folder: key, embedModel: model, updatedAt: Date.now(), files: {} };
  let embedded = 0, reused = 0, skipped = 0;
  for (const full of filePaths) {
    let st; try { st = await fsp.stat(full); } catch { continue; }
    const cached = prev.files[full];
    // reuse cached embeddings for unchanged plain files; images & tagged files always re-embed
    // (cheap) so updated captions/context/tags take effect immediately
    if (cached && cached.mtime === st.mtimeMs && !isImageFile(full) && !getTags(full).length) { next.files[full] = cached; reused++; continue; }
    const { text, status } = await extractText(full);
    if (status !== "ok" || !text.trim()) { skipped++; continue; }
    const chunks = chunkText(text);
    if (!chunks.length) { skipped++; continue; }
    let vecs;
    try { vecs = await embed(chunks, model); } catch (e) { skipped++; continue; }
    next.files[full] = { name: path.basename(full), mtime: st.mtimeMs, chunks: chunks.map((t, i) => ({ text: t, vec: vecs[i] })) };
    embedded++;
  }
  saveIndex(key, next);
  const totalChunks = Object.values(next.files).reduce((n, f) => n + f.chunks.length, 0);
  return { folder: key, files: Object.keys(next.files).length, chunks: totalChunks, embedded, reused, skipped };
}
// build/update the index for a whole folder (recursive), re-embedding only changed files.
// The KB / main-chat corpus also includes every image the user has made searchable,
// wherever it lives — so "Make searchable" on a folder image surfaces it in the main chat.
async function buildIndex(folderPath, model = EMBED_MODEL) {
  const root = path.resolve(folderPath);
  let files = await walkFiles(root);
  if (isKbDir(root)) {
    // fold in searchable disk images — but only ones this KB's owner is allowed to see
    const owner = users.find(u => u.id === path.basename(path.dirname(root)));
    const externalImages = Object.keys(imageMeta).filter(p =>
      !p.startsWith(root + path.sep) && !p.startsWith(USERS_DIR + path.sep) && canAccessPath(owner, p) && fs.existsSync(p));
    files = [...files, ...externalImages];
  }
  return indexFiles(root, files, model);
}
// index a single file (key = the file path)
async function buildFileIndex(filePath, model = EMBED_MODEL) {
  const f = path.resolve(filePath);
  return indexFiles(f, [f], model);
}
// list the files currently in an index (recursive set), with light metadata
function indexedFiles(key) {
  const idx = loadIndex(key);
  if (!idx) return [];
  return Object.entries(idx.files).map(([p, f]) => ({ path: p, name: f.name, kind: kindOf(f.name) }));
}

module.exports = {
  EMBED_MODEL, INDEX_DIR, MAX_INDEX_FILES, MAX_CHUNKS_PER_FILE, CHUNK_SIZE, CHUNK_OVERLAP, KB_THRESHOLD,
  indexKey, indexPath, indexCache, loadIndex, saveIndex, chunkText, walkFiles, embed,
  indexFiles, buildIndex, buildFileIndex, indexedFiles,
};
