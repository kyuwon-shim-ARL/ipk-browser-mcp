import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import {
  HandlerReloader,
  dispatchToolCall,
  toolFingerprint,
  PARAMS_CHANGED_NOTE,
  SHIM_API_VERSION,
  type Registration,
} from "../src/hot-reload.js";

let dir: string;
let file: string;
let tick = 1_700_000_000;

/** Write a fixture handlers module and give it a fresh, distinct mtime. */
function writeModule(body: string): void {
  fs.writeFileSync(file, body, "utf8");
  tick += 10;
  fs.utimesSync(file, tick, tick);
}

const mod = (version: string, schemaKeys: string[] = ["a"], description = "d") => `
export const SHIM_API = ${SHIM_API_VERSION};
const schema = { ${schemaKeys.map((k) => `${k}: { kind: "string" }`).join(", ")} };
export const tools = [
  { name: "echo", description: ${JSON.stringify(description)}, schema,
    handler: async (ctx, params) => ({ content: [{ type: "text", text: JSON.stringify({ v: ${JSON.stringify(version)}, ctx, params }) }] }) },
];
export function parseArgs(shape, args) {
  const data = {};
  for (const k of Object.keys(shape)) if (k in args) data[k] = args[k];
  if (args.bad) return { success: false, error: "bad arg" };
  return { success: true, data };
}
`;

const logs: string[] = [];
const log = (m: string) => logs.push(m);
const textOf = (r: any) => r.content.map((c: any) => c.text);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipk-hot-"));
  file = path.join(dir, "handlers.mjs");
  logs.length = 0;
});

/**
 * vitest intercepts import() and caches by path, ignoring the `?v=` buster that node
 * honours. Import a per-version copy instead - the built dist server is exercised
 * separately below, by actually spawning it over stdio.
 */
let copies = 0;
const testImporter = (url: string) => {
  const u = new URL(url);
  const copy = path.join(dir, `copy-${++copies}-${u.searchParams.get("v")}.mjs`);
  fs.copyFileSync(u.pathname, copy);
  return import(/* @vite-ignore */ copy);
};

async function setup(body = mod("v1")) {
  writeModule(body);
  const r = new HandlerReloader(file, log, testImporter);
  const m = await r.load();
  const fp = toolFingerprint(m.tools[0]);
  const updates: any[] = [];
  const reg: Registration = { connectFp: fp, currentFp: fp, update: (u) => updates.push(u) };
  return { r, reg, updates };
}

describe("HandlerReloader", () => {
  it("serves the loaded module while the file is unchanged", async () => {
    const { r } = await setup();
    const a = await r.current();
    const b = await r.current();
    expect(a.mod).toBe(b.mod);
    expect(logs).toEqual([]);
  });

  it("re-imports when mtime changes", async () => {
    const { r, reg } = await setup();
    writeModule(mod("v2"));
    const res = await dispatchToolCall("echo", { a: "x" }, r, { sm: 1 }, reg, log);
    expect(JSON.parse(textOf(res)[0]).v).toBe("v2");
    expect(logs.some((l) => l.includes("handlers reloaded"))).toBe(true);
  });

  it("keeps the previous module when the new one fails to import, and says so", async () => {
    const { r, reg } = await setup();
    writeModule("export const tools = [ this is not javascript");
    const res = await dispatchToolCall("echo", { a: "x" }, r, {}, reg, log);
    expect(JSON.parse(textOf(res)[0]).v).toBe("v1");
    expect(textOf(res).at(-1)).toMatch(/handlers reload failed/);
    expect(logs.some((l) => l.includes("reload FAILED"))).toBe(true);

    // a failed build is not retried on every call
    logs.length = 0;
    await r.current();
    expect(logs).toEqual([]);

    // a later good build is picked up
    writeModule(mod("v3"));
    const res2 = await dispatchToolCall("echo", { a: "x" }, r, {}, reg, log);
    expect(JSON.parse(textOf(res2)[0]).v).toBe("v3");
    expect(textOf(res2)).toHaveLength(1);
  });

  it("rejects a reloaded module built for a different SHIM_API and keeps the old one", async () => {
    const { r, reg } = await setup();
    writeModule(mod("v2").replace(`export const SHIM_API = ${SHIM_API_VERSION};`, "export const SHIM_API = 999;"));
    const res = await dispatchToolCall("echo", { a: "x" }, r, {}, reg, log);
    expect(JSON.parse(textOf(res)[0]).v).toBe("v1");
    expect(textOf(res).at(-1)).toMatch(/handlers reload failed/);
    expect(logs.some((l) => l.includes("different server version"))).toBe(true);
  });

  it("rejects an initial load built for a different SHIM_API", async () => {
    writeModule(mod("v1").replace(`export const SHIM_API = ${SHIM_API_VERSION};`, "export const SHIM_API = 999;"));
    const r = new HandlerReloader(file, log, testImporter);
    await expect(r.load()).rejects.toThrow(/different server version/);
  });

  it("rejects a module without a tools array and keeps the old one", async () => {
    const { r } = await setup();
    writeModule("export const nothing = 1;");
    const snap = await r.current();
    expect(snap.mod.tools[0].name).toBe("echo");
    expect(snap.reloadError).toMatch(/tools/);
  });

  it("concurrent calls during a reload share one import and all see the new module", async () => {
    const { r } = await setup();
    writeModule(mod("v2"));
    const snaps = await Promise.all([r.current(), r.current(), r.current()]);
    expect(new Set(snaps.map((s) => s.mod)).size).toBe(1);
    expect(logs.filter((l) => l.includes("handlers reloaded"))).toHaveLength(1);
  });

  it("passes the shim's context (session manager) to handlers", async () => {
    const { r, reg } = await setup();
    const res = await dispatchToolCall("echo", { a: "x" }, r, { sessionManager: "shim-instance" }, reg, log);
    expect(JSON.parse(textOf(res)[0]).ctx).toEqual({ sessionManager: "shim-instance" });
  });
});

