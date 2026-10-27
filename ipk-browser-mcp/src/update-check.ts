/**
 * Update-available notice. Never updates anything: it only tells the person a newer
 * ipk-browser-mcp has been published and how to install it.
 *
 * On a tool call, if the cached check (~/.cache/ipk-mcp/update-check.json) is missing or
 * older than 24h and this process has not tried in the last 24h, the published
 * .claude-plugin/plugin.json is fetched in the background (2s timeout); the tool call never
 * waits for it. The note comes from the cached result, so it appears from the next call after
 * the fetch lands. It is shown at most once per process per remote version. Any failure
 * (offline, bad JSON, unwritable cache) is silent. IPK_UPDATE_CHECK=0 turns it off.
 *
 * Lives in the hot-reloaded handlers bundle so it can be fixed without a reconnect. Its
 * per-process state (in-flight fetch, versions already shown) is kept on the shim's ctx
 * object, which survives handler reloads; module-level state would reset on every reload
 * and show the note again.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const UPDATE_CHECK_URL =
  "https://raw.githubusercontent.com/kyuwon-shim-ARL/ipk-browser-mcp/master/.claude-plugin/plugin.json";
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 2000;

export interface UpdateCheckState {
  /** When this process last started a fetch (ms). */
  lastAttempt?: number;
  inflight?: Promise<void>;
  /** Remote versions already shown in this process. */
  notified: Set<string>;
}

export interface UpdateCheckDeps {
  localVersion: string;
  fetch?: typeof fetch;
  now?: () => number;
  cachePath?: string;
  env?: NodeJS.ProcessEnv;
}

interface CacheFile {
  checkedAt: number;
  remoteVersion: string;
}

export function defaultCachePath(): string {
  return path.join(os.homedir(), ".cache", "ipk-mcp", "update-check.json");
}

function parseVersion(v: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True when a > b (major.minor.patch; pre-release tags ignored). False if either is not a version. */
export function isNewer(a: string, b: string): boolean {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

function readCache(file: string): CacheFile | null {
  try {
    const c = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof c?.checkedAt === "number" && typeof c?.remoteVersion === "string" ? c : null;
  } catch {
    return null;
  }
}

async function fetchRemote(fetchFn: typeof fetch, file: string, now: number): Promise<void> {
  const res = await fetchFn(UPDATE_CHECK_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) return;
  const version = (await res.json())?.version;
  if (typeof version !== "string" || !parseVersion(version)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ checkedAt: now, remoteVersion: version } satisfies CacheFile));
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
}

/**
 * Called on every tool call: starts a background check when due, and returns the note to
 * append (at most once per process per remote version), or undefined. Never throws.
 */
export function updateNotice(state: UpdateCheckState, deps: UpdateCheckDeps): string | undefined {
  try {
    const env = deps.env ?? process.env;
    if (env.IPK_UPDATE_CHECK === "0") return undefined;
    const now = (deps.now ?? Date.now)();
    const file = deps.cachePath ?? defaultCachePath();
    const cache = readCache(file);

    const cacheStale = !cache || now - cache.checkedAt >= UPDATE_CHECK_INTERVAL_MS;
    const triedRecently = state.lastAttempt !== undefined && now - state.lastAttempt < UPDATE_CHECK_INTERVAL_MS;
    if (cacheStale && !triedRecently && !state.inflight) {
      state.lastAttempt = now;
      state.inflight = fetchRemote(deps.fetch ?? fetch, file, now)
        .catch(() => undefined)
        .finally(() => {
          state.inflight = undefined;
        });
    }

    if (!cache || !isNewer(cache.remoteVersion, deps.localVersion) || state.notified.has(cache.remoteVersion)) return undefined;
    state.notified.add(cache.remoteVersion);
    return (
      `ipk-browser-mcp ${cache.remoteVersion} available (installed ${deps.localVersion}): ` +
      "run /plugin marketplace update ipk-browser-mcp, then /plugin update ipk-browser-mcp@ipk-browser-mcp, then restart Claude Code."
    );
  } catch {
    return undefined;
  }
}
