/**
 * Hot reload of the handlers bundle (dist/handlers.mjs).
 *
 * The shim (src/index.ts) owns the MCP server, the stdio transport, config and the
 * SessionManager (the logged-in Playwright browser). Tool handlers live in a separate
 * bundle that the shim re-imports when its mtime changes, so a `npm run build` takes
 * effect on the next tool call without a `/mcp` reconnect.
 *
 * A module is swapped in only after `await import()` has fully evaluated it and its
 * shape has been checked, and each call captures one module reference for its whole
 * run, so no call ever sees a partially loaded module. A failed import keeps the
 * previous module.
 */
import * as fs from "fs";
import { pathToFileURL } from "url";

export interface ToolDef {
  name: string;
  description: string;
  /** zod raw shape, as passed to McpServer.tool() */
  schema: Record<string, unknown>;
  handler: (ctx: any, params: any) => Promise<any>;
}

export interface HandlersModule {
  tools: ToolDef[];
  /** One-time work at server start (e.g. screenshot cleanup). Not re-run on reload. */
  startup?: (ctx: any) => void;
  /** Parse args with the bundle's own zod; used when a reloaded schema differs from the registered one. */
  parseArgs?: (shape: Record<string, unknown>, args: unknown) => { success: true; data: any } | { success: false; error: string };
  /** The handlers<->shim API version this bundle was built against. See SHIM_API_VERSION. */
  SHIM_API?: number;
}

export interface Snapshot {
  mod: HandlersModule;
  /** The import error of the newest build, when it failed and the previous module is being served. */
  reloadError?: string;
}

/**
 * The handlers<->shim contract version. Bump this when the shape the shim expects from
 * a handlers bundle changes (ToolDef, parseArgs, etc). handlers.ts exports its own
 * SHIM_API built against whatever version it was written for; a mismatch means the
 * handlers bundle was built for a different shim and must not be loaded.
 */
export const SHIM_API_VERSION = 1;

const HANDLERS_API_MISMATCH_NOTE = "handlers built for a different server version — /mcp reconnect needed";

function validateModule(mod: any): HandlersModule {
  if (!mod || !Array.isArray(mod.tools)) throw new Error("handlers module has no `tools` array");
  if (mod.SHIM_API !== SHIM_API_VERSION) {
    throw new Error(`${HANDLERS_API_MISMATCH_NOTE} (handlers SHIM_API=${mod.SHIM_API}, server expects ${SHIM_API_VERSION})`);
  }
  for (const t of mod.tools) {
    if (!t || typeof t.name !== "string" || typeof t.handler !== "function" || typeof t.schema !== "object") {
      throw new Error(`handlers module has a malformed tool entry: ${t && t.name}`);
    }
  }
  return mod as HandlersModule;
}

export class HandlerReloader {
  private mod: HandlersModule | null = null;
  private loadedMtime = -1;
  private failedMtime = -1;
  private lastError: string | undefined;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly filePath: string,
    private readonly log: (msg: string) => void = (m) => process.stderr.write(m + "\n"),
    /** Module loader; injectable because test runners intercept import() and ignore the `?v=` buster. */
    private readonly importer: (url: string) => Promise<any> = (url) => import(url)
  ) {}

  private mtime(): number {
    return fs.statSync(this.filePath).mtimeMs;
  }

  private async importAt(mtime: number): Promise<HandlersModule> {
    // Each distinct `?v=` busts node's module cache so the new build is actually re-evaluated;
    // the previously loaded module stays resident too (a handlers bundle is ~390KB), since node
    // never unloads an ESM module. Harmless for this process's lifetime, but worth knowing.
    const url = pathToFileURL(this.filePath).href + "?v=" + mtime;
    return validateModule(await this.importer(url));
  }

  /** Initial load. Throws if the bundle cannot be imported - there is nothing to serve. */
  async load(): Promise<HandlersModule> {
    const m = this.mtime();
    this.mod = await this.importAt(m);
    this.loadedMtime = m;
    return this.mod;
  }

  /** The module to use for one tool call; re-imports first if the file changed. */
  async current(): Promise<Snapshot> {
    if (!this.mod) throw new Error("HandlerReloader.current() before load()");
    let m: number;
    try {
      m = this.mtime();
    } catch (err) {
      // File briefly missing (e.g. mid-clean): keep serving what we have.
      return { mod: this.mod, reloadError: this.lastError };
    }
    if (m !== this.loadedMtime && m !== this.failedMtime) {
      // Concurrent calls share one import.
      if (!this.inflight) {
        this.inflight = this.importAt(m)
          .then((mod) => {
            this.mod = mod;
            this.loadedMtime = m;
            this.lastError = undefined;
            this.log(`[ipk-browser] handlers reloaded (${this.filePath}, mtime ${new Date(m).toISOString()})`);
          })
          .catch((err) => {
            this.failedMtime = m;
            this.lastError = err instanceof Error ? err.message : String(err);
            this.log(`[ipk-browser] handlers reload FAILED, serving previous build: ${this.lastError}`);
          })
          .finally(() => {
            this.inflight = null;
          });
      }
      await this.inflight;
    }
    return { mod: this.mod, reloadError: this.lastError };
  }
}

