/* ============================================================
   Draw Things HTTP client — text-to-image and image-to-image generation
   via a locally-running Draw Things "API Server" in HTTP mode.

   Enable it in the Draw Things app: Advanced → API Server → Protocol: HTTP,
   Port: 7860 (and bind to your LAN, not localhost-only, if Cortex runs on a
   different machine). This speaks the AUTOMATIC1111-compatible REST API:
     GET  /sdapi/v1/options   → live config (current model lives here)
     POST /sdapi/v1/txt2img   → generate (dtGenerate)
     POST /sdapi/v1/img2img   → edit: source image as the base + strength (dtEdit)
   There's no HTTP way to set the canvas otherwise — init_images on img2img IS the
   "image on the canvas" the app uses. Draw Things uses its own param names
   (guidance_scale, batch_count); we send those. Responses are base64 PNGs.

   This replaces the previous gRPC implementation, which couldn't connect:
   the Draw Things gRPC server (:7859) requires TLS with a per-install
   self-signed "Draw Things Root CA" that isn't retrievable from a client.
   ============================================================ */
const http = require("http");
const https = require("https");
const { URL } = require("url");
const { Jimp, JimpMime } = require("jimp");

const DEFAULT_URL = "http://localhost:7860";

// Draw Things sampler names (its own enum, accepted by sampler_name). Kept for
// callers that want to expose a picker; generation omits it and uses the
// server's selected sampler when not provided.
const SAMPLERS = ["DPMPP2MKarras", "EulerA", "DDIM", "PLMS", "DPMPPSDEKarras", "UniPC", "LCM",
  "EulerASubstep", "DPMPPSDESubstep", "TCD", "EulerATrailing", "DPMPPSDETrailing", "DPMPP2MAYS",
  "EulerAAYS", "DPMPPSDEAYS", "DPMPP2MTrailing", "DDIMTrailing", "UniPCTrailing", "UniPCAYS", "TCDTrailing"];

// Normalize a configured endpoint to its origin (scheme://host:port), tolerating
// a trailing path or slash. Defaults the scheme to http:// if the user omitted it.
function origin(url) {
  let s = String(url || DEFAULT_URL).trim();
  if (!/^https?:\/\//i.test(s)) s = "http://" + s;
  try { return new URL(s).origin; } catch { return DEFAULT_URL; }
}

// Minimal JSON request helper over http/https with a timeout. Returns parsed JSON
// (or {} for an empty 2xx body); rejects with a readable message on transport or
// non-2xx errors. rejectUnauthorized:false so an HTTPS endpoint with a self-signed
// cert still works (the API is local/LAN).
function request(method, urlStr, body, { timeoutMs = 180000, sharedSecret } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch { return reject(new Error(`Invalid Draw Things URL: ${urlStr}`)); }
    const lib = u.protocol === "https:" ? https : http;
    const payload = body != null ? Buffer.from(JSON.stringify(body)) : null;
    const headers = { Accept: "application/json" };
    if (payload) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = payload.length; }
    if (sharedSecret) headers.Authorization = `Bearer ${sharedSecret}`;
    const opts = {
      hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: (u.pathname || "/") + (u.search || ""), method, headers, rejectUnauthorized: false,
    };
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Draw Things HTTP ${res.statusCode} from ${u.pathname}: ${buf.toString("utf8").slice(0, 300) || res.statusMessage}`));
        }
        if (!buf.length) return resolve({});
        try { resolve(JSON.parse(buf.toString("utf8"))); }
        catch { reject(new Error(`Draw Things returned non-JSON from ${u.pathname} — is the API Server set to HTTP mode? Body: ${buf.toString("utf8").slice(0, 160)}`)); }
      });
    });
    req.on("error", (e) => reject(new Error(`Draw Things unreachable at ${u.origin}: ${e.message}. Enable Advanced → API Server (Protocol: HTTP) in the Draw Things app.`)));
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`)));
    if (payload) req.write(payload);
    req.end();
  });
}

// PNG header → { width, height }. Used to label returned images without a full decode.
function pngDims(buf) {
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  return {};
}
function imageExt(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return "webp";
  return "png";
}
// Decode one returned base64 image string into { png, ext, width, height }.
function decodeImage(b64) {
  const clean = String(b64 || "").replace(/^data:[^,]*,/, "");
  const buf = Buffer.from(clean, "base64");
  if (!buf.length) throw new Error("Draw Things returned an empty image.");
  return { png: buf, ext: imageExt(buf), ...pngDims(buf) };
}

// ---- public API (signatures match the former gRPC client) ----

// Connectivity probe. The Draw Things HTTP API has no model-listing endpoint
// (/sdapi/v1/sd-models is 404); GET /sdapi/v1/options returns the live config,
// whose `model` is the currently-loaded checkpoint's real filename. We surface
// that as the sole `files` entry so callers can confirm reachability and auto-pick
// the loaded model. HTTP has no shared-secret handshake → sharedSecretMissing=false.
async function dtEcho({ url, sharedSecret, timeoutMs = 8000 } = {}) {
  const base = origin(url);
  const opts = await request("GET", `${base}/sdapi/v1/options`, null, { timeoutMs, sharedSecret });
  const current = (opts && (opts.model || opts.sd_model_checkpoint)) || "";
  const files = current ? [String(current)] : [];
  return { ok: true, message: current || "drawthings-http", files, currentModel: current,
    serverIdentifier: "drawthings-http", sharedSecretMissing: false, thresholds: null };
}

