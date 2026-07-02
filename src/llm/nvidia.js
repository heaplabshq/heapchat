/* NVIDIA's OpenAI-compatible chat API (integrate.api.nvidia.com), via the official `openai`
   SDK. Mirrors ollama.js's completeJSON/completeText for internal helper calls, plus
   streamChatTurn for the main agent loop's streaming + tool-calling turns — normalized to the
   exact same { content, toolCalls, thinking, doneReason } contract callModel() already returns
   for Ollama, so the rest of the agent loop doesn't need to know which provider answered. */
const { stripThink } = require("../util/text");
const serverSettings = require("../state/server-settings");

// cache the client, but re-create it if the admin changes the key/URL live from Settings —
// no server restart needed for that to take effect.
let client = null, clientKey = "";
function getClient() {
  const { apiKey, baseUrl } = serverSettings.getNvidiaConfig();
  if (!apiKey) throw new Error("NVIDIA_API_KEY is not configured");
  const cacheKey = apiKey + "|" + baseUrl;
  if (!client || clientKey !== cacheKey) {
    const OpenAI = require("openai");
    client = new OpenAI({ apiKey, baseURL: baseUrl });
    clientKey = cacheKey;
  }
  return client;
}

async function completeJSON(model, sys, user, maxTokens = 300) {
  try {
    const r = await getClient().chat.completions.create({
      model, temperature: 0, max_tokens: maxTokens,
      messages: [{ role: "system", content: sys }, { role: "user", content: user }],
    });
    const txt = (r.choices[0] && r.choices[0].message && r.choices[0].message.content) || "";
    const mm = stripThink(txt).match(/\{[\s\S]*\}/) || txt.match(/\{[\s\S]*\}/);
    return mm ? JSON.parse(mm[0]) : null;
  } catch { return null; }
}

async function completeText(model, sys, user, maxTokens = 600, temperature = 0.3) {
  try {
    const r = await getClient().chat.completions.create({
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
async function streamChatTurn({ model, messages, tools, temperature, maxTokens, topP, onContent, onThinking, onContext }) {
  const stream = await getClient().chat.completions.create({
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
async function completeWithTools({ model, messages, tools, temperature, maxTokens }) {
  const r = await getClient().chat.completions.create({
    model, messages, temperature, max_tokens: maxTokens,
    ...(tools && tools.length ? { tools } : {}),
  });
  const m = (r.choices[0] && r.choices[0].message) || {};
  const toolCalls = (m.tool_calls || []).map(tc => ({ id: tc.id, type: "function", function: { name: tc.function.name, arguments: tc.function.arguments } }));
  return { content: stripThink(m.content || ""), toolCalls };
}

module.exports = { completeJSON, completeText, streamChatTurn, completeWithTools };
