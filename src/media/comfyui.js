/* ============================================================
   ComfyUI HTTP client — text-to-image and image-to-image generation via a
   locally-running ComfyUI server (python main.py — no extra flags needed,
   its HTTP API is on by default).

   Unlike Draw Things (a fixed A1111-style REST shape), ComfyUI takes a full
   node-graph "workflow" per request:
     POST /upload/image        → upload a source image, get back its stored filename
     POST /prompt              → queue a workflow graph, get back a prompt_id
     GET  /history/{prompt_id} → poll until that job's outputs appear
     GET  /view?filename=...   → fetch the generated image bytes
     GET  /object_info/...     → introspect available checkpoints etc.
     GET  /system_stats        → reachability probe
   There's no separate "edit" endpoint — editing is the same /prompt call with
   a graph that loads the source image and denoises it partway (img2img),
   instead of starting from empty noise (txt2img).
   ============================================================ */
const { randomUUID } = require("crypto");
const { Jimp, JimpMime } = require("jimp");

const DEFAULT_URL = "http://localhost:8000";

function origin(url) {
  let s = String(url || DEFAULT_URL).trim();
  if (!/^https?:\/\//i.test(s)) s = "http://" + s;
  try { return new URL(s).origin; } catch { return DEFAULT_URL; }
}

function fail(step, e) {
  const msg = e && e.message ? e.message : String(e);
  throw new Error(`ComfyUI ${step} failed: ${msg}. Make sure the ComfyUI server is running and reachable at the configured URL.`);
}

// ---- low-level calls ----

async function queuePrompt(base, graph, clientId, timeoutMs) {
  let r;
  try { r = await fetch(`${base}/prompt`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: graph, client_id: clientId }),
    signal: AbortSignal.timeout(timeoutMs),
  }); } catch (e) { fail("connection", e); }
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`ComfyUI rejected the workflow (HTTP ${r.status}): ${body.slice(0, 400) || r.statusText}`);
  }
  const j = await r.json();
  if (!j.prompt_id) throw new Error("ComfyUI didn't return a prompt_id.");
  return j.prompt_id;
}

