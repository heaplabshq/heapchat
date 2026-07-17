/* Provider dispatch for the handful of call sites that use a USER-SELECTED model (the chat/agent
   model picker, custom agents' model override) rather than a fixed internal OLLAMA_MODEL constant.
   Background/system tasks (memory extraction, profile building, auto-tag, smart-rename, title
   generation) stay on ollama.js directly and are unaffected — they always run on the local model
   regardless of which provider the user picked for their chat, by design.

   Any number of OpenAI-compatible provider connections can be configured (see
   src/state/server-settings.js), each addressed with its own id as a prefix in the model string
   (e.g. "nvidia/z-ai/glm-5.2", "groq/llama-3.3-70b") so every existing string-typed `model` field
   (custom agents, saved settings, the composer's model picker) keeps working unchanged — no schema
   migration needed. A model with no matching provider prefix is assumed to be a local Ollama model. */
const ollama = require("./ollama");
const providers = require("./providers");
const serverSettings = require("../state/server-settings");

function providerOf(model) {
  if (typeof model !== "string") return "ollama";
  const hit = serverSettings.listProviders().find(p => model.startsWith(p.id + "/"));
  return hit ? hit.id : "ollama";
}
function bareModel(model) {
  const pid = providerOf(model);
  return pid === "ollama" ? model : model.slice(pid.length + 1);
}

function completeJSON(model, sys, user, maxTokens) {
  const pid = providerOf(model);
  return pid === "ollama" ? ollama.completeJSON(model, sys, user, maxTokens) : providers.completeJSON(pid, bareModel(model), sys, user, maxTokens);
}
function completeText(model, sys, user, maxTokens, temperature) {
  const pid = providerOf(model);
  return pid === "ollama" ? ollama.completeText(model, sys, user, maxTokens, temperature) : providers.completeText(pid, bareModel(model), sys, user, maxTokens, temperature);
}

module.exports = { providerOf, bareModel, completeJSON, completeText };
