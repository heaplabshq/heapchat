/* Global runtime config — the single place that reads process.env for server-wide
   settings. Loaded before anything else. */
require("dotenv").config();
const path = require("path");

// repo root (this file lives in <root>/src). User data lives next to the source by
// default, but the desktop wrapper points CORTEX_DATA_DIR at a writable per-user
// location (the packaged app folder is read-only).
const ROOT = path.join(__dirname, "..");
const DATA_DIR = process.env.CORTEX_DATA_DIR ? path.resolve(process.env.CORTEX_DATA_DIR) : path.join(ROOT, "data");

const PORT = process.env.PORT || 5174;
const HOST = process.env.HOST || "127.0.0.1";   // initial default only — admins toggle network access live in Settings (data/server.json wins)
const OLLAMA_URL = (process.env.OLLAMA_URL || "http://localhost:11434").replace(/\/+$/, "");
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.1:8b";
const OLLAMA_VISION_MODEL = process.env.OLLAMA_VISION_MODEL || OLLAMA_MODEL;
const OLLAMA_AGENT_MODEL = process.env.OLLAMA_AGENT_MODEL || OLLAMA_MODEL;
const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || "30m";   // keep models resident between requests — kills the cold-load stall

module.exports = { ROOT, DATA_DIR, PORT, HOST, OLLAMA_URL, OLLAMA_MODEL, OLLAMA_VISION_MODEL, OLLAMA_AGENT_MODEL, OLLAMA_KEEP_ALIVE };
