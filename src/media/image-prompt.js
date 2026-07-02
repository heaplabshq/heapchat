/* Helpers shared by the agent's image tools (src/agent/core.js) and the direct
   /api/image routes (server.js):
   - enhancePrompt: rewrite a short user idea into a vivid Draw Things prompt via
     the local chat LLM (best-effort — falls back to the raw prompt on any failure).
   - saveGeneratedImage: persist a generated PNG into <kb>/generated/ with a unique,
     human-readable filename. */
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { completeText } = require("../llm/ollama");
const { safeName } = require("../util/files");

const CREATE_SYS = `You are a prompt engineer for a text-to-image diffusion model. Rewrite the user's idea into ONE vivid, concrete image prompt. Include subject, composition, setting, style, lighting, lens/camera feel, and mood. Use descriptive comma-separated phrases, not sentences. Do NOT add commentary, quotes, or labels — output only the prompt. Keep it under 60 words.`;
const EDIT_SYS = `You are a prompt engineer for image EDITING (image-to-image). The original image is ALREADY provided to the model as the base — your job is to sharpen ONLY the user's requested change. Expand their instruction into a vivid, specific description of just that change: the new element/style/color/lighting/material/effect and how it should look. Do NOT describe or restate the parts of the image that stay the same, and do NOT invent unrelated scene content or subjects. Keep the user's intent exact — don't add changes they didn't ask for. Output only the edit instruction as concrete comma-separated phrases, under 40 words.`;

// Rewrite `raw` into a richer prompt. mode: "create" (txt2img) | "edit" (img2img).
// Returns the enhanced text, or `raw` unchanged if the model is unavailable/empty.
async function enhancePrompt(model, raw, mode = "create") {
  const input = String(raw || "").trim();
  if (!input || !model) return input;
  const sys = mode === "edit" ? EDIT_SYS : CREATE_SYS;
  try {
    const out = (await completeText(model, sys, input, 160, 0.5) || "").trim()
      .replace(/^["'`]+|["'`]+$/g, "")               // strip wrapping quotes
      .replace(/^(prompt|output|result)\s*[:\-]\s*/i, ""); // strip a stray label
    return out.length >= 3 ? out : input;
  } catch { return input; }
}

// Save a generated PNG into <kbDir>/generated/ (browsable in the gallery; not
// auto-indexed). Returns the absolute path. Mirrors the former dtSaveImage.
async function saveGeneratedImage(kbDir, png, label) {
  const dir = path.join(kbDir, "generated");
  await fsp.mkdir(dir, { recursive: true });
  const base = (safeName(String(label || "image")).replace(/\.png$/i, "").slice(0, 60) || "image");
  let p = path.join(dir, base + ".png"), i = 1;
  while (fs.existsSync(p)) { p = path.join(dir, `${base} (${i}).png`); i++; }
  await fsp.writeFile(p, png);
  return p;
}

module.exports = { enhancePrompt, saveGeneratedImage, CREATE_SYS, EDIT_SYS };
