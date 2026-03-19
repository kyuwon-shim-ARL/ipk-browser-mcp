#!/usr/bin/env node
/**
 * Ensures playwright is installed in the ipk-browser-mcp subdirectory.
 * Runs on SessionStart - checks once, skips if already installed.
 */
import { existsSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(__dirname, "..");
const mcpDir = join(pluginRoot, "ipk-browser-mcp");
const playwrightDir = join(mcpDir, "node_modules", "playwright");

if (existsSync(playwrightDir)) {
  process.exit(0);
}

console.error("[ipk-browser-mcp] Installing playwright dependency...");
try {
  execSync("npm install --production --ignore-scripts", { cwd: mcpDir, stdio: "pipe" });
  execSync("npx playwright install chromium", { cwd: mcpDir, stdio: "pipe" });
  console.error("[ipk-browser-mcp] Setup complete.");
} catch (err) {
  console.error("[ipk-browser-mcp] Auto-setup failed. Run manually:");
  console.error(`  cd ${mcpDir} && npm install --production && npx playwright install chromium`);
  process.exit(1);
}
