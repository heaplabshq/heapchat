/* ============================================================
   MCP server mode — exposes a curated subset of the agent's knowledge-base tools
   at /mcp so any MCP client (Claude Desktop, Claude Code, …) can search and read
   a user's KB. Stateless Streamable-HTTP: each POST builds a fresh server +
   transport (wired up in server.js). Every call is scoped to the bearer-token's
   user and their knowledge base.
   ============================================================ */
const { TOOL_REGISTRY, execTool } = require("../agent/core");
const { kbDirFor } = require("../state/user-stores");

const MCP_EXPOSED = ["search_docs", "find_text", "list_files", "read_file", "query_csv", "compare_files", "find_related", "image_tool", "save_note"];
async function makeMcpServer(user) {
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { ListToolsRequestSchema, CallToolRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
  const srv = new Server({ name: "cortex", version: "1.0.0" }, { capabilities: { tools: {} } });
  srv.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: MCP_EXPOSED.map(n => {
      const f = TOOL_REGISTRY[n].def.function;
      return { name: f.name, description: f.description, inputSchema: f.parameters || { type: "object", properties: {} } };
    }),
  }));
  srv.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    if (!MCP_EXPOSED.includes(name)) return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    const kb = kbDirFor(user);
    const ctx = { isFile: false, path: kb, key: kb, user, kbDir: kb };
    const { result } = await execTool(name, req.params.arguments || {}, ctx);
    return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }] };
  });
  return srv;
}

module.exports = { MCP_EXPOSED, makeMcpServer };
