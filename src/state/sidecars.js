/* ============================================================
   Path-keyed sidecar stores — shared across all users because they describe
   disk files everyone can see (vision descriptions, tags, perceptual hashes,
   GPS, face descriptors, doc entities, reverse-geocode names, PDF OCR text).

   Each store is a plain object loaded once from data/<name>.json and mutated
   in place; mutations are visible to every importer (objects are shared by
   reference). Writes are debounced and atomic. Exact per-store debounce delays
   and error-logging behavior are preserved from the original server.js.
   ============================================================ */
const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("../config");
const { writeJSONAtomic } = require("../util/json-store");

function loadJSON(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; } }
// debounced, atomic persist of `getData()` to `file`. `label` set → log errors; otherwise swallow them.
function debouncedPersist(file, getData, delay, label) {
  let timer = null;
  return function persist() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try { writeJSONAtomic(file, getData()); }
      catch (e) { if (label) console.error(label + " persist:", e.message); }
    }, delay);
  };
}

/* image vision captions: data/imagemeta.json — { [path]: { context, description, text, mtime } } */
const IMG_META_FILE = path.join(DATA_DIR, "imagemeta.json");
const imageMeta = loadJSON(IMG_META_FILE);
const persistImageMeta = debouncedPersist(IMG_META_FILE, () => imageMeta, 150, "imagemeta");

/* tags sidecar: data/tags.json — { [path]: [tag, …] } */
const TAGS_FILE = path.join(DATA_DIR, "tags.json");
const tagStore = loadJSON(TAGS_FILE);
const persistTags = debouncedPersist(TAGS_FILE, () => tagStore, 150, "tags");
function getTags(p) { return tagStore[p] || []; }
function setTags(p, tags) {
  const clean = [...new Set((tags || []).map(t => String(t).trim()).filter(Boolean))];
  if (clean.length) tagStore[p] = clean; else delete tagStore[p];
  persistTags();
  return clean;
}

/* OCR'd PDF text cached by mtime: data/pdfocr.json */
const PDFOCR_FILE = path.join(DATA_DIR, "pdfocr.json");
const pdfOcrStore = loadJSON(PDFOCR_FILE);
const persistPdfOcr = debouncedPersist(PDFOCR_FILE, () => pdfOcrStore, 250);

/* perceptual hashes: data/phash.json */
const PHASH_FILE = path.join(DATA_DIR, "phash.json");
const phashStore = loadJSON(PHASH_FILE);
const persistPhash = debouncedPersist(PHASH_FILE, () => phashStore, 200);

/* EXIF GPS cache: data/geo.json */
const GEO_FILE = path.join(DATA_DIR, "geo.json");
const geoStore = loadJSON(GEO_FILE);
const persistGeo = debouncedPersist(GEO_FILE, () => geoStore, 300);

/* face descriptors by path+mtime: data/faces.json */
const FACES_FILE = path.join(DATA_DIR, "faces.json");
const faceStore = loadJSON(FACES_FILE);
const persistFaces = debouncedPersist(FACES_FILE, () => faceStore, 400);

/* per-doc entities cache by mtime: data/entities.json */
const ENTITIES_FILE = path.join(DATA_DIR, "entities.json");
const entityStore = loadJSON(ENTITIES_FILE);
const persistEntities = debouncedPersist(ENTITIES_FILE, () => entityStore, 400);

/* reverse-geocode cache (grid-key "lat,lng" -> "City, CC"): data/placenames.json */
const PLACENAMES_FILE = path.join(DATA_DIR, "placenames.json");
const placeNames = loadJSON(PLACENAMES_FILE);
const persistPlaceNames = debouncedPersist(PLACENAMES_FILE, () => placeNames, 400);

module.exports = {
  IMG_META_FILE, imageMeta, persistImageMeta,
  TAGS_FILE, tagStore, persistTags, getTags, setTags,
  PDFOCR_FILE, pdfOcrStore, persistPdfOcr,
  PHASH_FILE, phashStore, persistPhash,
  GEO_FILE, geoStore, persistGeo,
  FACES_FILE, faceStore, persistFaces,
  ENTITIES_FILE, entityStore, persistEntities,
  PLACENAMES_FILE, placeNames, persistPlaceNames,
};
