/* Global runtime config — the single place that reads process.env for server-wide
   settings. Loaded before anything else. */
require("dotenv").config();
const path = require("path");

// repo root (this file lives in <root>/src). User data lives next to the source by
// default, but the desktop wrapper points HEAPCHAT_DATA_DIR at a writable per-user
// location (the packaged app folder is read-only).
const ROOT = path.join(__dirname, "..");
const DATA_DIR = process.env.HEAPCHAT_DATA_DIR ? path.resolve(process.env.HEAPCHAT_DATA_DIR) : path.join(ROOT, "data");

const PORT = process.env.PORT || 5174;
const HOST = process.env.HOST || "127.0.0.1";   // initial default only — admins toggle network access live in Settings (data/server.json wins)
const OLLAMA_URL = (process.env.OLLAMA_URL || "http://localhost:11434").replace(/\/+$/, "");
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.1:8b";
const OLLAMA_VISION_MODEL = process.env.OLLAMA_VISION_MODEL || OLLAMA_MODEL;
const OLLAMA_AGENT_MODEL = process.env.OLLAMA_AGENT_MODEL || OLLAMA_MODEL;
const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || "30m";   // keep models resident between requests — kills the cold-load stall
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text:latest";   // folder-level RAG ("Ask folder") — must stay consistent within an index; see src/rag/index.js
const OLLAMA_RERANK_MODEL = process.env.OLLAMA_RERANK_MODEL || "qllama/bge-reranker-v2-m3:latest";   // optional cross-encoder second pass in src/rag/retrieve.js — best-effort, falls back to embedding-only ranking if unavailable
const COMFYUI_URL = (process.env.COMFYUI_URL || "http://localhost:8000").replace(/\/+$/, "");   // local ComfyUI server for generate_image/edit_image (default active image backend)

// NVIDIA's OpenAI-compatible API (integrate.api.nvidia.com) — an optional second provider
// alongside Ollama. The key is server-side only (admin-configured via .env); it's never sent
// to or settable by the browser. Selectable models are capped to an admin-set allowlist rather
// than accepting arbitrary model strings from the client.
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || "";
const NVIDIA_BASE_URL = (process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1").replace(/\/+$/, "");
const NVIDIA_MODELS = (process.env.NVIDIA_MODELS || "z-ai/glm-5.2").split(",").map(s => s.trim()).filter(Boolean);
const NVIDIA_MODEL = process.env.NVIDIA_MODEL || NVIDIA_MODELS[0] || "";
const NVIDIA_AGENT_MODEL = process.env.NVIDIA_AGENT_MODEL || NVIDIA_MODEL;

module.exports = { ROOT, DATA_DIR, PORT, HOST, OLLAMA_URL, OLLAMA_MODEL, OLLAMA_VISION_MODEL, OLLAMA_AGENT_MODEL, OLLAMA_KEEP_ALIVE, OLLAMA_EMBED_MODEL, OLLAMA_RERANK_MODEL, COMFYUI_URL,
  NVIDIA_API_KEY, NVIDIA_BASE_URL, NVIDIA_MODELS, NVIDIA_MODEL, NVIDIA_AGENT_MODEL };
