/* ============================================================
   Photo metadata helpers — EXIF GPS (map view) and faces/people.
   GPS is cached per path+mtime in the shared geo sidecar. Faces are detected
   client-side (face-api.js) and cached in the faces sidecar; a named person is a
   label + a gallery of descriptor centroids stored per-user in people.json, and
   naming also tags the photos so they're searchable by the person's name.
   ============================================================ */
const fs = require("fs");
const exifr = require("exifr");
const { geoStore, persistGeo, tagStore, persistTags } = require("../state/sidecars");
const { storesFor } = require("../state/user-stores");

const FACE_SCAN_VERSION = 4;   // bump to invalidate cached descriptors (e.g. when detection quality changes)

// GPS from EXIF, cached per path+mtime so we don't re-parse every visit.
async function geoFor(p) {
  let st; try { st = fs.statSync(p); } catch { return null; }
  const cached = geoStore[p];
  if (cached && cached.mtime === st.mtimeMs) return cached.gps;   // gps is {lat,lng,taken} or null (cached "no GPS")
  let gps = null;
  try {
    const x = await exifr.parse(p, { gps: true });
    if (x && typeof x.latitude === "number" && typeof x.longitude === "number")
      gps = { lat: x.latitude, lng: x.longitude, taken: (x.DateTimeOriginal || x.CreateDate) ? +new Date(x.DateTimeOriginal || x.CreateDate) : null };
  } catch {}
  geoStore[p] = { mtime: st.mtimeMs, gps }; persistGeo();
  return gps;
}

// euclidean distance between two face descriptors
function faceDist(a, b) { let s = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) { const d = a[i] - b[i]; s += d * d; } return Math.sqrt(s); }
function tagPhotos(paths, name, add) {
  for (const p of paths) {
    const cur = new Set(tagStore[p] || []);
    if (add) cur.add(name); else cur.delete(name);
    if (cur.size) tagStore[p] = [...cur]; else delete tagStore[p];
  }
  persistTags();
}
// a person carries SEVERAL reference descriptors (a face gallery) so two groups of the same person
// can merge and varied angles all match. (legacy records had a single `centroid`.)
function personDescs(p) { return (p && (p.descriptors || (Array.isArray(p.centroid) ? [p.centroid] : []))) || []; }
// upsert a person, returning the id. Accepts one descriptor or many (for a whole cluster).
// By id, else MERGED into an existing person of the same name, else a new person.
function upsertPerson(user, { id, name, descriptors, photos, rep }) {
  const st = storesFor(user);
  const nm = String(name || "").trim().slice(0, 60);
  const valid = (Array.isArray(descriptors) ? descriptors : []).filter(d => Array.isArray(d) && d.length === 128);
  if (!nm || !valid.length) return null;
  let pid = id && st.people[id] ? id : Object.keys(st.people).find(k => (st.people[k].name || "").toLowerCase() === nm.toLowerCase());
  if (!pid) pid = "pp" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const prev = st.people[pid];
  if (prev && prev.name && prev.name !== nm && prev.photos) tagPhotos(prev.photos, prev.name, false);
  const descs = prev ? personDescs(prev).slice() : [];
  for (const d of valid) if (!descs.some(x => faceDist(x, d) < 0.35)) descs.push(d.map(Number));   // skip near-dupes
  const paths = [...new Set([...(prev && prev.photos || []), ...(Array.isArray(photos) ? photos.map(String) : [])])];
  const repObj = (prev && prev.rep) || (rep && rep.path ? { path: String(rep.path), box: rep.box || null } : null);
  st.people[pid] = { name: nm, descriptors: descs.slice(-60), photos: paths, rep: repObj, updatedAt: Date.now() };
  st.save("people.json");
  tagPhotos(paths, nm, true);
  return pid;
}

module.exports = { FACE_SCAN_VERSION, geoFor, faceDist, tagPhotos, personDescs, upsertPerson };
