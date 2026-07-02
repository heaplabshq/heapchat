/* ============================================================
   Perceptual image hashing (visual similarity for "related" + duplicate finder).
   64-bit dHash cached by mtime in the shared phash sidecar. Also hosts the
   text/embedding "related files" logic (images use pixel similarity; docs use
   index-centroid cosine).
   ============================================================ */
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const exifr = require("exifr");
const { Jimp } = require("jimp");
const { phashStore, persistPhash } = require("../state/sidecars");
const { isImageFile } = require("../util/files");
const { mapLimit } = require("../util/concurrency");
const { loadIndex, buildIndex } = require("../rag/index");
const { cosine } = require("../rag/retrieve");

// 64-bit difference hash (dHash): downscale to 9×8 grayscale, compare adjacent pixels per row
async function computeDHash(p) {
  let img;
  try { const thumb = await exifr.thumbnail(p); if (thumb) img = await Jimp.read(Buffer.from(thumb)); } catch {}   // fast path: embedded JPEG thumbnail
  if (!img) img = await Jimp.read(p);
  img.resize({ w: 9, h: 8 }).greyscale();
  const d = img.bitmap.data, W = 9; let bits = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const left = d[(y * W + x) * 4], right = d[(y * W + x + 1) * 4];
    bits = (bits << 1n) | (left > right ? 1n : 0n);
  }
  return bits.toString(16).padStart(16, "0");
}
// cached by mtime — only ever decodes an image once
async function getPhash(p) {
  let st; try { st = fs.statSync(p); } catch { return null; }
  const c = phashStore[p];
  if (c && c.m === st.mtimeMs) return c.h;
  try { const h = await computeDHash(p); phashStore[p] = { m: st.mtimeMs, h }; persistPhash(); return h; }
  catch { return null; }
}
function hammingHex(a, b) { let x = BigInt("0x" + a) ^ BigInt("0x" + b), c = 0; while (x) { c += Number(x & 1n); x >>= 1n; } return c; }
// pre-compute hashes for a folder's images in the background, so the first "related" is instant.
// cached by mtime → only ever decodes each image once; a per-folder guard prevents pile-ups.
const warmingDirs = new Set();
function warmPhashes(imagePaths) {
  if (!imagePaths.length) return;
  const key = path.dirname(imagePaths[0]);
  if (warmingDirs.has(key)) return;
  warmingDirs.add(key);
  mapLimit(imagePaths, 3, async op => { try { await getPhash(op); } catch {} })
    .catch(() => {}).finally(() => warmingDirs.delete(key));
}
// visually-similar sibling images (same folder), by perceptual-hash distance.
// Calibrated on ~2.8k real hashes: genuine matches sit at ≤23, the "different" mode ramps up from 24
// (centered at the random baseline ~32), and 90% of true nearest-neighbors fall within 22.
const DHASH_MAX = 23;
async function relatedImages(p) {
  const selfHash = await getPhash(p);
  if (!selfHash) return [];
  const dir = path.dirname(p);
  let names = []; try { names = await fsp.readdir(dir); } catch { return []; }
  const others = names.map(n => path.join(dir, n)).filter(op => op !== p && isImageFile(op) && (() => { try { return fs.statSync(op).isFile(); } catch { return false; } })());
  const hashes = await mapLimit(others, 4, async op => ({ path: op, name: path.basename(op), h: await getPhash(op) }));
  const ranked = hashes.filter(o => o.h).map(o => ({ name: o.name, path: o.path, dist: hammingHex(selfHash, o.h) })).sort((a, b) => a.dist - b.dist);
  console.log(`[related] ${path.basename(p)} nearest:`, ranked.slice(0, 6).map(r => `${r.name.slice(0, 20)}:${r.dist}`).join("  "));
  return ranked.filter(r => r.dist <= DHASH_MAX).slice(0, 6).map(r => ({ name: r.name, path: r.path, score: +((64 - r.dist) / 64).toFixed(3) }));
}

// related files: images → visual (pixel) similarity; docs → index-centroid cosine
async function relatedFor(p, kbDir) {
  if (isImageFile(p)) return await relatedImages(p);   // images → visual (pixel) similarity, not text descriptions
  let idx = null;
  for (const k of [kbDir, path.dirname(p)].filter(Boolean)) { const ix = loadIndex(k); if (ix && ix.files[p]) { idx = ix; break; } }
  if (!idx) { try { await buildIndex(path.dirname(p)); idx = loadIndex(path.dirname(p)); } catch {} }
  const self = idx && idx.files[p];
  if (!self || !self.chunks.length) return [];
  // compare whole-file meaning (centroid ↔ centroid). avg-vs-best-chunk over-scored files that merely
  // shared one stray paragraph / a generic image description, which is what surfaced unrelated items.
  const centroid = chunks => { const d = chunks[0].vec.length, c = new Array(d).fill(0); for (const ch of chunks) for (let i = 0; i < d; i++) c[i] += ch.vec[i]; for (let i = 0; i < d; i++) c[i] /= chunks.length; return c; };
  const selfC = centroid(self.chunks);
  const selfImg = isImageFile(p);
  const scored = [];
  for (const [op, of_] of Object.entries(idx.files)) {
    if (op === p || !of_.chunks.length) continue;
    if (selfImg !== isImageFile(op)) continue;         // only relate like-to-like (image↔image, doc↔doc)
    scored.push({ name: of_.name, path: op, score: +cosine(selfC, centroid(of_.chunks)).toFixed(3) });
  }
  if (!scored.length) return [];
  scored.sort((a, b) => b.score - a.score);
  // strict gate — show only items that BOTH clear an absolute floor AND clearly stand out from the
  // background (mean + 1σ). If nothing qualifies, show nothing rather than padding with weak matches.
  const vals = scored.map(s => s.score);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const std = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
  const floor = selfImg ? 0.66 : 0.52;
  const cutoff = Math.max(floor, mean + 1.0 * std);
  return scored.filter(s => s.score >= cutoff).slice(0, 6);
}

const DUP_EXACT = 2;             // ≤2 bits apart → same image (copy / re-save / resize)
const DUP_NEAR = 10;             // ≤10 bits → near-duplicate (burst, crop, light edit); well inside DHASH_MAX

module.exports = { computeDHash, getPhash, hammingHex, warmPhashes, relatedImages, relatedFor, DHASH_MAX, DUP_EXACT, DUP_NEAR };
