import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "fs";

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));

const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  external: ["playwright"],
  sourcemap: process.env.DEV === "true",
  minify: false,
  define: {
    __PACKAGE_VERSION__: JSON.stringify(pkg.version),
  },
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
};

// Handlers bundle first: the shim imports it at startup. A running shim re-imports it when its
// mtime changes, so write to a temp file and rename - a half-written file is never imported.
const handlersTmp = `dist/.handlers.${process.pid}.tmp.mjs`;
try {
  await build({ ...common, entryPoints: ["src/handlers.ts"], outfile: handlersTmp });
  renameSync(handlersTmp, "dist/handlers.mjs");
} finally {
  rmSync(handlersTmp, { force: true });
}

// Shim: MCP server, transport, SessionManager. Changes here need a /mcp reconnect.
await build({ ...common, entryPoints: ["src/index.ts"], outfile: "dist/ipk-browser-mcp.mjs" });

// Copy form-registry.json to dist/ for Python bridge consumption
if (!existsSync("dist")) mkdirSync("dist", { recursive: true });
copyFileSync("src/form-registry.json", "dist/form-registry.json");

console.log("Build complete: dist/ipk-browser-mcp.mjs (shim), dist/handlers.mjs (hot-reloaded handlers)");
console.log("Copied: dist/form-registry.json");
