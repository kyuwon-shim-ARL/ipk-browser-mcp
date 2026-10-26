/**
 * Shim: MCP server, stdio transport, config and the SessionManager (the logged-in
 * browser). Tool handlers live in dist/handlers.mjs (src/handlers.ts), which is
 * re-imported when it changes, so `npm run build` takes effect on the next tool call
 * without a /mcp reconnect while the browser session survives. Do not import
 * src/tools/** here - anything imported here is frozen until reconnect.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fileURLToPath } from "url";

import { loadConfig } from "./types.js";
import { SessionManager } from "./browser/session.js";
import { HandlerReloader, dispatchToolCall, toolFingerprint, type Registration } from "./hot-reload.js";

declare const __PACKAGE_VERSION__: string;

const config = loadConfig();
const sessionManager = new SessionManager(config);
const ctx = { sessionManager, config };

const reloader = new HandlerReloader(fileURLToPath(new URL("./handlers.mjs", import.meta.url)));
const initial = await reloader.load();
initial.startup?.(ctx);

const server = new McpServer({
  name: "ipk-browser",
  version: __PACKAGE_VERSION__,
});

for (const def of initial.tools) {
  const fp = toolFingerprint(def);
  const reg: Registration = { connectFp: fp, currentFp: fp };
  const registered = server.tool(def.name, def.description, def.schema as any, async (params: unknown) =>
    dispatchToolCall(def.name, params, reloader, ctx, reg)
  );
  reg.update = (u) => registered.update({ description: u.description, paramsSchema: u.paramsSchema as any });
}

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
