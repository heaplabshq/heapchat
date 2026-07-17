/* Generic client for any OpenAI-wire-compatible chat API (NVIDIA's integrate.api.nvidia.com
   today; anything else that speaks the same chat-completions format — OpenAI itself, Together,
   Groq, Fireworks, DeepSeek, etc. — later), via the official `openai` SDK. Every function takes
   `{ apiKey, baseUrl }` explicitly rather than looking up a specific provider's config, so this
   module has no idea which providers exist; see src/llm/providers.js for that adapter.

   NOTE: this is NOT a fit for Anthropic/Claude — the Messages API isn't wire-compatible with
   OpenAI's chat-completions format (different content-block/tool_use/streaming-event shapes), so
   Claude support would need its own client, not a {apiKey,baseUrl} swap on this one. */
const { stripThink } = require("../util/text");

const clients = new Map();   // cacheKey ("apiKey|baseUrl") -> OpenAI client instance
function getClient(apiKey, baseUrl) {
  if (!apiKey) throw new Error("No API key configured for this provider");
  const cacheKey = apiKey + "|" + baseUrl;
  if (!clients.has(cacheKey)) {
    const OpenAI = require("openai");
    clients.set(cacheKey, new OpenAI({ apiKey, baseURL: baseUrl }));
    if (clients.size > 8) clients.delete(clients.keys().next().value);   // small LRU-ish cap; a handful of live configs is plenty
  }
  return clients.get(cacheKey);
}

async function completeJSON(model, sys, user, maxTokens = 300, { apiKey, baseUrl } = {}) {
  try {
    const r = await getClient(apiKey, baseUrl).chat.completions.create({
      model, temperature: 0, max_tokens: maxTokens,
      messages: [{ role: "system", content: sys }, { role: "user", content: user }],
    });
    const txt = (r.choices[0] && r.choices[0].message && r.choices[0].message.content) || "";
    const mm = stripThink(txt).match(/\{[\s\S]*\}/) || txt.match(/\{[\s\S]*\}/);
    return mm ? JSON.parse(mm[0]) : null;
  } catch { return null; }
}

async function completeText(model, sys, user, maxTokens = 600, temperature = 0.3, { apiKey, baseUrl } = {}) {
  try {
    const r = await getClient(apiKey, baseUrl).chat.completions.create({
      model, temperature, max_tokens: maxTokens,
      messages: [{ role: "system", content: sys }, { role: "user", content: user }],
    });
    return stripThink((r.choices[0] && r.choices[0].message && r.choices[0].message.content) || "");
  } catch { return ""; }
}

// Streaming turn with optional tool-calling. `messages` are plain {role, content, tool_calls?,
// tool_call_id?} objects — same shape the Ollama path already builds, since OpenAI's chat
// message roles (system/user/assistant/tool) are a superset of what we already construct.
// onContent/onThinking fire per chunk (thinking = the `reasoning_content` field some
// OpenAI-compatible reasoning models emit); onContext(usedTokens) fires once, from the final
// usage chunk, for the composer's context meter.
async function streamChatTurn({ model, messages, tools, temperature, maxTokens, topP, apiKey, baseUrl, onContent, onThinking, onContext }) {
  const stream = await getClient(apiKey, baseUrl).chat.completions.create({
    model, messages, temperature, top_p: topP, max_tokens: maxTokens,
    ...(tools && tools.length ? { tools } : {}),
    stream: true,
    stream_options: { include_usage: true },
  });
  let content = "", thinking = "", doneReason = "";
  const toolAcc = [];   // index -> accumulated {id, function:{name, arguments}} (streamed tool-call args arrive as string fragments)
  for await (const chunk of stream) {
    if (chunk.usage && onContext) onContext(chunk.usage.prompt_tokens || 0);
    const choice = chunk.choices && chunk.choices[0];
    if (!choice) continue;
    const delta = choice.delta || {};
    if (delta.content) { content += delta.content; onContent && onContent(delta.content); }
    if (delta.reasoning_content) { thinking += delta.reasoning_content; onThinking && onThinking(delta.reasoning_content); }
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const i = tc.index || 0;
        if (!toolAcc[i]) toolAcc[i] = { id: "", function: { name: "", arguments: "" } };
        if (tc.id) toolAcc[i].id = tc.id;
        if (tc.function && tc.function.name) toolAcc[i].function.name += tc.function.name;
        if (tc.function && tc.function.arguments) toolAcc[i].function.arguments += tc.function.arguments;
      }
    }
    if (choice.finish_reason) doneReason = choice.finish_reason === "length" ? "length" : choice.finish_reason;
  }
  const toolCalls = toolAcc.filter(Boolean).map(t => ({ id: t.id, type: "function", function: { name: t.function.name, arguments: t.function.arguments } }));
  return { content, toolCalls, thinking, doneReason };
}

// Non-streaming turn with optional tool-calling — for the deep-work roster's per-specialist turns
// (runAgentTurn in core.js), which call Ollama non-streaming today (stream:false) too, so this is
// a like-for-like swap, not a UX regression. Same normalized { content, toolCalls } shape as
// streamChatTurn, minus the streaming-only fields.
async function completeWithTools({ model, messages, tools, temperature, maxTokens, apiKey, baseUrl }) {
  const r = await getClient(apiKey, baseUrl).chat.completions.create({
    model, messages, temperature, max_tokens: maxTokens,
    ...(tools && tools.length ? { tools } : {}),
  });
  const m = (r.choices[0] && r.choices[0].message) || {};
  const toolCalls = (m.tool_calls || []).map(tc => ({ id: tc.id, type: "function", function: { name: tc.function.name, arguments: tc.function.arguments } }));
  return { content: stripThink(m.content || ""), toolCalls };
}

module.exports = { completeJSON, completeText, streamChatTurn, completeWithTools };
