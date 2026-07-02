/* Global (not per-user) admin-editable server settings — persisted to data/server.json.
   Distinct from src/config.js (loaded once from .env at startup) and from each user's own
   data/users/<id>/settings.json (per-user, client-driven preferences). This is the one place
   an admin can change server-wide behavior LIVE from the UI, without touching .env or
   restarting: LAN access (existing) and the NVIDIA provider's API key/base URL/model
   allowlist (new). .env values remain the fallback default when nothing's been set here. */
const fs = require("fs");
const path = require("path");
const { writeJSONAtomic } = require("../util/json-store");
const { DATA_DIR, HOST, NVIDIA_API_KEY, NVIDIA_BASE_URL, NVIDIA_MODELS, NVIDIA_MODEL, NVIDIA_AGENT_MODEL } = require("../config");

const FILE = path.join(DATA_DIR, "server.json");
let cfg = null;
try { cfg = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch {}
if (!cfg || typeof cfg !== "object") cfg = {};
if (typeof cfg.lanAccess !== "boolean") cfg.lanAccess = HOST !== "127.0.0.1" && HOST !== "localhost";

function get() { return cfg; }

function update(patch) {
  cfg = { ...cfg, ...patch };
  try { writeJSONAtomic(FILE, cfg); } catch {}
  return cfg;
}

// merges the live admin-set NVIDIA config over the .env-loaded defaults — nothing set here yet
// (fresh install) behaves exactly like before this feature existed.
function getNvidiaConfig() {
  const apiKey = cfg.nvidiaApiKey || NVIDIA_API_KEY || "";
  const baseUrl = cfg.nvidiaBaseUrl || NVIDIA_BASE_URL;
  const models = (Array.isArray(cfg.nvidiaModels) && cfg.nvidiaModels.length) ? cfg.nvidiaModels : NVIDIA_MODELS;
  const agentModel = cfg.nvidiaAgentModel || NVIDIA_AGENT_MODEL || models[0] || "";
  return { apiKey, baseUrl, models, agentModel, enabled: !!apiKey };
}

module.exports = { get, update, getNvidiaConfig, FILE };