// poll /history/{id} until the job's outputs show up, erroring out on a reported failure or timeout
async function pollForResult(base, promptId, { timeoutMs = 180000, intervalMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let r;
    try { r = await fetch(`${base}/history/${promptId}`, { signal: AbortSignal.timeout(10000) }); } catch (e) { fail("polling", e); }
    if (r.ok) {
      const data = await r.json();
      const entry = data[promptId];
      if (entry) {
        if (entry.status && entry.status.status_str === "error") {
          throw new Error(`ComfyUI run failed: ${JSON.stringify(entry.status.messages || entry.status).slice(0, 400)}`);
        }
        if (entry.outputs) return entry.outputs;
      }
    }
    await new Promise(res => setTimeout(res, intervalMs));
  }
  throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ComfyUI to finish.`);
}

// pull the first image out of any node's outputs (we only ever have one SaveImage node)
function firstImageRef(outputs) {
  for (const nodeId of Object.keys(outputs || {})) {
    const images = outputs[nodeId] && outputs[nodeId].images;
    if (images && images.length) return images[0];
  }
  return null;
}

async function viewImage(base, ref, timeoutMs) {
  const qs = new URLSearchParams({ filename: ref.filename, subfolder: ref.subfolder || "", type: ref.type || "output" });
  let r;
  try { r = await fetch(`${base}/view?${qs}`, { signal: AbortSignal.timeout(timeoutMs) }); } catch (e) { fail("fetching the result image", e); }
  if (!r.ok) throw new Error(`ComfyUI /view returned HTTP ${r.status} for ${ref.filename}`);
  return Buffer.from(await r.arrayBuffer());
}

async function uploadImage(base, buffer, filename, timeoutMs) {
  const form = new FormData();
  form.append("image", new Blob([buffer]), filename);
  form.append("overwrite", "true");
  let r;
  try { r = await fetch(`${base}/upload/image`, { method: "POST", body: form, signal: AbortSignal.timeout(timeoutMs) }); } catch (e) { fail("uploading the image", e); }
  if (!r.ok) throw new Error(`ComfyUI /upload/image returned HTTP ${r.status}`);
  const j = await r.json();
  return j.name || filename;
}

function pngDims(buf) {
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  return {};
}
// sniff the real format from magic bytes — used to name the uploaded file correctly when Jimp
// couldn't decode it (prepInitImage's WEBP/HEIC/AVIF fallback), so ComfyUI's loader sees the right extension
function sniffExt(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (buf.length >= 12 && buf.toString("ascii", 4, 8) === "ftyp") return "heic";
  if (buf.length >= 6 && buf.toString("ascii", 0, 3) === "GIF") return "gif";
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return "bmp";
  return "png";
}

// resize/snap a source image for img2img: ComfyUI's VAE wants dimensions that are multiples of 8;
// downscale (preserving aspect) only if a side exceeds maxDim. maxDim<=0 = keep original size.
// Jimp only bundles PNG/JPEG/BMP/GIF/TIFF decoders — no WEBP/HEIC/AVIF, formats this app otherwise
// treats as valid images (see DESCRIBABLE_IMG). Rather than hard-fail on those, skip the resize and
// upload the original bytes as-is; ComfyUI's own Python-side loader (Pillow) can decode WEBP fine,
// and will surface its own clear error for anything neither side supports.
async function prepInitImage(imageBuffer, maxDim = 1024) {
  let img;
  try { img = await Jimp.read(imageBuffer); }
  catch { return { buffer: imageBuffer }; }
  const { width: W, height: H } = img.bitmap;
  const cap = maxDim && maxDim > 0 ? maxDim : Math.max(W, H);
  const scale = Math.min(cap / W, cap / H, 1);
  const snap = v => Math.max(8, Math.round((v * scale) / 8) * 8);
  const W2 = snap(W), H2 = snap(H);
  if (W2 !== W || H2 !== H) img.resize({ w: W2, h: H2 });
  return { buffer: await img.getBuffer(JimpMime.png), width: W2, height: H2 };
}

// ---- workflow graphs (ComfyUI API format: nodeId → { class_type, inputs }) ----
// Plain SD1.x/SD2.x checkpoint pipeline — matches ComfyUI's own default example workflow.
// Sampler/scheduler are fixed to a safe general-purpose choice; not exposed as tool params.

function buildTxt2ImgGraph({ checkpoint, positive, negative, width, height, steps, cfg, seed }) {
  return {
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: checkpoint } },
    "5": { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: 1 } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: positive, clip: ["4", 1] } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: negative || "", clip: ["4", 1] } },
    "3": { class_type: "KSampler", inputs: {
      seed, steps, cfg, sampler_name: "euler", scheduler: "normal", denoise: 1,
      model: ["4", 0], positive: ["6", 0], negative: ["7", 0], latent_image: ["5", 0],
    } },
    "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "heapchat", images: ["8", 0] } },
  };
}

// Flux.2 Klein 4B (distilled) — the "best quality" tier: a fixed, non-negotiable 4-step/cfg-1
// advanced-sampler pipeline (CFGGuider + RandomNoise + KSamplerSelect + Flux2Scheduler +
// SamplerCustomAdvanced), not the classic KSampler used above. These filenames and parameter
// values are ComfyUI's own validated Flux.2 Klein demo template — don't hand-tune steps/cfg,
// guidance-distilled models are sensitive to them. Much slower (minutes, not seconds) but a
// real quality step up. FLUX_MODELS can be overridden per call (e.g. a different unet variant).
const FLUX_MODELS = { unet: "flux-2-klein-4b-fp8.safetensors", clip: "qwen_3_4b.safetensors", vae: "flux2-vae.safetensors" };

function buildFluxTxt2ImgGraph({ unet, clip, vae, positive, width, height }) {
  return {
    "4": { class_type: "UNETLoader", inputs: { unet_name: unet, weight_dtype: "default" } },
    "5": { class_type: "CLIPLoader", inputs: { clip_name: clip, type: "flux2", device: "default" } },
    "6": { class_type: "VAELoader", inputs: { vae_name: vae } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: positive, clip: ["5", 0] } },
    "8": { class_type: "ConditioningZeroOut", inputs: { conditioning: ["7", 0] } },
    "12": { class_type: "CFGGuider", inputs: { model: ["4", 0], positive: ["7", 0], negative: ["8", 0], cfg: 1 } },
    "13": { class_type: "RandomNoise", inputs: { noise_seed: Math.floor(Math.random() * 2 ** 32) } },
    "14": { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
    "15": { class_type: "Flux2Scheduler", inputs: { steps: 4, width, height } },
    "16": { class_type: "EmptyFlux2LatentImage", inputs: { width, height, batch_size: 1 } },
    "17": { class_type: "SamplerCustomAdvanced", inputs: { noise: ["13", 0], guider: ["12", 0], sampler: ["14", 0], sigmas: ["15", 0], latent_image: ["16", 0] } },
    "18": { class_type: "VAEDecode", inputs: { samples: ["17", 0], vae: ["6", 0] } },
    "19": { class_type: "SaveImage", inputs: { filename_prefix: "heapchat", images: ["18", 0] } },
  };
}

// Flux edit: identical stack, but the source image is VAE-encoded and wired in via ReferenceLatent
// on both the positive AND the zeroed-out negative conditioning — that's what anchors the result to
// the input instead of generating fresh. Ported verbatim from ComfyUI's official Flux.2 Klein
// image-edit template. Note there's no `strength`/denoise knob here — reference-latent editing works
// differently from SD's noise-injection img2img, and the template doesn't expose one.
function buildFluxEditGraph({ unet, clip, vae, positive, sourceImage }) {
  return {
    "1": { class_type: "LoadImage", inputs: { image: sourceImage } },
    "2": { class_type: "ImageScaleToTotalPixels", inputs: { image: ["1", 0], upscale_method: "nearest-exact", megapixels: 1, resolution_steps: 1 } },
    "3": { class_type: "GetImageSize", inputs: { image: ["2", 0] } },
    "4": { class_type: "UNETLoader", inputs: { unet_name: unet, weight_dtype: "default" } },
    "5": { class_type: "CLIPLoader", inputs: { clip_name: clip, type: "flux2", device: "default" } },
    "6": { class_type: "VAELoader", inputs: { vae_name: vae } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: positive, clip: ["5", 0] } },
    "8": { class_type: "ConditioningZeroOut", inputs: { conditioning: ["7", 0] } },
    "9": { class_type: "VAEEncode", inputs: { pixels: ["2", 0], vae: ["6", 0] } },
    "10": { class_type: "ReferenceLatent", inputs: { conditioning: ["7", 0], latent: ["9", 0] } },
    "11": { class_type: "ReferenceLatent", inputs: { conditioning: ["8", 0], latent: ["9", 0] } },
    "12": { class_type: "CFGGuider", inputs: { model: ["4", 0], positive: ["10", 0], negative: ["11", 0], cfg: 1 } },
    "13": { class_type: "RandomNoise", inputs: { noise_seed: Math.floor(Math.random() * 2 ** 32) } },
    "14": { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
    "15": { class_type: "Flux2Scheduler", inputs: { steps: 4, width: ["3", 0], height: ["3", 1] } },
    "16": { class_type: "EmptyFlux2LatentImage", inputs: { width: ["3", 0], height: ["3", 1], batch_size: 1 } },
    "17": { class_type: "SamplerCustomAdvanced", inputs: { noise: ["13", 0], guider: ["12", 0], sampler: ["14", 0], sigmas: ["15", 0], latent_image: ["16", 0] } },
    "18": { class_type: "VAEDecode", inputs: { samples: ["17", 0], vae: ["6", 0] } },
    "19": { class_type: "SaveImage", inputs: { filename_prefix: "heapchat", images: ["18", 0] } },
  };
}

function buildImg2ImgGraph({ checkpoint, positive, negative, sourceImage, denoise, steps, cfg, seed }) {
  return {
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: checkpoint } },
    "1": { class_type: "LoadImage", inputs: { image: sourceImage } },
    "2": { class_type: "VAEEncode", inputs: { pixels: ["1", 0], vae: ["4", 2] } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: positive, clip: ["4", 1] } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: negative || "", clip: ["4", 1] } },
    "3": { class_type: "KSampler", inputs: {
      seed, steps, cfg, sampler_name: "euler", scheduler: "normal", denoise,
      model: ["4", 0], positive: ["6", 0], negative: ["7", 0], latent_image: ["2", 0],
    } },
    "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "heapchat", images: ["8", 0] } },
  };
}

// ---- public API ----

// Reachability probe + checkpoint listing (no model-listing concept like DT's "currently loaded
// model" — ComfyUI has none; every request names its own checkpoint). sharedSecretMissing is
// always false: stock ComfyUI has no auth.
async function cfEcho({ url, timeoutMs = 8000 } = {}) {
  const base = origin(url);
  let stats;
  try {
    const r = await fetch(`${base}/system_stats`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    stats = await r.json();
  } catch (e) {
    throw new Error(`ComfyUI unreachable at ${base}: ${e.message}. Make sure the ComfyUI server is running and reachable at that address.`);
  }
  let files = [];
  try {
    const r = await fetch(`${base}/object_info/CheckpointLoaderSimple`, { signal: AbortSignal.timeout(timeoutMs) });
    if (r.ok) {
      const j = await r.json();
      files = ((j.CheckpointLoaderSimple && j.CheckpointLoaderSimple.input.required.ckpt_name[0]) || []).map(String);
    }
  } catch {}
  return { ok: true, message: (stats.system && stats.system.comfyui_version) ? `ComfyUI ${stats.system.comfyui_version}` : "comfyui",
    files, currentModel: "", serverIdentifier: "comfyui", sharedSecretMissing: false, thresholds: null };
}

// text-to-image. Resolves with { images:[{png,ext,width,height}], tags:[] } — same shape as the
// Draw Things client, so callers can treat both backends identically. quality: "fast" (default) =
// the plain SD checkpoint graph, ~seconds. "best" = Flux.2 Klein, much slower (minutes) but sharper —
// steps/cfg are fixed by the Flux template, only the prompt/dimensions/model files vary.
async function cfGenerate({ url, model, prompt, negativePrompt = "", width = 512, height = 512,
  steps = 20, cfg = 7, seed, quality = "fast", flux, timeoutMs } = {}) {
  if (!prompt || !String(prompt).trim()) throw new Error("A prompt is required.");
  const base = origin(url);
  let graph, effectiveTimeout;
  if (quality === "best") {
    const f = { ...FLUX_MODELS, ...(flux || {}) };
    graph = buildFluxTxt2ImgGraph({
      unet: f.unet, clip: f.clip, vae: f.vae, positive: String(prompt),
      width: Math.max(64, Math.round((Number(width) || 1024) / 64) * 64),
      height: Math.max(64, Math.round((Number(height) || 1024) / 64) * 64),
    });
    effectiveTimeout = timeoutMs || 420000;   // Flux.2 Klein: minutes, not seconds
  } else {
    if (!model) throw new Error("No ComfyUI checkpoint available — set one in Settings → Image generation.");
    graph = buildTxt2ImgGraph({
      checkpoint: model, positive: String(prompt), negative: negativePrompt,
      width: Math.max(8, Math.round((Number(width) || 512) / 8) * 8),
      height: Math.max(8, Math.round((Number(height) || 512) / 8) * 8),
      steps: Math.max(1, Math.min(150, Number(steps) || 20)),
      cfg: cfg != null ? Number(cfg) : 7,
      seed: (seed === undefined || seed === null || seed < 0) ? Math.floor(Math.random() * 1e15) : Number(seed),
    });
    effectiveTimeout = timeoutMs || 180000;
  }
  const promptId = await queuePrompt(base, graph, randomUUID(), effectiveTimeout);
  const outputs = await pollForResult(base, promptId, { timeoutMs: effectiveTimeout });
  const ref = firstImageRef(outputs);
  if (!ref) throw new Error("ComfyUI finished but produced no image.");
  const png = await viewImage(base, ref, effectiveTimeout);
  return { images: [{ png, ext: "png", ...pngDims(png) }], tags: [] };
}

// image-to-image / edit. `imageBuffer` is the source PNG/JPEG bytes; `strength` is how far to
// drift from the source (0 = identical, 1 = ignore it — mirrors Draw Things' strength semantics,
// mapped straight onto ComfyUI's KSampler `denoise`). quality "best" (Flux.2 Klein reference-latent
// editing) has no strength/denoise knob — the template doesn't expose one, `strength` is ignored.
async function cfEdit({ url, model, prompt, negativePrompt = "", imageBuffer, maxDim = 1024,
  steps = 20, cfg = 7, strength = 0.65, seed, quality = "fast", flux, timeoutMs } = {}) {
  if (!prompt || !String(prompt).trim()) throw new Error("A prompt is required.");
  if (!imageBuffer || !imageBuffer.length) throw new Error("A base image is required to edit.");
  const base = origin(url);
  const { buffer } = await prepInitImage(imageBuffer, maxDim);
  const uploadedName = await uploadImage(base, buffer, `heapchat-src-${Date.now()}.${sniffExt(buffer)}`, timeoutMs || 60000);
  let graph, effectiveTimeout;
  if (quality === "best") {
    const f = { ...FLUX_MODELS, ...(flux || {}) };
    graph = buildFluxEditGraph({ unet: f.unet, clip: f.clip, vae: f.vae, positive: String(prompt), sourceImage: uploadedName });
    effectiveTimeout = timeoutMs || 420000;
  } else {
    if (!model) throw new Error("No ComfyUI checkpoint available — set one in Settings → Image generation.");
    graph = buildImg2ImgGraph({
      checkpoint: model, positive: String(prompt), negative: negativePrompt, sourceImage: uploadedName,
      denoise: Math.max(0.05, Math.min(1, Number(strength))),
      steps: Math.max(1, Math.min(150, Number(steps) || 20)),
      cfg: cfg != null ? Number(cfg) : 7,
      seed: (seed === undefined || seed === null || seed < 0) ? Math.floor(Math.random() * 1e15) : Number(seed),
    });
    effectiveTimeout = timeoutMs || 180000;
  }
  const promptId = await queuePrompt(base, graph, randomUUID(), effectiveTimeout);
  const outputs = await pollForResult(base, promptId, { timeoutMs: effectiveTimeout });
  const ref = firstImageRef(outputs);
  if (!ref) throw new Error("ComfyUI finished but produced no image.");
  const png = await viewImage(base, ref, effectiveTimeout);
  return { images: [{ png, ext: "png", ...pngDims(png) }], tags: [] };
}

module.exports = { cfEcho, cfGenerate, cfEdit, DEFAULT_URL, FLUX_MODELS };
