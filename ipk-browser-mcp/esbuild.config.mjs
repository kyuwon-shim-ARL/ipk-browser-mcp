import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "fs";

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "dist/ipk-browser-mcp.mjs",
  external: ["playwright"],
  sourcemap: process.env.DEV === "true",
  minify: false,
  define: {
    __PACKAGE_VERSION__: JSON.stringify(pkg.version),
  },
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
});

// Copy form-registry.json to dist/ for Python bridge consumption
if (!existsSync("dist")) mkdirSync("dist", { recursive: true });
copyFileSync("src/form-registry.json", "dist/form-registry.json");

console.log("Build complete: dist/ipk-browser-mcp.mjs");
console.log("Copied: dist/form-registry.json");
