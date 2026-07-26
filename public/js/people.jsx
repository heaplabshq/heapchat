import { Icon, fileUrl } from "./icons.jsx";
// people.jsx — People albums: detect faces (face-api.js, in-browser), cluster them, name people,
// browse by person, assign faces inside individual photos, and manage all named people in one place.
// Fully local. face-api.js + models are vendored and loaded lazily (only when this view opens).
const { useState: usePS, useEffect: usePE, useRef: usePR } = React;

const FACE_MODELS_URL = "/vendor/faceapi/models";
const FACE_THRESH = 0.55;       // clustering: faces closer than this (to a cluster's seed) are the same person
const AUTO_THRESH = 0.5;        // stricter bar for auto-applying an already-named person's label
const DETECT_W = 1024;          // larger working image so visible faces (incl. stylized/AI-edited) aren't missed
const DETECT_INPUT = 512;       // tinyFaceDetector input size (multiple of 32) — bigger = better recall on varied faces
const DETECT_SCORE = 0.45;      // detection confidence floor — lower than default to catch faces the strict bar missed

let _faceApiReady = null;
function loadFaceApi() {
  if (_faceApiReady) return _faceApiReady;
  _faceApiReady = new Promise((resolve, reject) => {
    if (window.faceapi) return resolve(window.faceapi);
    const s = document.createElement("script");
    s.src = "/vendor/faceapi/face-api.js";
    s.onload = () => resolve(window.faceapi);
    s.onerror = () => reject(new Error("Couldn't load the face model."));
    document.head.appendChild(s);
  }).then(async (faceapi) => {
    await faceapi.nets.tinyFaceDetector.loadFromUri(FACE_MODELS_URL);
    await faceapi.nets.faceLandmark68Net.loadFromUri(FACE_MODELS_URL);
    await faceapi.nets.faceRecognitionNet.loadFromUri(FACE_MODELS_URL);
    return faceapi;
  }).catch(err => { _faceApiReady = null; throw err; });   // don't cache a failed load — let the next attempt retry
  return _faceApiReady;
}

async function loadImg(url) { const img = new Image(); img.src = url; await img.decode(); return img; }

async function detectFaces(faceapi, path) {
  if (!path) { console.warn("[faces] detectFaces called with no path"); throw new Error("No photo is selected to scan."); }
  // Prefer the resized thumbnail (fast). If its bytes won't decode (corrupt/odd cached JPEG, or a
  // format the thumbnailer mangled), fall back to the ORIGINAL file the gallery itself displays.
  const ep = encodeURIComponent(path);
  let img; const errs = [];
  for (const [label, url] of [["thumbnail", "/api/thumb?path=" + ep + "&w=" + DETECT_W], ["original", "/api/file?path=" + ep]]) {
    try { img = await loadImg(url); break; }
    catch (e) { errs.push(label + " (" + (e && e.name || "error") + ")"); }
  }
  if (!img) {
    // EncodingError on both sources = the bytes aren't a decodable image (broken/placeholder file
    // with an image extension, e.g. a 0-byte or failed-upload stub), not a transient load failure.
    const undecodable = errs.length === 2 && errs.every(s => s.includes("EncodingError"));
    const name = String(path).split("/").pop();
    throw new Error(undecodable
      ? `"${name}" isn't a readable image — it looks broken or is a placeholder (e.g. a failed upload), so there's nothing to scan.`
      : `Couldn't load "${name}" for scanning — tried ` + errs.join(" and ") + ".");
  }
  let src = img, W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
  // downscale large originals onto a canvas so detection stays fast and memory-safe (boxes are
  // normalized to [0,1] below, so the working resolution doesn't matter to callers/thumbnails)
  if (W > DETECT_W) {
    const cw = DETECT_W, ch = Math.round(H * (DETECT_W / W));
    const cv = document.createElement("canvas"); cv.width = cw; cv.height = ch;
    cv.getContext("2d").drawImage(img, 0, 0, cw, ch);
    src = cv; W = cw; H = ch;
  }
  const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: DETECT_INPUT, scoreThreshold: DETECT_SCORE });
  const results = await faceapi.detectAllFaces(src, opts).withFaceLandmarks().withFaceDescriptors();
  return results.map(r => ({
    descriptor: Array.from(r.descriptor),
    box: { x: r.detection.box.x / W, y: r.detection.box.y / H, w: r.detection.box.width / W, h: r.detection.box.height / H },
  }));
}

