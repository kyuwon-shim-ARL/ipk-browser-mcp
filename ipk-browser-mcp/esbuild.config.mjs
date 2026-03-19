import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "dist/ipk-browser-mcp.mjs",
  external: ["playwright"],
  sourcemap: true,
  minify: false,
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
});

console.log("Build complete: dist/ipk-browser-mcp.mjs");
