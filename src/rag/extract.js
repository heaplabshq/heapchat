/* ============================================================
   Text extraction — shared by chat context + the RAG index.
   Plain text / docx (mammoth) / pdf (pdf-parse, with a local vision-OCR fallback
   for scanned PDFs). Images return their stored vision caption. buildFileContext
   assembles the single-file context block (text or base64 image) for the model.
   ============================================================ */
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const mammoth = require("mammoth");        // .docx → plain text
const { PDFParse } = require("pdf-parse");  // .pdf → plain text
const { extOf, kindOf, fmtSize, fmtDate, TEXTLIKE, isImageFile } = require("../util/files");
const { getTags, imageMeta, pdfOcrStore, persistPdfOcr } = require("../state/sidecars");
const { storedImageText, visionReadB64 } = require("../llm/vision");

// OCR a scanned/image-based PDF: rasterize pages with mupdf (fully local, no telemetry) → read each with the vision model.
let _mupdf = null;
async function getMupdf() { if (!_mupdf) _mupdf = await import("mupdf"); return _mupdf; }
async function ocrPdf(filePath, maxPages = 8) {
  try {
    const mupdf = await getMupdf();
    const doc = mupdf.Document.openDocument(new Uint8Array(await fsp.readFile(filePath)), "application/pdf");
    const n = Math.min(doc.countPages(), maxPages);
    let out = "";
    for (let i = 0; i < n; i++) {
      const pix = doc.loadPage(i).toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false, true);
      const b64 = Buffer.from(pix.asPNG()).toString("base64");
      const txt = await visionReadB64(b64, "Transcribe ALL text visible on this document page, preserving order and any field labels with their values. Output just the text.", false);
      if (txt) out += (out ? "\n\n" : "") + txt;
    }
    return out.trim();
  } catch (e) { console.error("ocrPdf:", e.message); return ""; }
}
// cache OCR'd PDF text by mtime so each scanned PDF is only read once
async function getPdfOcr(filePath) {
  let st; try { st = fs.statSync(filePath); } catch { return ""; }
  const c = pdfOcrStore[filePath];
  if (c && c.m === st.mtimeMs) return c.t;
  const t = await ocrPdf(filePath);
  pdfOcrStore[filePath] = { m: st.mtimeMs, t }; persistPdfOcr();
  return t;
}

// Returns { text, status } where status is "ok" | "empty" | "binary" | "error".
// Images return their stored vision description (if any); user tags are prepended so they're searchable.
async function extractText(filePath) {
  const r = await extractRaw(filePath);
  if (r.status === "ok") {
    const tags = getTags(filePath);
    if (tags.length) r.text = `Tags: ${tags.join(", ")}\n\n${r.text}`;
  }
  return r;
}
async function extractRaw(filePath) {
  const ext = extOf(filePath);
  let st; try { st = await fsp.stat(filePath); } catch { return { text: "", status: "error" }; }
  if (isImageFile(ext)) {
    const t = storedImageText(filePath, st.mtimeMs);
    return t ? { text: t, status: "ok" } : { text: "", status: "binary" };
  }
  try {
    if (TEXTLIKE.has(ext) && st.size <= 5 * 1024 * 1024) {
      return { text: await fsp.readFile(filePath, "utf8"), status: "ok" };
    }
    if (ext === "docx" && st.size <= 25 * 1024 * 1024) {
      const { value } = await mammoth.extractRawText({ path: filePath });
      const body = (value || "").trim();
      return body ? { text: body, status: "ok" } : { text: "", status: "empty" };
    }
    if (ext === "pdf" && st.size <= 25 * 1024 * 1024) {
      const data = await fsp.readFile(filePath);
      const r = await new PDFParse({ data }).getText();
      const body = (r.text || "").replace(/\n+-- \d+ of \d+ --\n*/g, "\n").trim();
      if (body.length > 40) return { text: body, status: "ok" };   // has a real text layer
      const ocr = await getPdfOcr(filePath);                        // scanned/image PDF → vision OCR (cached)
      return ocr ? { text: ocr, status: "ok" } : { text: "", status: "empty" };
    }
  } catch (e) {
    return { text: "", status: "error", error: e.message };
  }
  return { text: "", status: "binary" };
}

// build single-file context for the model (text block, or base64 image for the vision model)
async function buildFileContext(filePath, useVision) {
  const ext = extOf(filePath);
  const kind = kindOf(filePath);
  const st = await fsp.stat(filePath);
  const head =
    `FILE CONTEXT\n` +
    `name: ${path.basename(filePath)}\n` +
    `type: ${kind} (.${ext})\n` +
    `size: ${fmtSize(st.size)}\n` +
    `modified: ${fmtDate(st.mtimeMs)}\n`;

  // Images go to the vision model as base64, plus any stored context/description and tags.
  if (kind === "photo" && useVision && st.size <= 12 * 1024 * 1024 && ext !== "svg") {
    const b64 = (await fsp.readFile(filePath)).toString("base64");
    const m = imageMeta[filePath];
    const tags = getTags(filePath);
    let extra = "";
    if (m && m.context) extra += `\nUser-provided context about this image: ${m.context}`;
    if (tags.length) extra += `\nTags: ${tags.join(", ")}`;
    if (m && m.description) extra += `\nPrior analysis of this image: ${m.description}`;
    return { text: head + extra, images: [b64] };
  }

  const { text, status } = await extractText(filePath);
  if (status === "ok") {
    const LIMIT = 16000;
    const body = text.length > LIMIT ? text.slice(0, LIMIT) + "\n…[truncated]" : text;
    return { text: head + `\n--- FILE CONTENTS ---\n${body}\n--- END CONTENTS ---\n`, images: [] };
  }
  if (status === "empty" && ext === "pdf") {
    return { text: head + `\n(This PDF has no extractable text — it's likely scanned/image-based. Answer from filename/metadata or ask the user.)\n`, images: [] };
  }
  return {
    text: head + `\n(The raw contents of this ${kind} file aren't extractable as text here; ` +
      `answer from the filename, type, and metadata, and ask clarifying questions if needed.)\n`,
    images: [],
  };
}

module.exports = { getMupdf, ocrPdf, getPdfOcr, extractText, extractRaw, buildFileContext };
