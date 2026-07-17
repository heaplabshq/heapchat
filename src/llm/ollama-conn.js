/* The live (admin-editable, no-restart) Ollama connection — base URL + optional API key,
   sourced from src/state/server-settings.js with the .env OLLAMA_URL as the fallback default.
   Every module that talks to Ollama directly (ollama.js, vision.js, rag/index.js, agent/core.js,
   server.js) should call baseUrl()/headers() here instead of importing the OLLAMA_URL constant,
   so an admin changing the connection in Settings takes effect immediately, everywhere. */
const serverSettings = require("../state/server-settings");

function baseUrl() { return serverSettings.getOllamaConfig().baseUrl; }
function headers(extra) {
  const { apiKey } = serverSettings.getOllamaConfig();
  return { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), ...extra };
}

module.exports = { baseUrl, headers };