/**
 * Key-sorted JSON that drops functions, so two equal zod shapes fingerprint the same.
 * `seen` tracks the current ancestor chain, not every node ever visited: entries are
 * removed once a node's subtree has been fully processed, so a sub-schema shared by
 * reference in two places (not a real cycle) is fingerprinted normally both times, and
 * only an actual cycle (a node that is its own ancestor) comes out as "[cycle]".
 */
function stable(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") return typeof value === "function" ? undefined : value;
  if (seen.has(value as object)) return "[cycle]";
  seen.add(value as object);
  try {
    if (Array.isArray(value)) return value.map((v) => stable(v, seen));
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) {
      const v = stable((value as Record<string, unknown>)[k], seen);
      if (v !== undefined) out[k] = v;
    }
    // A ZodDefault's default value is carried as a function (_def.defaultValue), which the
    // generic pass above drops like any other function. Evaluate it so a reload that only
    // changes a default's value (not the shape) still changes the fingerprint.
    const def = (value as { _def?: { typeName?: string; defaultValue?: () => unknown } })._def;
    if (def && def.typeName === "ZodDefault" && typeof def.defaultValue === "function") {
      try {
        out.__defaultValue = stable(def.defaultValue(), seen);
      } catch {
        // Defensive: a custom default() callback could throw; don't let that break fingerprinting.
      }
    }
    return out;
  } finally {
    seen.delete(value as object);
  }
}

/** Fingerprint of what a client sees for a tool: its description and parameter schema. */
export function toolFingerprint(def: Pick<ToolDef, "description" | "schema">): string {
  try {
    return JSON.stringify(stable({ description: def.description, schema: def.schema }, new WeakSet()));
  } catch {
    return JSON.stringify({ description: def.description, keys: Object.keys(def.schema).sort() });
  }
}

export const PARAMS_CHANGED_NOTE = "tool parameters changed — /mcp reconnect needed to use new parameters";

/** Append one-line notes to an MCP tool result without disturbing its content. */
export function withNotes(result: any, notes: string[]): any {
  if (notes.length === 0) return result;
  const content = Array.isArray(result?.content) ? result.content : [];
  return { ...result, content: [...content, { type: "text", text: `note: ${notes.join("; ")}` }] };
}

function errorResult(code: string, message: string): any {
  return { content: [{ type: "text", text: JSON.stringify({ error: true, code, message }) }], isError: true };
}

/** What the shim registered for one tool. */
export interface Registration {
  /** Fingerprint the client was given at connect time. */
  connectFp: string;
  /** Fingerprint the server currently validates arguments with. */
  currentFp: string;
  /** RegisteredTool.update from the MCP SDK (also sends notifications/tools/list_changed). */
  update?: (u: { description: string; paramsSchema: Record<string, unknown> }) => void;
}

/**
 * Run one tool call against the current handlers module.
 *
 * Args are always re-validated with the handler bundle's own schema (`mod.parseArgs`)
 * before the handler runs, not only when the fingerprint looks changed: two calls
 * racing a schema-changing reload could otherwise both see `fp === reg.currentFp` (the
 * first call already advanced it) and skip re-validation, and a default-value-only
 * change is invisible to the fingerprint but still needs the new default applied.
 * When the reloaded module's schema differs from the one the client connected with,
 * the registration is updated so the server advertises the new schema, and the client
 * still holds the connect-time schema, so every result carries PARAMS_CHANGED_NOTE
 * until it reconnects.
 */
export async function dispatchToolCall(
  name: string,
  args: unknown,
  reloader: Pick<HandlerReloader, "current">,
  ctx: unknown,
  reg: Registration,
  log: (msg: string) => void = (m) => process.stderr.write(m + "\n")
): Promise<any> {
  const { mod, reloadError } = await reloader.current();
  const notes: string[] = [];
  if (reloadError) notes.push(`handlers reload failed (${reloadError}); serving the previous build`);

  const def = mod.tools.find((t) => t.name === name);
  if (!def) {
    return withNotes(
      errorResult("TOOL_NOT_IN_BUILD", `${name} is not in the current handlers build; /mcp reconnect needed`),
      notes
    );
  }

  const fp = toolFingerprint(def);
  const schemaChangedSinceLastSeen = fp !== reg.currentFp;
  if (schemaChangedSinceLastSeen) {
    log(`[ipk-browser] WARNING: ${name} parameters/description changed in reloaded handlers — /mcp reconnect needed for the client to use new parameters`);
    try {
      reg.update?.({ description: def.description, paramsSchema: def.schema });
    } catch (err) {
      log(`[ipk-browser] could not update registered schema for ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
    reg.currentFp = fp;
  }

  const reconnectNotes = fp !== reg.connectFp ? [PARAMS_CHANGED_NOTE] : [];

  let params = args;
  if (typeof mod.parseArgs === "function") {
    const parsed = mod.parseArgs(def.schema, args ?? {});
    if (!parsed.success) {
      return withNotes(errorResult("INVALID_PARAMS", `${name}: arguments do not match the current schema: ${parsed.error}`), [...notes, ...reconnectNotes]);
    }
    params = parsed.data;
  } else if (schemaChangedSinceLastSeen) {
    return withNotes(errorResult("SCHEMA_CHANGED", `${name} schema changed and the handlers build cannot re-validate arguments; /mcp reconnect`), [...notes, ...reconnectNotes]);
  }

  return withNotes(await def.handler(ctx, params), [...notes, ...reconnectNotes]);
}
