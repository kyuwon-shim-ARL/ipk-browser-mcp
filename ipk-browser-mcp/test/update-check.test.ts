/**
 * Update-available notice (src/update-check.ts), with a mocked fetch and a temp cache file.
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { updateNotice, isNewer, UPDATE_CHECK_URL, UPDATE_CHECK_INTERVAL_MS, type UpdateCheckState } from "../src/update-check.js";

let cachePath: string;
let state: UpdateCheckState;
let now: number;
let calls: string[];

const remote = (version: string) => async (url: any) => {
  calls.push(String(url));
  return new Response(JSON.stringify({ name: "ipk-browser-mcp", version }), { status: 200 });
};
const failing = async (url: any) => {
  calls.push(String(url));
  throw new TypeError("fetch failed");
};

const deps = (fetchFn: any, extra: Record<string, unknown> = {}) => ({
  localVersion: "0.2.0", fetch: fetchFn, now: () => now, cachePath, env: {}, ...extra,
});

/** One tool call: get the note, then let the background fetch settle (a real call never waits). */
async function call(fetchFn: any, extra: Record<string, unknown> = {}) {
  const note = updateNotice(state, deps(fetchFn, extra));
  await state.inflight;
  return note;
}

beforeEach(() => {
  cachePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ipk-upd-")), "sub", "update-check.json");
  state = { notified: new Set() };
  now = 1_800_000_000_000;
  calls = [];
});

describe("isNewer", () => {
  it("compares major.minor.patch numerically", () => {
    expect(isNewer("0.10.0", "0.9.9")).toBe(true);
    expect(isNewer("0.2.0", "0.2.0")).toBe(false);
    expect(isNewer("0.1.9", "0.2.0")).toBe(false);
    expect(isNewer("1.0.0-beta", "0.9.0")).toBe(true);
    expect(isNewer("garbage", "0.1.0")).toBe(false);
  });
});

describe("updateNotice", () => {
  it("newer remote: fetches on the first call, notes once, then never again in this process", async () => {
    expect(await call(remote("0.3.0"))).toBeUndefined(); // first call: fetch fired, nothing cached yet
    expect(calls).toEqual([UPDATE_CHECK_URL]);
    expect(JSON.parse(fs.readFileSync(cachePath, "utf8"))).toEqual({ checkedAt: now, remoteVersion: "0.3.0" });

    const note = await call(remote("0.3.0"));
    expect(note).toBe(
      "ipk-browser-mcp 0.3.0 available (installed 0.2.0): run /plugin marketplace update ipk-browser-mcp, " +
      "then /plugin update ipk-browser-mcp@ipk-browser-mcp, then restart Claude Code."
    );
    expect(await call(remote("0.3.0"))).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("a fresh process notes from a cache written by an earlier one, without fetching", async () => {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({ checkedAt: now - 1000, remoteVersion: "0.2.1" }));
    expect(await call(remote("0.2.1"))).toMatch(/^ipk-browser-mcp 0\.2\.1 available \(installed 0\.2\.0\)/);
    expect(calls).toHaveLength(0);
  });

  it("same or older remote: no note", async () => {
    await call(remote("0.2.0"));
    expect(await call(remote("0.2.0"))).toBeUndefined();
    state = { notified: new Set() };
    now += UPDATE_CHECK_INTERVAL_MS;
    await call(remote("0.1.2"));
    expect(await call(remote("0.1.2"))).toBeUndefined();
  });

  it("network error: silent, no cache written, no retry within 24h in this process", async () => {
    expect(await call(failing)).toBeUndefined();
    expect(await call(failing)).toBeUndefined();
    expect(fs.existsSync(cachePath)).toBe(false);
    expect(calls).toHaveLength(1);
    now += UPDATE_CHECK_INTERVAL_MS;
    await call(failing);
    expect(calls).toHaveLength(2);
  });

  it("bad response body: silent", async () => {
    const bad = async () => new Response("not json", { status: 200 });
    expect(await call(bad)).toBeUndefined();
    expect(await call(bad)).toBeUndefined();
    const notFound = async () => new Response("", { status: 404 });
    state = { notified: new Set() };
    now += UPDATE_CHECK_INTERVAL_MS;
    expect(await call(notFound)).toBeUndefined();
  });

  it("throttle: a cache younger than 24h is not refetched, even by a new process; an older one is", async () => {
    await call(remote("0.2.0"));
    state = { notified: new Set() }; // new process
    now += UPDATE_CHECK_INTERVAL_MS - 1;
    await call(remote("0.2.0"));
    expect(calls).toHaveLength(1);
    now += 1;
    await call(remote("0.4.0"));
    expect(calls).toHaveLength(2);
    expect(await call(remote("0.4.0"))).toMatch(/0\.4\.0 available/);
  });

  it("a newer remote version after one was shown is shown once too", async () => {
    await call(remote("0.3.0"));
    expect(await call(remote("0.3.0"))).toMatch(/0\.3\.0/);
    now += UPDATE_CHECK_INTERVAL_MS;
    await call(remote("0.4.0"));
    expect(await call(remote("0.4.0"))).toMatch(/0\.4\.0/);
  });

  it("IPK_UPDATE_CHECK=0: no fetch, no note", async () => {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({ checkedAt: now - 1000, remoteVersion: "9.0.0" }));
    expect(await call(remote("9.0.0"), { env: { IPK_UPDATE_CHECK: "0" } })).toBeUndefined();
    now += UPDATE_CHECK_INTERVAL_MS;
    expect(await call(remote("9.0.0"), { env: { IPK_UPDATE_CHECK: "0" } })).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("does not wait for the fetch", () => {
    const never = () => new Promise<Response>(() => undefined);
    expect(updateNotice(state, deps(never))).toBeUndefined(); // returns synchronously
    expect(state.inflight).toBeDefined();
  });
});
