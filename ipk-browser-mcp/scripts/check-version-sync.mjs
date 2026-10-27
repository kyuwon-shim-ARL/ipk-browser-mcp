#!/usr/bin/env node
/**
 * Fails when the plugin version disagrees across the three files that carry it:
 * .claude-plugin/plugin.json (what the update notice compares against),
 * .claude-plugin/marketplace.json, and ipk-browser-mcp/package.json (baked into the
 * build as __PACKAGE_VERSION__, the installed version the notice reports).
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import * as path from "path";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function readVersions(root = repo) {
  const read = (p) => JSON.parse(readFileSync(path.join(root, p), "utf8"));
  return {
    ".claude-plugin/plugin.json": read(".claude-plugin/plugin.json").version,
    ".claude-plugin/marketplace.json": read(".claude-plugin/marketplace.json").plugins.find((p) => p.name === "ipk-browser-mcp")?.version,
    "ipk-browser-mcp/package.json": read("ipk-browser-mcp/package.json").version,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const versions = readVersions();
  if (new Set(Object.values(versions)).size !== 1) {
    console.error("FAIL: plugin versions disagree:", JSON.stringify(versions, null, 2));
    process.exit(1);
  }
  console.log(`PASS: version ${Object.values(versions)[0]} in all three files`);
}
