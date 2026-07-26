/* ============================================================
   Knowledge graph — entity layer over photos + documents.
   LLM-light by design: the chat model is NEVER called to build the graph. Nodes/edges
   come from signals we already compute — named people (face clusters), GPS places,
   autotags — plus deterministic NER over the text that's ALREADY in the search index.
   Per-doc entities cache by mtime (data/entities.json), so it's incremental.
   ============================================================ */
const fs = require("fs");
const path = require("path");
const { entityStore, persistEntities, placeNames, geoStore, getTags } = require("../state/sidecars");
const { storesFor, kbDirFor, isKbDir } = require("../state/user-stores");
const { canAccessPath, realResolve } = require("../auth/access");
const { DATA_DIR } = require("../config");
const { isImageFile } = require("../util/files");
const { INDEX_DIR } = require("../rag/index");
const { geoFor } = require("./photos");

async function reverseGeocode(lat, lng) {
  // BigDataCloud's free client endpoint — no API key, generous limits, returns city/region/country.
  const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("geocode " + r.status);
  const j = await r.json();
  const place = j.city || j.locality || j.principalSubdivision;
  const cc = j.countryCode || j.countryName;
  const label = [place, cc].filter(Boolean).join(", ");
  return label || null;
}
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// common capitalized words that start sentences / aren't entities — keep noise down
const ENT_STOP = new Set(("the a an and or but if then else for to in on at of by with from as is are was were be been " +
  "this that these those i we you he she it they me my our your his her their its mr mrs ms dr prof sir " +
  "january february march april may june july august september october november december " +
  "monday tuesday wednesday thursday friday saturday sunday " +
  "subject date from sent to cc re fwd hi hello dear thanks regards best please note also however therefore " +
  "yes no ok page chapter section figure table").split(/\s+/));
const ORG_HINT = /\b(Inc|LLC|Ltd|Corp|Co|Company|University|College|School|Institute|Institute|Agency|Bank|Group|Foundation|Association|Committee|Ministry|Hospital|Limited|GmbH|PLC|Technologies|Systems|Labs|Studios|Partners)\b/i;