// text-to-image. Resolves with { images:[{png,ext,width,height}], tags:[] }.
async function dtGenerate({ url, model, prompt, negativePrompt = "", width = 512, height = 512, steps = 4,
  guidanceScale = 1.5, seed = -1, sampler, batchSize, sharedSecret, timeoutMs } = {}) {
  if (!prompt || !String(prompt).trim()) throw new Error("A prompt is required.");
  const body = buildBody({ model, prompt, negativePrompt, width, height, steps, guidanceScale, seed, sampler, batchSize });
  const out = await request("POST", `${origin(url)}/sdapi/v1/txt2img`, body, { timeoutMs, sharedSecret });
  return { images: collect(out), tags: [] };
}

// Re-encode the base image for img2img: Draw Things does NOT auto-resize init_images —
// it requires the width/height params to equal the init image's actual dimensions (and
// they must be multiples of 64). We use the image's OWN dimensions, snapped to the nearest
// /64, and downscale (preserving aspect) only if a side exceeds `maxDim`. maxDim<=0 means
// "no cap" — send the original resolution. Returns the PNG base64 + the dims to send.
async function prepInitImage(imageBuffer, maxDim = 1024) {
  const img = await Jimp.read(imageBuffer);
  const { width: W, height: H } = img.bitmap;
  const cap = maxDim && maxDim > 0 ? maxDim : Math.max(W, H);   // <=0 → keep original size
  const scale = Math.min(cap / W, cap / H, 1);                  // 1 = keep size; <1 only when over the cap
  const snap = v => Math.max(64, Math.min(cap, Math.round((v * scale) / 64) * 64));
  const W2 = snap(W), H2 = snap(H);
  if (W2 !== W || H2 !== H) img.resize({ w: W2, h: H2 });
  const png = await img.getBuffer(JimpMime.png);
  return { b64: png.toString("base64"), width: W2, height: H2 };
}

// image-to-image / edit — the ONLY way to truly modify an existing image (text-to-image
// can't: Draw Things rejects init_images on txt2img). `imageBuffer` is PNG/JPEG bytes of
// the source, re-encoded to dims Draw Things accepts. strength = how far to drift from the
// source (0 = identical, 1 = ignore it). This is a per-request call — it does NOT change
// the app's saved config (verified: model/sampler/size/strength unchanged after).
async function dtEdit({ url, model, prompt, negativePrompt = "", imageBuffer, maxDim = 1024,
  steps = 4, guidanceScale = 1.5, strength = 0.99, seed = -1, sampler, sharedSecret, timeoutMs } = {}) {
  if (!prompt || !String(prompt).trim()) throw new Error("A prompt is required.");
  if (!imageBuffer || !imageBuffer.length) throw new Error("A base image is required to edit.");
  const { b64, width, height } = await prepInitImage(imageBuffer, maxDim);
  const body = buildBody({ model, prompt, negativePrompt, width, height, steps, guidanceScale, seed, sampler });
  body.init_images = [b64];
  body.strength = strength;   // Draw Things img2img drift (0 = identical, 1 = ignore source)
  const out = await request("POST", `${origin(url)}/sdapi/v1/img2img`, body, { timeoutMs, sharedSecret });
  return { images: collect(out), tags: [] };
}

// Shared request body using Draw Things' native field names. (It rejects sending
// both a native key and its A1111 alias — e.g. guidance_scale + cfg_scale — with a
// 422, so we send only the native one.)
function buildBody({ model, prompt, negativePrompt, width, height, steps, guidanceScale, seed, sampler, batchSize }) {
  const body = {
    prompt: String(prompt),
    negative_prompt: String(negativePrompt || ""),
    steps: Math.max(1, Math.min(150, Number(steps) || 4)),
    seed: (seed === undefined || seed === null) ? -1 : Number(seed),
    guidance_scale: guidanceScale != null ? guidanceScale : 1.5,
  };
  if (width) body.width = Number(width);
  if (height) body.height = Number(height);
  if (model && String(model).trim()) body.model = String(model).trim();
  if (sampler) body.sampler_name = sampler;
  if (batchSize) body.batch_count = Math.max(1, Math.min(4, Number(batchSize)));
  return body;
}

// Pull the base64 image array out of a txt2img/img2img response and decode each.
function collect(out) {
  const arr = (out && Array.isArray(out.images)) ? out.images : [];
  if (!arr.length) throw new Error("Draw Things returned no image (check a model is loaded in the app and the prompt is valid).");
  return arr.map(decodeImage);
}

module.exports = { dtEcho, dtGenerate, dtEdit, decodeImage, SAMPLERS, DEFAULT_URL };
