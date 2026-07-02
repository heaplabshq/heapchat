/* ============================================================
   Batch document processing — multi-file structured extraction into table rows
   (used by the /api/extract button AND the agent's extract tool), plus
   contentBasis (the text/caption an autotag or rename suggestion reasons over).
   ============================================================ */
const path = require("path");
const fsp = require("fs/promises");
const { OLLAMA_AGENT_MODEL } = require("../config");
const { isImageFile } = require("../util/files");
const { imageMeta } = require("../state/sidecars");
const { mapLimit } = require("../util/concurrency");
const { completeJSON } = require("../llm/ollama");
const { storedImageText, describeImage, visionExtract, visionTranscribe } = require("../llm/vision");
const { extractText } = require("./extract");

// read each file (vision OCR for photos) and pull `fields` into table rows.
// fields omitted → infer 3-6 columns from the first readable document.
async function runExtraction(files, fieldsArg) {
  const docText = async f => {
    if (isImageFile(f)) { const cached = imageMeta[f] && imageMeta[f].description; return (cached && cached.length > 40) ? cached : await visionTranscribe(f); }
    const { text, status } = await extractText(f); return status === "ok" ? text : "";
  };
  let fields = Array.isArray(fieldsArg) ? fieldsArg.map(f => String(f).trim()).filter(Boolean).slice(0, 7) : [];
  if (!fields.length) {   // auto-detect columns from the first readable document
    for (const f of files) {
      const text = await docText(f);
      if (text.trim()) {
        const inf = await completeJSON(OLLAMA_AGENT_MODEL, "You design a table from a document. Return ONLY a JSON array of 3-6 short snake_case field names worth extracting from this kind of document.", text.slice(0, 4000), 120);
        if (Array.isArray(inf)) fields = inf.map(x => String(x).trim()).filter(Boolean).slice(0, 7);
        break;
      }
    }
  }
  if (!fields.length) fields = ["summary"];
  const sys = `Extract the requested fields from the document. Return ONLY a JSON object mapping each field to a short value (string or number), using null when a field is absent. Fields: ${JSON.stringify(fields)}.`;
  const rows = await mapLimit(files, 2, async f => {
    const name = path.basename(f); let obj = null;
    if (isImageFile(f)) obj = await visionExtract(f, fields);   // vision OCR + extract in one shot
    else { const { text, status } = await extractText(f); if (status === "ok" && text.trim()) obj = await completeJSON(OLLAMA_AGENT_MODEL, sys, `Document (${name}):\n${text.slice(0, 6000)}`, 400); }
    obj = obj || {};
    return { name, path: f, vals: fields.map(k => { const v = obj[k]; return v == null ? "" : String(v); }) };
  });
  return { fields, columns: ["File", ...fields], rows: rows.map(r => [r.name, ...r.vals]), sources: rows.map(r => ({ name: r.name, path: r.path, score: 1 })) };
}

// the text/caption an autotag or rename suggestion reasons over (vision caption for images)
async function contentBasis(p) {
  try {
    if (isImageFile(p)) {
      const st = await fsp.stat(p);
      return storedImageText(p, st.mtimeMs) || (await describeImage(p, (imageMeta[p] && imageMeta[p].context) || "")).text;
    }
    return ((await extractText(p)).text || "").slice(0, 3000);
  } catch { return ""; }
}

module.exports = { runExtraction, contentBasis };
