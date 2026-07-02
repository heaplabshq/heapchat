/* Thin adapter: wires the admin-configured NVIDIA key/base URL (src/state/server-settings.js)
   into the generic OpenAI-compatible client (src/llm/openai-compat.js). This is the pattern a
   future provider (OpenAI, Together, ...) would copy — same 4 functions, same shapes, just a
   different config source. Everything else in the codebase calls THIS module by name, so nothing
   else needs to know the transport underneath is shared/generic. */
const openaiCompat = require("./openai-compat");
const serverSettings = require("../state/server-settings");

function cfg() {
  const { apiKey, baseUrl } = serverSettings.getNvidiaConfig();
  if (!apiKey) throw new Error("NVIDIA_API_KEY is not configured");
  return { apiKey, baseUrl };
}

// completeJSON/completeText match ollama.js's contract: never throw, return null/"" on any
// failure (including "key not configured") — callers rely on that instead of a try/catch.
const completeJSON = (model, sys, user, maxTokens) => { try { return openaiCompat.completeJSON(model, sys, user, maxTokens, cfg()); } catch { return Promise.resolve(null); } };
const completeText = (model, sys, user, maxTokens, temperature) => { try { return openaiCompat.completeText(model, sys, user, maxTokens, temperature, cfg()); } catch { return Promise.resolve(""); } };
// streaming/tool-calling turns: their call sites (callModel in server.js, runAgentTurn in
// core.js) already wrap these in their own try/catch, so let a config error surface normally.
const streamChatTurn = (args) => openaiCompat.streamChatTurn({ ...args, ...cfg() });
const completeWithTools = (args) => openaiCompat.completeWithTools({ ...args, ...cfg() });

module.exports = { completeJSON, completeText, streamChatTurn, completeWithTools };
