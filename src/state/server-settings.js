/* Global (not per-user) admin-editable server settings — persisted to data/server.json.
   Distinct from src/config.js (loaded once from .env at startup) and from each user's own
   data/users/<id>/settings.json (per-user, client-driven preferences). This is the one place
   an admin can change server-wide behavior LIVE from the UI, without touching .env or
   restarting: LAN access, the built-in Ollama connection (base URL / optional API key), and
   any number of OpenAI-compatible provider connections (NVIDIA, OpenAI, Groq, a local vLLM,
   ...). .env values remain the fallback default when nothing's been set here. */
const fs = require("fs");
const path = require("path");
const { writeJSONAtomic } = require("../util/json-store");
const { DATA_DIR, HOST, OLLAMA_URL, NVIDIA_API_KEY, NVIDIA_BASE_URL, NVIDIA_MODELS, NVIDIA_AGENT_MODEL } = require("../config");

const FILE = path.join(DATA_DIR, "server.json");
let cfg = null;
try { cfg = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch {}
if (!cfg || typeof cfg !== "object") cfg = {};
if (typeof cfg.lanAccess !== "boolean") cfg.lanAccess = HOST !== "127.0.0.1" && HOST !== "localhost";
if (!cfg.ollama || typeof cfg.ollama !== "object") cfg.ollama = {};
if (!Array.isArray(cfg.providers)) cfg.providers = [];

// one-time migration: fold the old single-slot NVIDIA_* fields into the generic providers list,
// so an existing install upgrading onto this keeps its NVIDIA connection working unchanged.
if ((cfg.nvidiaApiKey || cfg.nvidiaBaseUrl || cfg.nvidiaModels || cfg.nvidiaAgentModel) && !cfg.providers.some(p => p.id === "nvidia")) {
  const models = (Array.isArray(cfg.nvidiaModels) && cfg.nvidiaModels.length) ? cfg.nvidiaModels : NVIDIA_MODELS;
  cfg.providers.push({
    id: "nvidia", name: "NVIDIA", baseUrl: cfg.nvidiaBaseUrl || NVIDIA_BASE_URL,
    apiKey: cfg.nvidiaApiKey || NVIDIA_API_KEY || "",
    models, agentModel: cfg.nvidiaAgentModel || NVIDIA_AGENT_MODEL || models[0] || "",
  });
}
delete cfg.nvidiaApiKey; delete cfg.nvidiaBaseUrl; delete cfg.nvidiaModels; delete cfg.nvidiaAgentModel;

function persist() { try { writeJSONAtomic(FILE, cfg); } catch {} }
persist();   // write back once so the migration (if any) lands on disk immediately

function get() { return cfg; }

function update(patch) {
  cfg = { ...cfg, ...patch };
  persist();
  return cfg;
}

// ---- the built-in Ollama connection: always exists, never deletable, id "ollama" ----
function getOllamaConfig() {
  const baseUrl = (cfg.ollama.baseUrl || OLLAMA_URL).replace(/\/+$/, "");
  const apiKey = cfg.ollama.apiKey || "";
  return { baseUrl, apiKey };
}
function updateOllama(patch) {
  cfg.ollama = { ...cfg.ollama, ...patch };
  persist();
  return getOllamaConfig();
}

// ---- generic OpenAI-compatible provider connections ----
function slugify(name) {
  const base = String(name || "provider").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "provider";
  let id = base, n = 2;
  while (cfg.providers.some(p => p.id === id)) id = `${base}-${n++}`;
  return id;
}
function listProviders() { return cfg.providers; }
function getProvider(id) { return cfg.providers.find(p => p.id === id) || null; }
function createProvider({ name, baseUrl, apiKey = "", models = [], agentModel = "" }) {
  const p = { id: slugify(name), name: String(name).trim(), baseUrl: String(baseUrl).replace(/\/+$/, ""), apiKey, models, agentModel: agentModel || models[0] || "" };
  cfg.providers.push(p);
  persist();
  return p;
}
function updateProvider(id, patch) {
  const i = cfg.providers.findIndex(p => p.id === id);
  if (i < 0) return null;
  cfg.providers[i] = { ...cfg.providers[i], ...patch };
  persist();
  return cfg.providers[i];
}
function deleteProvider(id) {
  cfg.providers = cfg.providers.filter(p => p.id !== id);
  persist();
}

module.exports = { get, update, getOllamaConfig, updateOllama, listProviders, getProvider, createProvider, updateProvider, deleteProvider, FILE };
