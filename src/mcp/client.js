/* ============================================================
   MCP connectors (per user) — remote MCP servers the agent can call as tools.
   Persistent clients are cached per user+server and reused across turns; many
   servers (e.g. Kite) tie auth/login to a session id, which we persist to disk
   and resume on reconnect. (The SDK is ESM-only → dynamic import.)
   ============================================================ */
const { storesFor } = require("../state/user-stores");

function mcpEnabled(user) { return user ? storesFor(user).mcp.filter(s => s.enabled) : []; }
function mcpPublic(s) { return { id: s.id, name: s.name, url: s.url, enabled: !!s.enabled, hasAuth: !!s.authHeader }; }

// StreamableHTTP servers (e.g. Kite) tie the user's login to a session id. Persist it to disk and
// resume it on connect, so a server restart doesn't force a re-login until the broker expires it.
function rememberSession(user, id, sid) { const st = storesFor(user); if (sid && st.mcpSessions[id] !== sid) { st.mcpSessions[id] = sid; st.save("mcp-sessions.json"); } }
function forgetSession(user, id) { const st = storesFor(user); if (st.mcpSessions[id]) { delete st.mcpSessions[id]; st.save("mcp-sessions.json"); } }

async function mcpConnect(user, server) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const reqInit = server.authHeader ? { requestInit: { headers: { Authorization: server.authHeader } } } : {};
  const saved = storesFor(user).mcpSessions[server.id];
  // 1) resume the saved session (keeps Kite login), 2) fresh StreamableHTTP, 3) SSE
  const attempts = saved ? [{ sessionId: saved, resume: true }, {}] : [{}];
  for (const a of attempts) {
    const client = new Client({ name: "cortex", version: "1.0.0" }, { capabilities: {} });
    try {
      const transport = new StreamableHTTPClientTransport(new URL(server.url), { ...reqInit, ...(a.sessionId ? { sessionId: a.sessionId } : {}) });
      await client.connect(transport);
      rememberSession(user, server.id, transport.sessionId);
      if (a.resume) console.log(`[mcp] resumed session for ${server.name}`);
      return client;
    } catch (e) {
      await client.close().catch(() => {});
      if (a.resume) { forgetSession(user, server.id); console.log(`[mcp] saved session for ${server.name} stale — reconnecting fresh`); }
    }
  }
  // SSE fallback (servers that don't speak StreamableHTTP)
  const client = new Client({ name: "cortex", version: "1.0.0" }, { capabilities: {} });
  const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
  await client.connect(new SSEClientTransport(new URL(server.url), reqInit));
  return client;
}
// Persistent clients — many MCP servers (e.g. Kite) tie auth/login to the session,
// so we keep one live connection per user+connector and reuse it across calls/turns.
const mcpClients = new Map();   // "userId:serverId" -> client
async function getMcpClient(user, server) {
  const key = user.id + ":" + server.id;
  const ex = mcpClients.get(key);
  if (ex) return ex;
  const client = await mcpConnect(user, server);
  client.onclose = () => { if (mcpClients.get(key) === client) mcpClients.delete(key); };
  mcpClients.set(key, client);
  return client;
}
function dropMcpClient(user, id) { const key = user.id + ":" + id; const c = mcpClients.get(key); if (c) { c.close().catch(() => {}); mcpClients.delete(key); } }
// run an op on the cached client; if the connection is stale, reconnect once and retry
async function withMcp(user, server, fn) {
  try { return await fn(await getMcpClient(user, server)); }
  catch (e) { dropMcpClient(user, server.id); return await fn(await getMcpClient(user, server)); }
}
async function mcpListTools(user, server) {
  return withMcp(user, server, async c => { const r = await c.listTools(); return (r.tools || []).map(t => ({ name: t.name, description: t.description || "" })); });
}
async function mcpCallTool(user, server, toolName, args) {
  return withMcp(user, server, async c => {
    const r = await c.callTool({ name: toolName, arguments: args || {} });
    return (r.content || []).map(p => p.type === "text" ? p.text : p.type === "image" ? "[image]" : JSON.stringify(p)).join("\n") || JSON.stringify(r);
  });
}

module.exports = {
  mcpEnabled, mcpPublic, rememberSession, forgetSession, mcpConnect,
  getMcpClient, dropMcpClient, withMcp, mcpListTools, mcpCallTool, mcpClients,
};