describe("schema change after reload", () => {
  it("adds the reconnect note, warns, re-validates args, and updates the registration", async () => {
    const { r, reg, updates } = await setup();
    writeModule(mod("v2", ["a", "b"]));
    const res = await dispatchToolCall("echo", { a: "x", extra: 1 }, r, {}, reg, log);
    const texts = textOf(res);
    expect(JSON.parse(texts[0]).params).toEqual({ a: "x" });
    expect(texts.at(-1)).toBe(`note: ${PARAMS_CHANGED_NOTE}`);
    expect(logs.some((l) => l.includes("WARNING") && l.includes("echo"))).toBe(true);
    expect(updates).toHaveLength(1);
    expect(Object.keys(updates[0].paramsSchema)).toEqual(["a", "b"]);

    // later calls: no second warning/update, but the client still needs a reconnect
    logs.length = 0;
    const res2 = await dispatchToolCall("echo", { a: "y" }, r, {}, reg, log);
    expect(textOf(res2).at(-1)).toBe(`note: ${PARAMS_CHANGED_NOTE}`);
    expect(logs).toEqual([]);
    expect(updates).toHaveLength(1);
  });

  it("a description change also counts", async () => {
    const { r, reg } = await setup();
    writeModule(mod("v2", ["a"], "new description"));
    const res = await dispatchToolCall("echo", { a: "x" }, r, {}, reg, log);
    expect(textOf(res).at(-1)).toBe(`note: ${PARAMS_CHANGED_NOTE}`);
  });

  it("refuses the call when args fail the reloaded schema", async () => {
    const { r, reg } = await setup();
    writeModule(mod("v2", ["a", "b"]));
    const res = await dispatchToolCall("echo", { a: "x", bad: true }, r, {}, reg, log);
    expect(res.isError).toBe(true);
    expect(JSON.parse(textOf(res)[0]).code).toBe("INVALID_PARAMS");
  });

  it("no note when only the handler body changed", async () => {
    const { r, reg, updates } = await setup();
    writeModule(mod("v2"));
    const res = await dispatchToolCall("echo", { a: "x" }, r, {}, reg, log);
    expect(textOf(res)).toHaveLength(1);
    expect(updates).toHaveLength(0);
  });

  it("a tool missing from the reloaded build returns an error instead of crashing", async () => {
    const { r, reg } = await setup();
    writeModule(`export const SHIM_API = ${SHIM_API_VERSION}; export const tools = [];`);
    const res = await dispatchToolCall("echo", {}, r, {}, reg, log);
    expect(res.isError).toBe(true);
    expect(JSON.parse(textOf(res)[0]).code).toBe("TOOL_NOT_IN_BUILD");
  });
});

describe("toolFingerprint", () => {
  it("is stable under key order and ignores functions", () => {
    const a = toolFingerprint({ description: "d", schema: { x: { k: 1, f: () => 1 }, y: { k: 2 } } });
    const b = toolFingerprint({ description: "d", schema: { y: { k: 2 }, x: { f: () => 2, k: 1 } } });
    expect(a).toBe(b);
  });

  it("differs for real zod schemas with different fields", async () => {
    const { z } = await import("zod");
    const a = toolFingerprint({ description: "d", schema: { x: z.string() } });
    const a2 = toolFingerprint({ description: "d", schema: { x: z.string() } });
    const b = toolFingerprint({ description: "d", schema: { x: z.string().optional() } });
    expect(a).toBe(a2);
    expect(a).not.toBe(b);
  });
});

/**
 * Exercises the actual built dist server, not a fixture: spawns dist/ipk-browser-mcp.mjs
 * over stdio and runs the real MCP initialize + tools/list handshake against it. Skipped
 * (not failed) when dist/ hasn't been built yet, since dist/ is checked in but a fresh
 * clone before the first `npm run build` would otherwise fail this unrelated to the
 * change under test.
 */
describe("built dist server (stdio smoke test)", () => {
  const distEntry = fileURLToPath(new URL("../dist/ipk-browser-mcp.mjs", import.meta.url));
  const hasDist = fs.existsSync(distEntry);
  const maybeIt = hasDist ? it : it.skip;

  maybeIt("answers initialize and tools/list with 13 tools, ipk_action among them", async () => {
    const child = spawn(process.execPath, [distEntry], { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    const responses: any[] = [];
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) {
          try { responses.push(JSON.parse(line)); } catch { /* non-JSON stdout line, ignore */ }
        }
      }
    });

    const send = (msg: unknown) => child.stdin.write(JSON.stringify(msg) + "\n");
    const waitForId = (id: number, timeoutMs = 15_000): Promise<any> =>
      new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const check = () => {
          const found = responses.find((r) => r.id === id);
          if (found) return resolve(found);
          if (Date.now() > deadline) return reject(new Error(`timed out waiting for response id ${id}; stderr: ${stderr}`));
          setTimeout(check, 50);
        };
        check();
      });

    try {
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "hot-reload-smoke-test", version: "0.0.0" },
      } });
      const initRes = await waitForId(1);
      expect(initRes.error).toBeUndefined();
      send({ jsonrpc: "2.0", method: "notifications/initialized" });

      send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      const listRes = await waitForId(2);
      expect(listRes.error).toBeUndefined();
      expect(listRes.result.tools).toHaveLength(13);
      expect(listRes.result.tools.map((t: any) => t.name)).toContain("ipk_action");
    } finally {
      child.kill();
    }
  }, 20_000);
});
