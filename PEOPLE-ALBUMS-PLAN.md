# People Albums — Design & Implementation Plan (Phase 2 of Photos)

> Status: **implemented.** Phase 1 (Photo Map) and Phase 2 (People) are both done —
> see `public/js/people.jsx`, `public/vendor/faceapi/`, and the `/api/faces*` /
> `/api/people*` routes in `server.js`.
> Goal: cluster faces across the user's photos into **people**, let the user **name** them,
> then **browse/search** "photos of Sarah" — fully local, no cloud.

## TL;DR architecture decision

**No separate server. No Python. No native modules.**

The face-recognition model runs **in the renderer/browser** (Electron gives it GPU/WebGL).
The existing Express server only **stores results** in JSON sidecars — same shape as the
existing `geoStore` / `phashStore`. Packaging is unaffected; the app just grows by ~7 MB of
vendored model weights.

```
[renderer / browser]                          [existing Express server]
  face-api.js + vendored models   ──store──▶   facesStore   (path → {mtime, faces:[{descriptor[128], box}]})
  detect faces + 128-d descriptors             peopleStore  (clusterId → {name, centroid})
  cluster (L2 distance < ~0.6)      ◀─fetch──   GET/POST /api/faces, GET/PUT /api/people
  "People" grid + face-crop thumbnails
```

## The pipeline

1. **Detect** faces in each photo (bounding boxes).
2. **Embed** each face → a 128-number descriptor (same person ⇒ vectors close together).
3. **Cluster** descriptors into people (greedy/agglomerative, L2 distance threshold ~0.6).
4. **Name** clusters (user labels once) and persist.
5. **Browse/search** — a "People" view; "show photos of <name>".

Steps 1–2 are the ML; the rest is plain JS + storage.

## Tech choice: face-api.js (TensorFlow.js)

- Pure JavaScript, runs in the renderer via Chromium WebGL (works in Electron and a plain browser).
- **Vendor like Leaflet**: `public/vendor/faceapi/face-api.min.js` (~150 KB) + model weights into
  `public/vendor/faceapi/models/` (~6–7 MB). Loaded at runtime; fully offline.
- Models to vendor (face-api.js weight files):
  - `tiny_face_detector` (fast) **or** `ssd_mobilenetv1` (more accurate) — pick one; start with tiny.
  - `face_landmark_68` (alignment).
  - `face_recognition` (the 128-d descriptor).

### Alternatives rejected
- **`@tensorflow/tfjs-node` (server-side)** — native module; must match Electron's Node ABI
  (electron-rebuild pain) and bloats the bundle. Avoid.
- **Python microservice (dlib / InsightFace)** — best accuracy, but means bundling a Python
  runtime + native libs and running a 2nd process. Overkill for a local personal-photo app.
- **Ollama vision model** — can describe "a person" but cannot produce stable re-identification
  embeddings for clustering. Not suitable.

## Data model (new sidecars, mirror `geoStore`/`phashStore`)

`data/faces.json` — per-image cache (so each photo is processed once, re-scanned on mtime change):
```jsonc
{
  "/abs/path/photo.jpg": {
    "mtime": 1718000000000,
    "faces": [
      { "descriptor": [/* 128 floats */], "box": { "x": 0.31, "y": 0.18, "w": 0.12, "h": 0.16 } }
    ]
  }
}
```
> Store box as **fractions** of width/height so face-crop thumbnails work at any thumb size.