// pull capitalized proper-noun phrases + a few structured types from raw text — pure CPU, no model
function extractEntities(text) {
  const found = new Map();   // dedupe key -> { text, kind }
  const add = (t, kind) => {
    t = t.replace(/\s+/g, " ").trim().replace(/[.,;:'"]+$/, "");
    if (t.length < 2 || t.length > 60) return;
    const key = kind + ":" + t.toLowerCase();
    if (!found.has(key)) found.set(key, { text: t, kind });
  };
  (text.match(/[\w.+-]+@[\w-]+\.[\w.-]{2,}/g) || []).forEach(e => add(e.toLowerCase(), "email"));
  // proper-noun phrases: runs of Capitalized tokens, joined by lowercase connectors
  const connectors = new Set(["of", "the", "and", "&", "de", "van", "von", "da", "del", "for"]);
  const tokens = text.split(/(\s+|[.,;:!?()"“”\[\]{}\/])/);
  let phrase = [];
  const flush = () => {
    if (!phrase.length) return;
    while (phrase.length && connectors.has(phrase[phrase.length - 1].toLowerCase())) phrase.pop();
    const t = phrase.join(" ");
    const words = t.split(/\s+/).filter(w => !connectors.has(w.toLowerCase()));
    // drop single common/stopword tokens; keep multi-word names or distinctive single names
    if (words.length && !(words.length === 1 && ENT_STOP.has(words[0].toLowerCase())) && t.length > 1)
      add(t, ORG_HINT.test(t) ? "org" : "term");
    phrase = [];
  };
  for (const raw of tokens) {
    const w = (raw || "").trim();
    if (!w) continue;
    if (/^[A-Z][A-Za-z'’.\-]*$/.test(w) && !ENT_STOP.has(w.toLowerCase())) phrase.push(w);
    else if (phrase.length && connectors.has(w.toLowerCase())) phrase.push(w.toLowerCase());
    else flush();
  }
  flush();
  return [...found.values()];
}
function getDocEntities(p, mtime, text) {
  const c = entityStore[p];
  if (c && c.mtime === mtime && Array.isArray(c.ents)) return c.ents;
  const ents = extractEntities(text);
  entityStore[p] = { mtime, ents }; persistEntities();
  return ents;
}

// assemble the per-user graph from cheap signals (no chat-LLM); cached briefly
const graphCache = new Map();   // userId -> { at, g }
function buildGraph(user) {
  const st = storesFor(user);
  const nodes = new Map();   // id -> { id, label, kind, photos:Set, docs:Set }
  const node = (id, label, kind) => { let n = nodes.get(id); if (!n) { n = { id, label, kind, photos: new Set(), docs: new Set() }; nodes.set(id, n); } return n; };
  const edges = new Map();   // a -> Map(b -> weight)
  const link = (a, b) => { if (a === b) return; if (b < a) { const t = a; a = b; b = t; } let m = edges.get(a); if (!m) edges.set(a, m = new Map()); m.set(b, (m.get(b) || 0) + 1); };

  // people (named face clusters) → person nodes; remember who's in each photo
  const photoPeople = new Map();   // path -> [personNodeId]
  const nameMatchers = [];
  for (const [pid, p] of Object.entries(st.people)) {
    if (!p || !p.name) continue;
    const id = "person:" + pid;
    const n = node(id, p.name, "person");
    nameMatchers.push({ id, re: new RegExp("\\b" + escapeRe(p.name) + "\\b", "i") });
    for (const ph of (p.photos || [])) {
      if (!canAccessPath(user, ph)) continue;
      n.photos.add(ph);
      if (!photoPeople.has(ph)) photoPeople.set(ph, []);
      photoPeople.get(ph).push(id);
    }
  }
  // places (GPS grid clusters ~2km) → place nodes
  const placeOf = new Map();
  for (const [ph, rec] of Object.entries(geoStore)) {
    const g = rec && rec.gps;
    if (!g || typeof g.lat !== "number" || !canAccessPath(user, ph)) continue;
    const key = (Math.round(g.lat * 50) / 50) + "," + (Math.round(g.lng * 50) / 50);
    const id = "place:" + key;
    node(id, placeNames[key] || `${g.lat.toFixed(2)}, ${g.lng.toFixed(2)}`, "place").photos.add(ph);
    placeOf.set(ph, id);
  }
  // co-occurrence from photos: people together, people↔place
  for (const [ph, people] of photoPeople) {
    const pl = placeOf.get(ph);
    for (let i = 0; i < people.length; i++) {
      if (pl) link(people[i], pl);
      for (let j = i + 1; j < people.length; j++) link(people[i], people[j]);
    }
  }
  // documents from accessible indexes → topic (tags), person (mentions), org/term (NER)
  const seen = new Set();
  let indexFiles = [];
  try { indexFiles = fs.readdirSync(INDEX_DIR).filter(f => f.endsWith(".json")); } catch {}
  const myKb = kbDirFor(user);
  const dataReal = realResolve(DATA_DIR);
  for (const f of indexFiles) {
    let idx; try { idx = JSON.parse(fs.readFileSync(path.join(INDEX_DIR, f), "utf8")); } catch { continue; }
    if (!idx || !idx.folder || !canAccessPath(user, idx.folder)) continue;
    if (isKbDir(idx.folder) && idx.folder !== myKb) continue;   // skip other users' private KBs
    // never ingest the app's OWN storage: chats.json, memory.json, the user dir, etc. all live under
    // DATA_DIR and would otherwise reappear as graph nodes even right after a "start fresh". Only real
    // KB content (a path with a /kb/ segment) under DATA_DIR is a legitimate source.
    const folderReal = realResolve(idx.folder);
    if ((folderReal === dataReal || folderReal.startsWith(dataReal + path.sep)) &&
        !folderReal.split(path.sep).includes("kb")) continue;
    for (const [docPath, file] of Object.entries(idx.files || {})) {
      if (seen.has(docPath) || isImageFile(file.name)) continue;
      seen.add(docPath);
      const ents = [];
      for (const tg of getTags(docPath)) { const id = "topic:" + tg.toLowerCase(); node(id, tg, "topic").docs.add(docPath); ents.push(id); }
      const text = (file.chunks || []).map(c => c.text).join(" ").slice(0, 24000);
      for (const m of nameMatchers) { if (m.re.test(text)) { nodes.get(m.id).docs.add(docPath); ents.push(m.id); } }
      for (const e of getDocEntities(docPath, file.mtime, text)) {
        if (e.kind === "email") continue;   // keep the graph to named things
        const id = e.kind + ":" + e.text.toLowerCase();
        node(id, e.text, e.kind).docs.add(docPath); ents.push(id);
      }
      const uniq = [...new Set(ents)];
      for (let i = 0; i < uniq.length; i++) for (let j = i + 1; j < uniq.length; j++) link(uniq[i], uniq[j]);
    }
  }
  // weights + prune noise: reliable kinds (people/places/topics) kept at weight≥1; orgs need ≥2;
  // generic NER "terms" are the noisiest, so they need ≥3 occurrences to make the cut.
  const MIN_WEIGHT = { person: 1, place: 1, topic: 1, org: 2, term: 3 };
  let arr = [...nodes.values()].map(n => { n.weight = n.photos.size + n.docs.size; return n; });
  arr = arr.filter(n => n.weight >= (MIN_WEIGHT[n.kind] || 2));
  arr.sort((a, b) => b.weight - a.weight);
  arr = arr.slice(0, 220);
  const keep = new Set(arr.map(n => n.id));
  const outEdges = [];
  for (const [a, m] of edges) { if (!keep.has(a)) continue; for (const [b, w] of m) if (keep.has(b)) outEdges.push({ a, b, w }); }
  return { nodes: arr, edges: outEdges };
}
function graphFor(user, force) {
  const c = graphCache.get(user.id);
  if (!force && c && Date.now() - c.at < 60000) return c.g;
  const g = buildGraph(user);
  graphCache.set(user.id, { at: Date.now(), g });
  return g;
}
// extract+cache GPS for the photos the graph already knows about (named-people photos + indexed
// images), so Places show up without opening the Photo Map first. Cached by mtime → one-time cost.
async function ensurePhotoGeo(user, cap = 400) {
  const st = storesFor(user);
  const set = new Set();
  for (const p of Object.values(st.people)) for (const ph of (p.photos || [])) if (canAccessPath(user, ph)) set.add(ph);
  let idxFiles = []; try { idxFiles = fs.readdirSync(INDEX_DIR).filter(f => f.endsWith(".json")); } catch {}
  const myKb = kbDirFor(user);
  for (const f of idxFiles) {
    let idx; try { idx = JSON.parse(fs.readFileSync(path.join(INDEX_DIR, f), "utf8")); } catch { continue; }
    if (!idx || !idx.folder || !canAccessPath(user, idx.folder)) continue;
    if (isKbDir(idx.folder) && idx.folder !== myKb) continue;
    for (const [p, file] of Object.entries(idx.files || {})) if (isImageFile(file.name) && canAccessPath(user, p)) set.add(p);
  }
  let parsed = 0;
  for (const ph of set) {
    if (parsed >= cap) break;
    let stt; try { stt = fs.statSync(ph); } catch { continue; }
    const cached = geoStore[ph];
    if (cached && cached.mtime === stt.mtimeMs) continue;   // already scanned (incl. cached "no GPS")
    try { await geoFor(ph); parsed++; } catch {}
  }
  return parsed;
}
// pull real text snippets for a set of documents from the search index (chunks already embedded there),
// preferring chunks that mention `term` — so the agent can summarize from CONTENT, not just counts.
function docExcerptsFor(user, paths, term, cap = 6) {
  const want = paths instanceof Set ? paths : new Set(paths);
  if (!want.size) return [];
  // term may be a string, an array of strings (OR-match), or null (any chunk)
  const terms = term == null ? null : (Array.isArray(term) ? term : [term]).filter(Boolean);
  const re = terms && terms.length ? new RegExp("\\b(" + terms.map(escapeRe).join("|") + ")\\b", "i") : null;
  const out = [];
  let idxFiles = []; try { idxFiles = fs.readdirSync(INDEX_DIR).filter(f => f.endsWith(".json")); } catch {}
  const myKb = kbDirFor(user);
  for (const f of idxFiles) {
    if (out.length >= cap) break;
    let idx; try { idx = JSON.parse(fs.readFileSync(path.join(INDEX_DIR, f), "utf8")); } catch { continue; }
    if (!idx || !idx.folder || !canAccessPath(user, idx.folder)) continue;
    if (isKbDir(idx.folder) && idx.folder !== myKb) continue;
    for (const [p, file] of Object.entries(idx.files || {})) {
      if (!want.has(p)) continue;
      for (const c of (file.chunks || [])) {
        if (re && !re.test(c.text)) continue;
        out.push({ name: file.name, path: p, text: c.text.replace(/\s+/g, " ").trim().slice(0, 480) });
        if (out.length >= cap) break;
      }
      if (out.length >= cap) break;
    }
  }
  return out;
}

// ---------------- GraphRAG: relational retrieval over the knowledge graph ----------------
// Anchors a query to knowledge-graph entities (people / places / topics / orgs / terms), expands one
// hop through co-occurrence edges, and pulls excerpts from the documents connected to those entities.
// Complements vector RAG: surfaces relationally-linked context ("who/where/connected-to") that pure
// chunk-similarity misses. Returns { entities:[{label,kind}], hits:[{name,path,text,score}] }.
function graphRetrieve(user, query, opts = {}) {
  const q = String(query || "").trim();
  if (q.length < 3) return { entities: [], hits: [] };
  const g = graphFor(user, false);
  if (!g.nodes.length) return { entities: [], hits: [] };
  const ql = q.toLowerCase();
  // seed nodes: those whose label is mentioned in the query (whole-word for single tokens, substring for phrases)
  const seeds = g.nodes.filter(n => {
    const lab = n.label.toLowerCase();
    if (lab.length < 3) return false;
    return lab.includes(" ") ? ql.includes(lab) : new RegExp("\\b" + escapeRe(lab) + "\\b").test(ql);
  });
  if (!seeds.length) return { entities: [], hits: [] };
  const seedIds = new Set(seeds.map(n => n.id));
  const byId = new Map(g.nodes.map(n => [n.id, n]));
  // one-hop neighbors, ranked by total edge weight back to a seed
  const hop = new Map();
  for (const e of g.edges) {
    if (seedIds.has(e.a) === seedIds.has(e.b)) continue;   // edge must cross the seed boundary
    const other = seedIds.has(e.a) ? e.b : e.a;
    hop.set(other, (hop.get(other) || 0) + e.w);
  }
  const folder = opts.folder ? path.resolve(opts.folder) : null;
  const inFolder = p => !folder || p === folder || p.startsWith(folder + path.sep);
  // documents connected to the seeds, plus those from the strongest neighbors
  const docs = new Set();
  for (const n of seeds) for (const d of n.docs) if (inFolder(d)) docs.add(d);
  for (const [id] of [...hop.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    const n = byId.get(id); if (n) for (const d of n.docs) if (inFolder(d)) docs.add(d);
  }
  const entities = seeds.map(s => ({ label: s.label, kind: s.kind }));
  if (!docs.size) return { entities, hits: [] };
  // prefer chunks that actually name a seed entity; fall back to any chunk from a connected doc
  let ex = docExcerptsFor(user, docs, seeds.map(s => s.label), opts.cap || 5);
  if (!ex.length) ex = docExcerptsFor(user, docs, null, opts.cap || 5);
  const hits = ex.map(e => ({ name: e.name, path: e.path || null, text: e.text, score: 0.45 }));
  return { entities, hits };
}

module.exports = {
  reverseGeocode, extractEntities, getDocEntities, buildGraph, graphCache, graphFor,
  ensurePhotoGeo, docExcerptsFor, graphRetrieve,
};