async function scanImages(images, onProgress, cancelRef) {
  const faceapi = await loadFaceApi();
  let done = 0, faces = 0;
  for (const im of images) {
    if (cancelRef.current) break;
    try {
      const payload = await detectFaces(faceapi, im.path);
      faces += payload.length;
      await fetch("/api/faces", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: im.path, mtime: im.mtime, faces: payload }) });
    } catch {}
    done++; onProgress(done, faces);
  }
  return faces;
}

// greedy clustering against each cluster's SEED descriptor (fixed at creation) — unlike a
// running-mean centroid, the reference never drifts, so it won't snowball everyone into one group.
function clusterFaces(faces) {
  const faceapi = window.faceapi;
  const clusters = [];
  let nid = 0;
  for (const f of faces) {
    let best = null, bestD = Infinity;
    for (const c of clusters) { const d = faceapi.euclideanDistance(f.descriptor, c.seed); if (d < bestD) { bestD = d; best = c; } }
    if (best && bestD < FACE_THRESH) best.members.push(f);
    else clusters.push({ id: "k" + (nid++), seed: f.descriptor, members: [f] });
  }
  for (const c of clusters) {
    const cen = new Array(128).fill(0);
    for (const m of c.members) for (let i = 0; i < 128; i++) cen[i] += m.descriptor[i];
    for (let i = 0; i < 128; i++) cen[i] /= c.members.length;
    c.centroid = cen;   // mean, saved for cross-session auto-match
    c.rep = c.members.reduce((a, b) => ((b.box && b.box.w * b.box.h) > (a.box ? a.box.w * a.box.h : 0) ? b : a), c.members[0]);
    c.photos = [...new Set(c.members.map(m => m.path))];
  }
  return clusters.sort((a, b) => b.photos.length - a.photos.length);
}

// best saved person a descriptor matches (min distance to any of their reference faces), or null
function matchPerson(descriptor, people) {
  if (!window.faceapi || !descriptor) return null;
  let best = null, bestD = Infinity;
  for (const p of people || []) for (const d of (p.descriptors || [])) {
    if (!d || d.length !== 128) continue;
    const dist = window.faceapi.euclideanDistance(descriptor, d);
    if (dist < bestD) { bestD = dist; best = p; }
  }
  return (best && bestD < AUTO_THRESH) ? best : null;
}

// square, padded face crop drawn from a photo's thumbnail
function FaceThumb({ path, box, size = 96 }) {
  const ref = usePR(null);
  usePE(() => {
    const cv = ref.current; if (!cv || !box) return;
    const img = new Image();
    img.onload = () => {
      const W = img.naturalWidth, H = img.naturalHeight, pad = 0.4;
      let bx = (box.x - box.w * pad) * W, by = (box.y - box.h * pad) * H;
      let bw = box.w * (1 + 2 * pad) * W, bh = box.h * (1 + 2 * pad) * H;
      bx = Math.max(0, bx); by = Math.max(0, by);
      const side = Math.max(8, Math.min(Math.min(bw, bh), W - bx, H - by));
      const ctx = cv.getContext("2d");
      ctx.clearRect(0, 0, size, size);
      try { ctx.drawImage(img, bx, by, side, side, 0, 0, size, size); } catch {}
    };
    img.src = "/api/thumb?path=" + encodeURIComponent(path) + "&w=360";
  }, [path, box && box.x, box && box.y]);
  return <canvas ref={ref} width={size} height={size} className="face-thumb" />;
}

