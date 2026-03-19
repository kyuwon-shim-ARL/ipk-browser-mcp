import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadConfig } from "./types.js";
import { SessionManager } from "./browser/session.js";

import { ipkLoginSchema, ipkLoginDescription, handleIpkLogin } from "./tools/ipk-login.js";
import { ipkSubmitFormSchema, ipkSubmitFormDescription, handleIpkSubmitForm } from "./tools/ipk-submit.js";
import { ipkFetchApprovalsSchema, ipkFetchApprovalsDescription, handleIpkFetchApprovals } from "./tools/ipk-fetch.js";
import { ipkNavigateSchema, ipkNavigateDescription, handleIpkNavigate } from "./tools/ipk-navigate.js";
import { ipkGetContentSchema, ipkGetContentDescription, handleIpkGetContent } from "./tools/ipk-content.js";
import { screenshotSchema, screenshotDescription, handleScreenshot, cleanupExpiredScreenshots } from "./tools/screenshot.js";

const config = loadConfig();
const sessionManager = new SessionManager(config);

// Clean up old screenshots on startup
cleanupExpiredScreenshots(config);

const server = new McpServer({
  name: "ipk-browser",
  version: "0.1.0",
});

// Tool 1: ipk_login
server.tool("ipk_login", ipkLoginDescription, ipkLoginSchema, async (params) => {
  return handleIpkLogin(sessionManager, params);
});

// Tool 2: ipk_submit_form
server.tool("ipk_submit_form", ipkSubmitFormDescription, ipkSubmitFormSchema, async (params) => {
  return handleIpkSubmitForm(sessionManager, config, params as Record<string, any>);
});

// Tool 3: ipk_fetch_approvals
server.tool("ipk_fetch_approvals", ipkFetchApprovalsDescription, ipkFetchApprovalsSchema, async (params) => {
  return handleIpkFetchApprovals(sessionManager, config, params);
});

// Tool 4: ipk_navigate
server.tool("ipk_navigate", ipkNavigateDescription, ipkNavigateSchema, async (params) => {
  return handleIpkNavigate(sessionManager, config, params);
});

// Tool 5: ipk_get_content
server.tool("ipk_get_content", ipkGetContentDescription, ipkGetContentSchema, async (params) => {
  return handleIpkGetContent(sessionManager, config, params);
});

// Tool 6: screenshot
server.tool("screenshot", screenshotDescription, screenshotSchema, async (params) => {
  return handleScreenshot(sessionManager, config, params);
});

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
