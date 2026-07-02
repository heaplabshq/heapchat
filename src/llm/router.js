/* Provider dispatch for the handful of call sites that use a USER-SELECTED model (the chat/agent
   model picker, custom agents' model override) rather than a fixed internal OLLAMA_MODEL constant.
   Background/system tasks (memory extraction, profile building, auto-tag, smart-rename, title
   generation) stay on ollama.js directly and are unaffected — they always run on the local model
   regardless of which provider the user picked for their chat, by design.

   NVIDIA models are addressed with a synthetic "nvidia/" prefix in the model string (e.g.
   "nvidia/z-ai/glm-5.2") so every existing string-typed `model` field (custom agents, saved
   settings, the composer's model picker) keeps working unchanged — no schema migration needed.
   NVIDIA model ids already contain their own "/", so stripping just the leading "nvidia/" yields
   the real id back. */
const ollama = require("./ollama");
const nvidia = require("./nvidia");

const PREFIX = "nvidia/";
function providerOf(model) { return typeof model === "string" && model.startsWith(PREFIX) ? "nvidia" : "ollama"; }
function bareModel(model) { return providerOf(model) === "nvidia" ? model.slice(PREFIX.length) : model; }

function completeJSON(model, sys, user, maxTokens) {
  return providerOf(model) === "nvidia"
    ? nvidia.completeJSON(bareModel(model), sys, user, maxTokens)
    : ollama.completeJSON(model, sys, user, maxTokens);
}
function completeText(model, sys, user, maxTokens, temperature) {
  return providerOf(model) === "nvidia"
    ? nvidia.completeText(bareModel(model), sys, user, maxTokens, temperature)
    : ollama.completeText(model, sys, user, maxTokens, temperature);
}

module.exports = { providerOf, bareModel, completeJSON, completeText };