function PeopleView({ folder, onClose }) {
  const [phase, setPhase] = usePS("loading");   // loading | idle | scanning | ready | error
  const [unscanned, setUnscanned] = usePS(0);
  const [total, setTotal] = usePS(0);
  const [done, setDone] = usePS(0);
  const [foundFaces, setFoundFaces] = usePS(0);
  const [people, setPeople] = usePS([]);          // clusters
  const [names, setNames] = usePS({});            // clusterId -> in-progress name text (controlled inputs)
  const [facesByPath, setFacesByPath] = usePS({});// path -> [{box, descriptor}] (for per-image assignment)
  const [knownPeople, setKnownPeople] = usePS([]);// all named people (with descriptors) for matching + autocomplete
  const [selected, setSelected] = usePS(null);    // person drill-in
  const [lightbox, setLightbox] = usePS(null);    // photo path open in the overlay
  const [managing, setManaging] = usePS(false);
  const [named, setNamed] = usePS([]);            // all named people (global) for the manage panel
  const [err, setErr] = usePS(null);
  const cancelRef = usePR({ current: false });
  const listRef = usePR([]);

  async function loadAndCluster() {
    const [facesJ, peopleJ] = await Promise.all([
      fetch("/api/faces?path=" + encodeURIComponent(folder.path)).then(r => r.json()),
      fetch("/api/people").then(r => r.json()).catch(() => ({ people: [] })),
    ]);
    await loadFaceApi();
    const allFaces = facesJ.faces || [];
    const byPath = {};
    for (const f of allFaces) (byPath[f.path] = byPath[f.path] || []).push({ box: f.box, descriptor: f.descriptor });
    setFacesByPath(byPath);

    const known = peopleJ.people || [];
    setKnownPeople(known);
    const clusters = clusterFaces(allFaces);
    const toSync = [];
    for (const c of clusters) {
      // 1) authoritative: if members were explicitly assigned, use the majority assigned person
      // (already persisted from that earlier assignment — nothing new to save here)
      const idCount = {}, idName = {};
      for (const m of c.members) if (m.personId) { idCount[m.personId] = (idCount[m.personId] || 0) + 1; idName[m.personId] = m.personName; }
      const topId = Object.keys(idCount).sort((a, b) => idCount[b] - idCount[a])[0];
      if (topId) { c.name = idName[topId]; c.personId = topId; continue; }
      // 2) otherwise, loosely match an already-named person by face similarity. This is a genuinely
      // NEW finding (these photos aren't in that person's record yet) — queue it to persist below.
      // Previously this only saved once the user happened to retype the already-correct name on blur,
      // so a correct auto-match in a fresh scan silently never reached the People screen.
      const m = matchPerson(c.centroid, known);
      if (m) { c.name = m.name; c.personId = m.id; toSync.push(c); }
    }
    clusters.sort((a, b) => (!!b.name - !!a.name) || (b.photos.length - a.photos.length));
    const nm = {}; clusters.forEach(c => { nm[c.id] = c.name || ""; });
    setNames(nm);
    setPeople(clusters);
    setFoundFaces(allFaces.length);
    setPhase("ready");
    if (toSync.length) {
      await Promise.all(toSync.map(c => syncCluster(c, c.name)));
      refreshKnown();
    }
  }

  // push a cluster's faces to the server as belonging to `nm` (creates or merges into an existing
  // person — upsertPerson dedupes photos/descriptors, so this is safe to call even when nothing's new).
  async function syncCluster(c, nm) {
    const faces = c.members.filter(m => m.path && typeof m.index === "number").map(m => ({ path: m.path, index: m.index }));
    if (!nm || !faces.length) return null;
    try {
      const r = await fetch("/api/faces/assign-bulk", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ faces, name: nm }) }).then(r => r.json());
      return r.id || null;
    } catch { return null; }
  }

  usePE(() => {
    let alive = true;
    setPhase("loading"); setSelected(null); setLightbox(null); setManaging(false); setErr(null); cancelRef.current.current = false;
    fetch("/api/faces/list?path=" + encodeURIComponent(folder.path)).then(r => r.json()).then(async j => {
      if (!alive) return;
      const imgs = j.images || [];
      listRef.current = imgs;
      const need = imgs.filter(i => !i.cached);
      setUnscanned(need.length); setTotal(imgs.length);
      if (imgs.length && need.length === 0) await loadAndCluster();
      else setPhase("idle");
    }).catch(e => { if (alive) { setErr(String(e.message || e)); setPhase("error"); } });
    return () => { alive = false; cancelRef.current.current = true; };
  }, [folder.path]);

  async function runScan() {
    setPhase("scanning"); setDone(0); setFoundFaces(0); cancelRef.current.current = false;
    const need = listRef.current.filter(i => !i.cached);
    try {
      await scanImages(need, (d, f) => { setDone(d); setFoundFaces(f); }, cancelRef.current);
      if (cancelRef.current.current) { setPhase("idle"); return; }
      await loadAndCluster();
    } catch (e) { setErr(String(e.message || e)); setPhase("error"); }
  }

  // save a cluster's name (controlled input → POST with the cluster's centroid + photos)
  function refreshKnown() { return fetch("/api/people").then(r => r.json()).then(j => setKnownPeople(j.people || [])).catch(() => {}); }

  // stamps EVERY face in this group with the person (authoritative) — resolves by name, and a later
  // Re-match honors these stamps instead of re-guessing, so corrections stick.
  async function commitClusterName(c) {
    const nm = (names[c.id] || "").trim();
    if (!nm || nm === (c.name || "")) return;   // no edit to save (an auto-match with no user edit is synced separately, see loadAndCluster)
    const id = await syncCluster(c, nm);
    if (!id) return;
    setPeople(prev => prev.map(p => p.id === c.id ? { ...p, name: nm, personId: id } : p));
    refreshKnown();
  }

  // assign a single face (inside a photo) to a person by name (merges into an existing same-named person)
  async function assignFace(face, path, value) {
    const nm = (value || "").trim();
    if (!nm) return;
    try {
      await fetch("/api/people", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: nm, descriptor: face.descriptor, photos: [path], rep: { path, box: face.box } }) });
      await refreshKnown();
    } catch {}
  }

  function openManage() { fetch("/api/people").then(r => r.json()).then(j => setNamed(j.people || [])).catch(() => setNamed([])); setManaging(true); }
  async function renamePerson(id, name) {
    const nm = (name || "").trim(); if (!nm) return;
    await fetch("/api/people/" + id, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: nm }) }).catch(() => {});
    setNamed(prev => prev.map(p => p.id === id ? { ...p, name: nm } : p));
  }
  async function deletePerson(id) {
    if (!window.confirm("Forget this person? Their name is removed from all photos.")) return;
    await fetch("/api/people/" + id, { method: "DELETE" }).catch(() => {});
    setNamed(prev => prev.filter(p => p.id !== id));
  }

  // ===== manage panel (all named people, global) =====
  if (managing) {
    return (
      <div className="col grow" style={{ minHeight: 0 }}>
        <div className="topbar">
          <button className="btn icon" title="Back" onClick={() => setManaging(false)}><Icon name="arrowL" size={16} /></button>
          <div className="crumb grow" style={{ gap: 8 }}><Icon name="brain" size={17} style={{ color: "var(--accent)" }} /><span className="crumb-name">Manage people</span><span className="t-sm ink-3 none">· {named.length}</span></div>
        </div>
        <div className="content" style={{ display: "block", overflow: "auto", padding: 20 }}>
          {!named.length ? (
            <div className="ink-3" style={{ padding: 16 }}>No people named yet. Scan a folder and name the faces you find.</div>
          ) : (
            <div className="col" style={{ gap: 8, maxWidth: 560 }}>
              {named.map(p => (
                <div key={p.id} className="manage-person">
                  {p.rep && p.rep.path ? <FaceThumb path={p.rep.path} box={p.rep.box} size={40} />
                    : <div className="face-thumb" style={{ width: 40, height: 40, display: "grid", placeItems: "center" }}><Icon name="image" size={16} style={{ color: "var(--ink-4)" }} /></div>}
                  <input className="person-name-input" defaultValue={p.name}
                    onBlur={e => renamePerson(p.id, e.target.value)} onKeyDown={e => { if (e.key === "Enter") e.target.blur(); }} />
                  <span className="ink-3 t-xs" style={{ flex: "none" }}>{p.count} photo{p.count === 1 ? "" : "s"}</span>
                  <button className="btn icon sm ghost" title="Forget" style={{ color: "var(--warn)" }} onClick={() => deletePerson(p.id)}><Icon name="x" size={13} /></button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ===== person drill-in (their photos) =====
  if (selected) {
    return (
      <div className="col grow" style={{ minHeight: 0 }}>
        <div className="topbar">
          <button className="btn icon" title="Back to people" onClick={() => setSelected(null)}><Icon name="arrowL" size={16} /></button>
          <div className="crumb grow" style={{ gap: 8 }}><Icon name="image" size={17} style={{ color: "var(--accent)" }} /><span className="crumb-name">{selected.name || "Person"}</span><span className="t-sm ink-3 none">· {selected.photos.length} photo{selected.photos.length === 1 ? "" : "s"}</span></div>
        </div>
        <div className="content" style={{ display: "block", overflow: "auto", padding: 16 }}>
          <div className="people-photos">
            {selected.photos.map(p => (
              <button key={p} className="people-photo" title={p.split("/").pop()} onClick={() => setLightbox(p)}>
                <img src={"/api/thumb?path=" + encodeURIComponent(p) + "&w=300"} loading="lazy" alt="" />
              </button>
            ))}
          </div>
        </div>
        {lightbox && <Lightbox path={lightbox} people={knownPeople} onChanged={refreshKnown} onClose={() => setLightbox(null)} />}
      </div>
    );
  }

  // ===== main: people grid =====
  return (
    <div className="col grow" style={{ minHeight: 0 }}>
      <div className="topbar">
        <button className="btn icon" title="Back to gallery" onClick={onClose}><Icon name="arrowL" size={16} /></button>
        <div className="crumb grow" style={{ gap: 8 }}>
          <Icon name="brain" size={17} style={{ color: "var(--accent)" }} />
          <span className="crumb-name">People · {folder.name}</span>
          {phase === "ready" && <span className="t-sm ink-3 none">· {people.length} {people.length === 1 ? "person" : "people"} · {foundFaces} faces</span>}
        </div>
        {phase === "ready" && <button className="btn sm" title="Re-group and re-apply names from your latest assignments" onClick={loadAndCluster}><Icon name="refresh" size={14} /> Re-match</button>}
        <button className="btn sm" title="See and edit every named person" onClick={openManage}><Icon name="sliders" size={14} /> Manage</button>
        {phase === "ready" && unscanned > 0 && <button className="btn sm" onClick={runScan}><Icon name="search" size={14} /> Scan {unscanned} new</button>}
      </div>

      <div className="content" style={{ display: "block", overflow: "auto", padding: 20 }}>
        {phase === "error" ? (
          <div className="callout warn"><Icon name="alert" size={15} /><span>{err}</span></div>
        ) : phase === "loading" ? (
          <div className="col center" style={{ padding: 40, gap: 12, color: "var(--ink-3)" }}><span className="spin-mini" /><span className="t-sm">Loading…</span></div>
        ) : phase === "idle" ? (
          <div className="col center" style={{ padding: "48px 0", gap: 14, textAlign: "center" }}>
            <Icon name="brain" size={34} style={{ color: "var(--accent)", opacity: .5 }} />
            <div className="x-bold" style={{ fontSize: 16 }}>Find people in your photos</div>
            <div className="ink-3 t-sm" style={{ maxWidth: 360 }}>Heap Chat will scan <b>{total}</b> photo{total === 1 ? "" : "s"} in <b>{folder.name}</b>, group the faces, and let you name and browse people. Runs entirely on your device.</div>
            <button className="btn primary" style={{ marginTop: 4 }} disabled={!total} onClick={runScan}><Icon name="sparkles" size={15} /> Scan for faces</button>
          </div>
        ) : phase === "scanning" ? (
          <div className="col center" style={{ padding: "44px 0", gap: 14, maxWidth: 420, margin: "0 auto" }}>
            <div className="x-bold" style={{ fontSize: 15 }}>Scanning for faces…</div>
            <div className="setup-bar" style={{ width: "100%" }}><div className="setup-bar-fill" style={{ width: (total ? Math.round(done / total * 100) : 0) + "%" }} /></div>
            <div className="ink-3 t-sm">{done} / {total} photos · {foundFaces} faces found</div>
            <button className="btn sm" onClick={() => { cancelRef.current.current = true; }}>Stop</button>
          </div>
        ) : !people.length ? (
          <div className="col center" style={{ padding: "48px 0", gap: 12, textAlign: "center" }}>
            <Icon name="brain" size={32} style={{ color: "var(--ink-4)", opacity: .4 }} />
            <div className="x-bold" style={{ fontSize: 15 }}>No faces found</div>
            <div className="ink-3 t-sm" style={{ maxWidth: 320 }}>Heap Chat didn't detect any faces in these photos.</div>
          </div>
        ) : (
          <>
            <datalist id="people-names">{[...new Set(knownPeople.map(p => p.name).filter(Boolean))].map(n => <option key={n} value={n} />)}</datalist>
            <div className="t-xs ink-3" style={{ marginBottom: 12 }}>Tip: to merge two groups of the same person, give them the <b>same name</b> (start typing to pick an existing one).</div>
            <div className="people-grid">
              {people.map((c, i) => (
                <div key={c.id} className="person-card">
                  <div className="person-face" title="See this person's photos" onClick={() => setSelected({ ...c, name: names[c.id] || c.name || `Person ${i + 1}` })}>
                    <FaceThumb path={c.rep.path} box={c.rep.box} size={104} />
                  </div>
                  <input className="person-name-input" value={names[c.id] || ""} placeholder={`Person ${i + 1}`} title="Name this person" list="people-names"
                    onChange={e => setNames(prev => ({ ...prev, [c.id]: e.target.value }))}
                    onBlur={() => commitClusterName(c)}
                    onKeyDown={e => { if (e.key === "Enter") e.target.blur(); if (e.key === "Escape") { setNames(prev => ({ ...prev, [c.id]: c.name || "" })); e.target.blur(); } }} />
                  <span className="person-count">{c.photos.length} photo{c.photos.length === 1 ? "" : "s"}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
      {lightbox && <Lightbox path={lightbox} people={knownPeople} onChanged={refreshKnown} onClose={() => setLightbox(null)} />}
    </div>
  );
}

// Self-contained per-photo face panel: loads the photo's own faces, shows the stored assignment
// authoritatively (falling back to an auto-suggestion), persists overrides per face, and can
// re-detect just this photo on demand. Reused by the People lightbox and the gallery focus view.
// Pass `people` to skip the known-people fetch (lightbox already has it); otherwise it loads its own.
function PhotoFacesPanel({ path, people, onChanged, idSuffix = "" }) {
  const [faces, setFaces] = usePS(null);   // null = loading
  const [scanned, setScanned] = usePS(true);
  const [rescanning, setRescanning] = usePS(false);
  const [scanErr, setScanErr] = usePS(null);
  const [known, setKnown] = usePS(people || []);
  const mtimeRef = usePR(0);
  const autoSyncedRef = usePR(new Set());   // face indices already auto-persisted, so we don't re-POST every render
  usePE(() => {
    autoSyncedRef.current = new Set();
    if (!path) { console.warn("[faces] PhotoFacesPanel rendered without a path"); setFaces([]); setScanned(true); return; }
    setFaces(null);
    fetch("/api/faces/one?path=" + encodeURIComponent(path))
      .then(r => r.json())
      .then(j => { setFaces(j.faces || []); setScanned(!!j.scanned); mtimeRef.current = j.mtime || 0; })
      .catch(() => { setFaces([]); setScanned(false); });
  }, [path]);
  // fetch known people for autocomplete + auto-match only when not supplied by the caller
  usePE(() => {
    if (people) { setKnown(people); return; }
    fetch("/api/people").then(r => r.json()).then(j => setKnown(j.people || [])).catch(() => {});
  }, [people]);
  const listId = "faces-names" + idSuffix;
  const allNames = [...new Set((known || []).map(p => p.name).filter(Boolean))];
  async function assign(face, value) {
    await fetch("/api/faces/assign", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, index: face.index, name: (value || "").trim() }) }).catch(() => {});
    onChanged && onChanged();
  }
  // a rescan (or a fresh known-people list) can correctly auto-match a face to someone already named —
  // that match is shown as a pre-filled name, but previously only got SAVED if the user happened to
  // retype the already-correct text on blur. Persist genuine matches immediately instead, same fix as
  // the folder-level scan grid (loadAndCluster/syncCluster above).
  usePE(() => {
    if (!faces || !faces.length || !known || !known.length) return;
    for (const f of faces) {
      if (f.personId || autoSyncedRef.current.has(f.index)) continue;
      const m = matchPerson(f.descriptor, known);
      if (m) { autoSyncedRef.current.add(f.index); assign(f, m.name); }
    }
  }, [faces, known]);
  // re-detect THIS photo on demand (uses the current, higher-recall settings) so a missed face can be recovered here
  async function rescan() {
    setRescanning(true); setScanErr(null);
    try {
      const faceapi = await loadFaceApi();
      const payload = await detectFaces(faceapi, path);
      const r = await fetch("/api/faces", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, mtime: mtimeRef.current, faces: payload }) });
      if (!r.ok) throw new Error("Couldn't save faces (" + r.status + ")");
      autoSyncedRef.current = new Set();   // fresh detection reuses index 0..N-1 — don't treat them as already-synced
      setFaces(payload.map((f, i) => ({ index: i, box: f.box, descriptor: f.descriptor, personId: null, name: null })));
      setScanned(true);
      onChanged && onChanged();
    } catch (e) {
      console.error("[faces] scan failed for", path, e);
      setScanErr(e && e.message ? e.message : "Scan failed — see console for details.");
    }
    setRescanning(false);
  }
  return (
    <div className="lb-faces">
      <datalist id={listId}>{allNames.map(n => <option key={n} value={n} />)}</datalist>
      <div className="row gap-2" style={{ marginBottom: 8, alignItems: "center", justifyContent: "space-between" }}>
        <span className="t-sm semi">
          {faces === null ? "Loading faces…"
            : faces.length ? `${faces.length} face${faces.length === 1 ? "" : "s"} in this photo`
            : rescanning ? "Scanning this photo…"
            : scanned ? "No faces detected in this photo"
            : "This photo hasn't been scanned for faces yet"}
        </span>
        {faces !== null && path && (
          <button className="btn sm" disabled={rescanning} title="Re-detect faces in just this photo" onClick={rescan}>
            <Icon name={rescanning ? "clock" : "search"} size={13} /> {scanned && faces.length ? "Re-scan" : "Scan this photo"}
          </button>
        )}
      </div>
      {scanErr && <div className="callout warn" style={{ marginBottom: 8 }}><Icon name="alert" size={14} /><span className="t-sm">{scanErr}</span></div>}
      <div className="lb-face-row">
        {(faces || []).map((f) => {
          const prefill = f.name || (matchPerson(f.descriptor, known) || {}).name || "";   // stored assignment wins
          return (
            <div key={f.index} className="lb-face">
              <FaceThumb path={path} box={f.box} size={64} />
              <input className="person-name-input" placeholder="Name…" list={listId} style={{ fontSize: 12 }}
                defaultValue={prefill}
                onBlur={e => { if (e.target.value.trim() !== prefill) assign(f, e.target.value); }} onKeyDown={e => { if (e.key === "Enter") e.target.blur(); }} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// full-photo overlay with per-image face assignment (used inside the People view).
function Lightbox({ path, people = [], onChanged, onClose }) {
  usePE(() => { const onKey = e => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, []);
  return (
    <div className="lb-overlay" onClick={onClose}>
      <div className="lb-box" onClick={e => e.stopPropagation()}>
        <button className="lb-close" onClick={onClose}><Icon name="x" size={18} /></button>
        <img className="lb-photo" src={fileUrl(path)} alt="" />
        <PhotoFacesPanel path={path} people={people} onChanged={onChanged} idSuffix="-lb" />
      </div>
    </div>
  );
}

// a few diverse member descriptors of a cluster (so a person learns several looks, not just the mean)
function sampleDescriptors(members, n = 6) {
  if (!members || !members.length) return [];
  if (members.length <= n) return members.map(m => m.descriptor);
  const out = [], step = members.length / n;
  for (let i = 0; i < n; i++) out.push(members[Math.floor(i * step)].descriptor);
  return out;
}

// global People destination — all named people across every folder, reachable from the sidebar
// without opening a folder first. Lets you browse, rename, forget, and scan any folder for new faces.
function GlobalPeopleView({ onPickFolder, onClose }) {
  const [people, setPeople] = usePS(null);
  const [selected, setSelected] = usePS(null);   // { id, name, photos }
  const [lightbox, setLightbox] = usePS(null);

  function reload() { fetch("/api/people").then(r => r.json()).then(j => setPeople(j.people || [])).catch(() => setPeople([])); }
  usePE(() => { reload(); }, []);

  async function rename(id, name) {
    const nm = (name || "").trim(); if (!nm) return;
    await fetch("/api/people/" + id, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: nm }) }).catch(() => {});
    setPeople(prev => prev.map(p => p.id === id ? { ...p, name: nm } : p));
  }
  async function del(id, e) {
    e.stopPropagation();
    if (!window.confirm("Forget this person? Their name is removed from all photos.")) return;
    await fetch("/api/people/" + id, { method: "DELETE" }).catch(() => {});
    setPeople(prev => prev.filter(p => p.id !== id));
  }
  async function openPerson(p) { const full = await fetch("/api/people/" + p.id).then(r => r.json()).catch(() => null); if (full) setSelected(full); }

  if (selected) {
    return (
      <div className="col grow" style={{ minHeight: 0 }}>
        <div className="topbar">
          <button className="btn icon" title="Back to people" onClick={() => setSelected(null)}><Icon name="arrowL" size={16} /></button>
          <div className="crumb grow" style={{ gap: 8 }}><Icon name="image" size={17} style={{ color: "var(--accent)" }} /><span className="crumb-name">{selected.name}</span><span className="t-sm ink-3 none">· {selected.photos.length} photo{selected.photos.length === 1 ? "" : "s"}</span></div>
        </div>
        <div className="content" style={{ display: "block", overflow: "auto", padding: 16 }}>
          {!selected.photos.length ? <div className="ink-3" style={{ padding: 16 }}>No accessible photos.</div> : (
            <div className="people-photos">
              {selected.photos.map(p => (
                <button key={p} className="people-photo" onClick={() => setLightbox(p)}><img src={"/api/thumb?path=" + encodeURIComponent(p) + "&w=300"} loading="lazy" alt="" /></button>
              ))}
            </div>
          )}
        </div>
        {lightbox && <Lightbox path={lightbox} people={people || []} onChanged={reload} onClose={() => setLightbox(null)} />}
      </div>
    );
  }

  return (
    <div className="col grow" style={{ minHeight: 0 }}>
      <div className="topbar">
        <button className="btn icon" title="Close" onClick={onClose}><Icon name="arrowL" size={16} /></button>
        <div className="crumb grow" style={{ gap: 8 }}><Icon name="brain" size={18} style={{ color: "var(--accent)" }} /><span className="crumb-name">People</span>{people && <span className="t-sm ink-3 none">· {people.length}</span>}</div>
        <button className="btn sm primary" onClick={onPickFolder}><Icon name="search" size={14} /> Scan a folder</button>
      </div>
      <div className="content" style={{ display: "block", overflow: "auto", padding: 24 }}>
        {people === null ? (
          <div className="col center" style={{ padding: 40, gap: 12, color: "var(--ink-3)" }}><span className="spin-mini" /><span className="t-sm">Loading…</span></div>
        ) : !people.length ? (
          <div className="col center" style={{ padding: "48px 0", gap: 14, textAlign: "center" }}>
            <Icon name="brain" size={34} style={{ color: "var(--accent)", opacity: .5 }} />
            <div className="x-bold" style={{ fontSize: 16 }}>No people yet</div>
            <div className="ink-3 t-sm" style={{ maxWidth: 340 }}>Scan a folder of photos to detect faces, then name the people you find — they'll show up here.</div>
            <button className="btn primary" style={{ marginTop: 4 }} onClick={onPickFolder}><Icon name="search" size={15} /> Scan a folder</button>
          </div>
        ) : (
          <>
            <div className="ink-3 t-sm" style={{ marginBottom: 20, maxWidth: 540 }}>
              Faces are detected on-device. Name a person to group their photos.
            </div>
            <div className="faces">
              {people.map(p => (
                <div key={p.id} className="face2">
                  <button className="face2-img" title="See photos" onClick={() => openPerson(p)}>
                    {p.rep && p.rep.path
                      ? <FaceThumb path={p.rep.path} box={p.rep.box} size={88} />
                      : p.photo
                        ? <img style={{ width: "100%", height: "100%", objectFit: "cover" }} src={"/api/thumb?path=" + encodeURIComponent(p.photo) + "&w=200"} alt="" />
                        : <Icon name="image" size={26} style={{ color: "var(--ink-4)" }} />}
                    <span className="face2-count">{p.count}</span>
                  </button>
                  <input className="face2-input" defaultValue={p.name} placeholder="Add a name"
                    onBlur={e => rename(p.id, e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") e.target.blur(); }} />
                  <button className="btn icon xs ghost" title="Forget" style={{ color: "var(--warn)" }} onClick={e => del(p.id, e)}>
                    <Icon name="x" size={12} />
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export { PeopleView, GlobalPeopleView, Lightbox, PhotoFacesPanel };
