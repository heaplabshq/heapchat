/* ============================================================
   Image understanding — vision captions stored as searchable text so images can
   be indexed and used by the agent (multimodal RAG). Captions live in the shared
   imageMeta sidecar (data/imagemeta.json): { [path]: { context, description, text, mtime } }.
   All calls go to the local Ollama vision model (fully local OCR, no telemetry).
   ============================================================ */
const fsp = require("fs/promises");
const path = require("path");
const { OLLAMA_KEEP_ALIVE, OLLAMA_VISION_MODEL } = require("../config");
const ollamaConn = require("./ollama-conn");
const { imageMeta, persistImageMeta } = require("../state/sidecars");

// stored searchable text for an image, if a fresh description exists (mtime matches)
function storedImageText(filePath, mtimeMs) {
  const m = imageMeta[filePath];
  if (m && m.mtime === mtimeMs && m.text) return m.text;
  return null;
}
// run the vision model to describe an image; combine with user context; store + return
async function describeImage(filePath, context = "", instructions = "") {
  const st = await fsp.stat(filePath);
  const b64 = (await fsp.readFile(filePath)).toString("base64");
  const messages = instructions ? [
    { role: "system", content: `You must follow these specific instructions when analyzing the image: ${instructions}` },
    { role: "user", content: `Describe this image for a search index.` +
      (context ? `\n\nContext to include: "${context}"` : ""), images: [b64] },
  ] : [
    { role: "user", content:
      "Describe this image in thorough detail for a search index. Cover: the main subjects/objects, " +
      "any people and what they're doing, any visible text, the setting/scene, colors, mood, and notable details. " +
      "Write a dense factual paragraph." +
      (context ? `\n\nUser context to incorporate: "${context}"` : ""), images: [b64] },
  ];
  const r = await fetch(`${ollamaConn.baseUrl()}/api/chat`, {
    method: "POST", headers: ollamaConn.headers(),
    body: JSON.stringify({ keep_alive: OLLAMA_KEEP_ALIVE,
      model: OLLAMA_VISION_MODEL, stream: false, think: false,
      messages,
      options: { temperature: 0.2 },
    }),
  });
  if (!r.ok) throw new Error(`vision ${r.status}: ${await r.text().catch(() => "")}`);
  const j = await r.json();
  const description = ((j.message && j.message.content) || "").trim();
  const text = (context ? `User context: ${context}\n\n` : "") + `Image "${path.basename(filePath)}": ${description}`;
  imageMeta[filePath] = { context, description, text, mtime: st.mtimeMs };
  persistImageMeta();
  return imageMeta[filePath];
}
// core: send a base64 image to the vision model. json=true → parse a JSON object; else return text. (OCR — fully local)
async function visionReadB64(b64, prompt, json) {
  try {
    const r = await fetch(`${ollamaConn.baseUrl()}/api/chat`, {
      method: "POST", headers: ollamaConn.headers(),
      body: JSON.stringify({ keep_alive: OLLAMA_KEEP_ALIVE, model: OLLAMA_VISION_MODEL, stream: false, think: false, messages: [{ role: "user", content: prompt, images: [b64] }], options: { temperature: 0 } }),
    });
    if (!r.ok) return json ? null : "";
    const txt = (((await r.json()).message) || {}).content || "";
    if (!json) return txt.trim();
    const mm = txt.match(/\{[\s\S]*\}/);
    return mm ? JSON.parse(mm[0]) : null;
  } catch { return json ? null : ""; }
}
// read a document image with the vision model and extract fields as JSON (OCR + understanding in one pass — no Tesseract)
async function visionExtract(filePath, fields) {
  try {
    const b64 = (await fsp.readFile(filePath)).toString("base64");
    return await visionReadB64(b64, `This is a photo or scan of a document (it may be a receipt, invoice, ID, business card, form, statement, or screenshot). Read ALL the visible text carefully and extract these fields. Return ONLY a JSON object mapping each field to a short value (string or number), using null when a field isn't present. Fields: ${JSON.stringify(fields)}.`, true);
  } catch { return null; }
}
// read all text off a document image (for auto-detecting fields / making photos searchable)
async function visionTranscribe(filePath) {
  try {
    const b64 = (await fsp.readFile(filePath)).toString("base64");
    return await visionReadB64(b64, "Transcribe ALL text visible in this document image, preserving the order and key labels. If it's a form/receipt/card, keep field names with their values. Output just the text.", false);
  } catch { return ""; }
}

module.exports = { storedImageText, describeImage, visionReadB64, visionExtract, visionTranscribe };
