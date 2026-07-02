/* Non-streaming completions against the local Ollama chat API.
   completeJSON → parsed JSON object (or null); completeText → plain text.
   Both size num_ctx to the prompt (fitCtx) and strip <think> blocks. */
const { OLLAMA_URL, OLLAMA_KEEP_ALIVE } = require("../config");
const { stripThink, fitCtx } = require("../util/text");

// one non-streaming model call that returns parsed JSON (or null)
async function completeJSON(model, sys, user, maxTokens = 300) {
  try {
    const up = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keep_alive: OLLAMA_KEEP_ALIVE, model, stream: false, think: false, messages: [{ role: "system", content: sys }, { role: "user", content: user }], options: { temperature: 0, num_predict: maxTokens, num_ctx: fitCtx(sys, user, maxTokens) } }),
    });
    if (!up.ok) return null;
    const j = await up.json();
    const txt = (j.message && j.message.content) || "";
    // strip <think> blocks first — they may contain stray braces that corrupt the JSON match
    const mm = stripThink(txt).match(/\{[\s\S]*\}/) || txt.match(/\{[\s\S]*\}/);
    return mm ? JSON.parse(mm[0]) : null;
  } catch { return null; }
}
// a single non-streaming text completion
async function completeText(model, sys, user, maxTokens = 600, temperature = 0.3) {
  try {
    const up = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keep_alive: OLLAMA_KEEP_ALIVE, model, stream: false, think: false, messages: [{ role: "system", content: sys }, { role: "user", content: user }], options: { temperature, num_predict: maxTokens, num_ctx: fitCtx(sys, user, maxTokens) } }),
    });
    if (!up.ok) return "";
    const j = await up.json();
    return stripThink((j.message && j.message.content) || "");
  } catch { return ""; }
}

module.exports = { completeJSON, completeText };
