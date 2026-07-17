/* Thin adapter: wires an admin-configured OpenAI-compatible provider connection
   (src/state/server-settings.js) into the generic OpenAI-compatible client
   (src/llm/openai-compat.js), by provider id. Any number of connections can exist (NVIDIA,
   OpenAI, Groq, a local vLLM, ...) — this module has no idea which ones do; see
   src/llm/router.js for how a model string like "nvidia/z-ai/glm-5.2" resolves to a provider id
   + bare model. */
const openaiCompat = require("./openai-compat");
const serverSettings = require("../state/server-settings");

function cfgFor(id) {
  const p = serverSettings.getProvider(id);
  if (!p || !p.apiKey) throw new Error(`Provider "${id}" is not configured`);
  return { apiKey: p.apiKey, baseUrl: p.baseUrl };
}

// completeJSON/completeText match ollama.js's contract: never throw, return null/"" on any
// failure (including "not configured") — callers rely on that instead of a try/catch.
const completeJSON = (id, model, sys, user, maxTokens) => { try { return openaiCompat.completeJSON(model, sys, user, maxTokens, cfgFor(id)); } catch { return Promise.resolve(null); } };
const completeText = (id, model, sys, user, maxTokens, temperature) => { try { return openaiCompat.completeText(model, sys, user, maxTokens, temperature, cfgFor(id)); } catch { return Promise.resolve(""); } };
// streaming/tool-calling turns: their call sites (callModel in server.js, runAgentTurn in
// core.js) already wrap these in their own try/catch, so let a config error surface normally.
const streamChatTurn = (id, args) => openaiCompat.streamChatTurn({ ...args, ...cfgFor(id) });
const completeWithTools = (id, args) => openaiCompat.completeWithTools({ ...args, ...cfgFor(id) });

module.exports = { completeJSON, completeText, streamChatTurn, completeWithTools };