`data/people.json` — named clusters (per user; lives under the user's dir like chats/memory):
```jsonc
{
  "p_ab12": { "name": "Sarah", "centroid": [/* 128 floats, running mean */], "count": 42 }
}
```
> Naming attaches to a **centroid**, so newly-scanned faces can auto-match an existing person by
> nearest-centroid (< threshold) without re-clustering everything.

## Server endpoints (thin — storage only)

- `GET  /api/faces?path=<folder>` → cached descriptors for all images under a folder (for clustering on the client).
- `POST /api/faces` `{ path, mtime, faces }` → save descriptors the renderer computed for one image.
- `GET  /api/people` → named people (`peopleStore`).
- `PUT  /api/people/:id` `{ name }` → name/rename a cluster (creates the person from a cluster's centroid).
- `DELETE /api/people/:id` → forget a person.
- (optional) `POST /api/people/:id/assign` `{ path, faceIndex }` and `/unassign` → manual corrections ("not this person").

All guarded by `guardPath` / the auth wall, like existing routes.

## Client pieces

- **Vendor + load** face-api.js once (lazy: only when the People view opens). Add `<script>` for the lib;
  fetch models from `/vendor/faceapi/models`.
- **Scanner** (`public/js/people.jsx`): iterate images (use **thumbnails** via `/api/thumb?w=...`, not full-res,
  for speed), run `detectAllFaces(img).withFaceLandmarks().withFaceDescriptors()`, POST each result to
  `/api/faces`. Show a **progress bar** ("Scanning 312 / 1,204 photos…"); cancellable; resumable
  (skip images already cached with matching mtime).
- **Clustering** (JS, client or server): greedy agglomerative — for each face, attach to the nearest
  existing cluster centroid if L2 < `THRESH` (~0.6), else start a new cluster. Merge tiny clusters.
- **People view**: grid of people. Each tile = a **face-crop thumbnail** (draw the box region onto a
  canvas from the photo/thumb) + name (or "Add name"). Click a person → all their photos (reuse the gallery grid).
- **Naming flow**: inline rename on a tile → `PUT /api/people/:id`. Corrections: "not this person" removes a
  face from a cluster.
- **Search hook**: let "photos of <name>" in the agent / gallery search resolve to a person's photos
  (optional, later).

## Implementation stages (build + verify each)

1. **Scan & store** — vendor face-api.js + models; build the scanner with progress; cache descriptors
   in `faces.json` via `/api/faces`. (No UI beyond progress.) Verify descriptors persist + skip-on-mtime works.
2. **Cluster & display** — cluster cached descriptors; render the People grid with face-crop thumbnails;
   click-through to a person's photos. (Clusters unnamed = "Person 1, 2, …".)
3. **Name & search** — naming/rename + persistence to `people.json`; nearest-centroid auto-assign for new
   scans; (optional) "photos of <name>" search.

## Caveats / tuning

- **Accuracy**: face-api.js is good for a personal library, not Apple Photos / InsightFace grade. Expect
  occasional mis-grouping. Tunables: detector (tiny vs ssd), distance `THRESH` (0.5 stricter ↔ 0.6 looser),
  min face size, min cluster size.
- **First scan is the cost**: ~a few photos/sec on the GPU; a few thousand photos ≈ a couple minutes,
  incremental afterward. Run on thumbnails.
- **Bundle size**: +~7 MB model weights.
- **Privacy**: 100% on-device — worth surfacing in the UI as a selling point.

## Reuse from the existing codebase

- Sidecar store pattern + mtime caching: `geoStore` / `phashStore` / `persistGeo()` in `server.js`.
- Per-user stores (for `people.json`): `storesFor(user)` (like `chats`/`memory`/`projects`/`agents`).
- Image walking: `walkFiles(root)` + `isImageFile()`.
- Thumbnails: `GET /api/thumb?path=&w=`.
- Folder/KB scoping + access guard: `guardPath` / `canAccessPath`.
- View wiring + a toolbar/nav entry: mirror how **Photo Map** (`view === "map"`, `map.jsx`) was added.

## Open questions (decide at build time)

- Detector: start with `tiny_face_detector` (fast); offer `ssd_mobilenetv1` if accuracy is poor.
- Scope: scan the **KB**, the **current folder**, or a user-chosen set of folders? (Probably KB + opt-in folders.)
- Where to run clustering: client (simpler, fine for ≤ tens of thousands of faces) vs server.
- Surface as its own **"People"** sidebar entry vs a tab inside the gallery.
