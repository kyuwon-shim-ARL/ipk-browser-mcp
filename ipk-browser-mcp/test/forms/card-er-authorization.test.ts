import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  cardErAuthorizationPath,
  readCardErDraftAuthorizations,
  findCardErDraftAuthorization,
  consumeCardErDraftAuthorization,
  findCardErDocEditAuthorization,
  consumeCardErDocEditAuthorization,
  reconcileTakenLock,
} from "../../src/forms/card-er-authorization.js";

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipk-card-er-auth-"));
  file = path.join(dir, "card-er-draft-authorizations.json");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const write = (v: unknown) => fs.writeFileSync(file, typeof v === "string" ? v : JSON.stringify(v));

describe("cardErAuthorizationPath", () => {
  it("lives next to profile.json under ~/.config/ipk-browser-mcp", () => {
    expect(cardErAuthorizationPath("/home/x")).toBe("/home/x/.config/ipk-browser-mcp/card-er-draft-authorizations.json");
  });
});

describe("readCardErDraftAuthorizations", () => {
  it("a missing file is no authorization", () => {
    expect(readCardErDraftAuthorizations(file)).toEqual({});
  });
  it("an invalid file is no authorization", () => {
    write("{not json");
    expect(readCardErDraftAuthorizations(file)).toEqual({});
    write([{ trseq: "1" }]);
    expect(readCardErDraftAuthorizations(file)).toEqual({});
    write("null");
    expect(readCardErDraftAuthorizations(file)).toEqual({});
  });
  it("reads the entries", () => {
    write({ "19984403": { trseq: "26040417102", authorized_at: "2026-10-26T10:00:00+09:00", note: "x" } });
    expect(readCardErDraftAuthorizations(file)["19984403"].trseq).toBe("26040417102");
  });
});

describe("findCardErDraftAuthorization", () => {
  const auths = { "19984403": { trseq: "26040417102", authorized_at: "2026-10-26T10:00:00+09:00", note: "x" } };
  it("matches on both appr_no and trseq", () => {
    expect(findCardErDraftAuthorization(auths, "19984403", "26040417102")).not.toBeNull();
    expect(findCardErDraftAuthorization(auths, 19984403 as any, 26040417102 as any)).not.toBeNull();
  });
  it("a trseq mismatch is no authorization", () => {
    expect(findCardErDraftAuthorization(auths, "19984403", "26040417999")).toBeNull();
  });
  it("an unknown appr_no or a missing value is no authorization", () => {
    expect(findCardErDraftAuthorization(auths, "11111111", "26040417102")).toBeNull();
    expect(findCardErDraftAuthorization(auths, "", "26040417102")).toBeNull();
    expect(findCardErDraftAuthorization(auths, "19984403", undefined as any)).toBeNull();
  });
  it("an entry without a string trseq is no authorization", () => {
    expect(findCardErDraftAuthorization({ "1": { note: "x" } as any }, "1", "")).toBeNull();
    expect(findCardErDraftAuthorization({ "1": "yes" as any }, "1", "yes")).toBeNull();
  });
});

describe("consumeCardErDraftAuthorization", () => {
  it("removes the matching entry and keeps the others", () => {
    write({
      "19984403": { trseq: "26040417102", authorized_at: "a", note: "x" },
      "22222222": { trseq: "999", authorized_at: "b", note: "y" },
    });
    const got = consumeCardErDraftAuthorization("19984403", "26040417102", file);
    expect(got?.trseq).toBe("26040417102");
    const left = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(Object.keys(left)).toEqual(["22222222"]);
    // one authorization, one save: a second consume finds nothing
    expect(consumeCardErDraftAuthorization("19984403", "26040417102", file)).toBeNull();
    // no temp files left behind
    expect(fs.readdirSync(dir)).toEqual(["card-er-draft-authorizations.json"]);
  });
  it("a mismatch consumes nothing and leaves the file as it was", () => {
    write({ "19984403": { trseq: "26040417102", authorized_at: "a", note: "x" } });
    const before = fs.readFileSync(file, "utf8");
    expect(consumeCardErDraftAuthorization("19984403", "1", file)).toBeNull();
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });
  it("a missing file consumes nothing and does not create one", () => {
    expect(consumeCardErDraftAuthorization("19984403", "26040417102", file)).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe("doc-edit authorizations (key doc:<doc_id>, same file)", () => {
  const entry = { doc_id: "302242", authorized_at: "2026-10-26T10:00:00+09:00", note: "VAT fix" };
  it("matches only key doc:<id> whose entry names the same doc_id", () => {
    expect(findCardErDocEditAuthorization({ "doc:302242": entry }, "302242")).not.toBeNull();
    expect(findCardErDocEditAuthorization({ "doc:302242": entry }, 302242 as any)).not.toBeNull();
    expect(findCardErDocEditAuthorization({ "doc:302242": { ...entry, doc_id: "302243" } }, "302242")).toBeNull();
    expect(findCardErDocEditAuthorization({ "302242": entry } as any, "302242")).toBeNull();
    expect(findCardErDocEditAuthorization({ "doc:302242": entry }, "")).toBeNull();
  });
  it("a transaction authorization never unlocks a doc edit, and a doc entry never unlocks a transaction", () => {
    const tx = { "19984403": { trseq: "26040417102" } };
    expect(findCardErDocEditAuthorization(tx as any, "19984403")).toBeNull();
    expect(findCardErDraftAuthorization({ "doc:302242": entry } as any, "doc:302242", "302242")).toBeNull();
  });
  it("consumes only the matching entry and keeps the others", () => {
    const tx = { "19984403": { trseq: "26040417102" } };
    write({ ...tx, "doc:302242": entry, "doc:302243": { ...entry, doc_id: "302243" } });
    expect(consumeCardErDocEditAuthorization("302242", file)).toEqual(entry);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ ...tx, "doc:302243": { ...entry, doc_id: "302243" } });
    expect(consumeCardErDocEditAuthorization("302242", file)).toBeNull();
  });
  it("no match leaves the file untouched", () => {
    write({ "doc:302243": { ...entry, doc_id: "302243" } });
    const before = fs.readFileSync(file, "utf8");
    expect(consumeCardErDocEditAuthorization("302242", file)).toBeNull();
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });
});

describe("concurrent consume is exclusive (fs.openSync('wx') lock)", () => {
  it("two real processes racing to consume the same doc entry: exactly one succeeds", async () => {
    const esbuild = await import("esbuild");
    const { spawn } = await import("node:child_process");

    const entry = { doc_id: "302242", authorized_at: "2026-10-26T10:00:00+09:00", note: "VAT fix" };
    write({ "doc:302242": entry });

    const moduleFile = path.join(dir, "card-er-authorization.bundle.cjs");
    await esbuild.build({
      entryPoints: [path.resolve(__dirname, "../../src/forms/card-er-authorization.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: moduleFile,
    });

    const runnerFile = path.join(dir, "runner.cjs");
    fs.writeFileSync(
      runnerFile,
      `const { consumeCardErDocEditAuthorization } = require(${JSON.stringify(moduleFile)});\n` +
      `const result = consumeCardErDocEditAuthorization(${JSON.stringify("302242")}, ${JSON.stringify(file)});\n` +
      `process.stdout.write(JSON.stringify(result));\n`
    );

    const runOnce = (): Promise<string> =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [runnerFile]);
        let out = "";
        child.stdout.on("data", (d) => { out += d; });
        child.on("error", reject);
        child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`runner exited ${code}: ${out}`))));
      });
    // Both children are started before either is awaited, so they race for the same lock file.
    const p1 = runOnce();
    const p2 = runOnce();
    const [a, b] = await Promise.all([p1, p2]);
    const results = [JSON.parse(a), JSON.parse(b)];
    const successes = results.filter((r) => r !== null);
    expect(successes).toHaveLength(1);
    expect(successes[0]).toEqual(entry);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({});
  }, 20000);
});

describe("M4: a stale lock (crashed holder) is taken over, not deadlocked on", () => {
  it("removes a lock older than LOCK_STALE_MS and completes the consume", () => {
    const entry = { trseq: "26040417102", authorized_at: "2026-10-26T10:00:00+09:00", note: "test" };
    write({ "19984403": entry });
    const lockPath = `${file}.lock`;
    fs.writeFileSync(lockPath, "999999"); // a pid that is not this process
    const old = Date.now() - 60_000;
    fs.utimesSync(lockPath, old / 1000, old / 1000); // older than LOCK_STALE_MS (10s)

    const result = consumeCardErDraftAuthorization("19984403", "26040417102", file);

    expect(result).toEqual(entry);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({});
  });

  it("does not take over a fresh lock - it waits and only proceeds once it is released", () => {
    // consumeCardErDraftAuthorization is synchronous (it busy-retries via Atomics.wait), so
    // the lock can only be released concurrently from a separate OS process, not a JS timer
    // on this same thread.
    const entry = { trseq: "26040417102", authorized_at: "2026-10-26T10:00:00+09:00", note: "test" };
    write({ "19984403": entry });
    const lockPath = `${file}.lock`;
    fs.writeFileSync(lockPath, String(process.pid)); // fresh - not stale
    const { spawn } = require("node:child_process");
    const releaser = spawn(
      process.execPath,
      ["-e", `setTimeout(()=>{try{require("fs").rmSync(${JSON.stringify(lockPath)},{force:true})}catch(e){}},50)`],
      { detached: true, stdio: "ignore" }
    );
    releaser.unref();

    const result = consumeCardErDraftAuthorization("19984403", "26040417102", file);

    expect(result).toEqual(entry);
  });
});

describe("M-B: reconcileTakenLock - a lock swapped for a fresh one mid-takeover is identified and restored, not destroyed", () => {
  // These exercise the identity-check/restore logic directly: simulating the actual race
  // window around a single synchronous renameSync() call (so the swap happens between the
  // production code's statSync and its renameSync) is not practical to do from the outside,
  // but the reconciliation step itself - "was `taken` really the file I staleStat'd, and if
  // not, put back what IS there now" - is fully exercised by setting up its two outcomes
  // directly with real files.

  it("mismatch: taken is a different file than the one staleStat'd (a concurrent fresh lock) - restores it via linkSync and removes `taken`", () => {
    const lockPath = `${file}.lock`;
    // The process "statted" this stale file...
    fs.writeFileSync(lockPath, "111111");
    const old = Date.now() - 60_000;
    fs.utimesSync(lockPath, old / 1000, old / 1000);
    const staleStat = fs.statSync(lockPath);
    // ...but by the time it renamed, a concurrent process had already replaced it with a
    // fresh, live lock (different inode, current mtime).
    fs.rmSync(lockPath, { force: true });
    fs.writeFileSync(lockPath, "222222");
    const freshStat = fs.statSync(lockPath);
    const taken = `${lockPath}.taken`;
    fs.renameSync(lockPath, taken); // what the rename in withAuthorizationsLock actually moved

    reconcileTakenLock(lockPath, taken, staleStat);

    expect(fs.existsSync(taken)).toBe(false); // taken was cleaned up either way
    expect(fs.existsSync(lockPath)).toBe(true); // restored, not left missing
    expect(fs.readFileSync(lockPath, "utf8")).toBe("222222"); // the fresh lock's own content
    const restoredStat = fs.statSync(lockPath);
    expect(restoredStat.ino).toBe(freshStat.ino); // same file (hard link), not a new one
  });

  it("match: taken is exactly the stale file that was staleStat'd - removes it, lockPath stays gone", () => {
    const lockPath = `${file}.lock`;
    fs.writeFileSync(lockPath, "111111");
    const old = Date.now() - 60_000;
    fs.utimesSync(lockPath, old / 1000, old / 1000);
    const staleStat = fs.statSync(lockPath);
    const taken = `${lockPath}.taken`;
    fs.renameSync(lockPath, taken); // no swap - this really is the stale lock

    reconcileTakenLock(lockPath, taken, staleStat);

    expect(fs.existsSync(taken)).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(false); // nothing to restore - it was genuinely stale
  });

  it("does not take over a fresh lock at the withAuthorizationsLock level - it waits and only proceeds once released", () => {
    // Full end-to-end: a genuinely fresh lock (no swap at all) is left alone and waited out,
    // same contract as before M-B.
    const entry = { trseq: "26040417102", authorized_at: "2026-10-26T10:00:00+09:00", note: "test" };
    write({ "19984403": entry });
    const lockPath = `${file}.lock`;
    fs.writeFileSync(lockPath, String(process.pid));
    const { spawn } = require("node:child_process");
    const releaser = spawn(
      process.execPath,
      ["-e", `setTimeout(()=>{try{require("fs").rmSync(${JSON.stringify(lockPath)},{force:true})}catch(e){}},50)`],
      { detached: true, stdio: "ignore" }
    );
    releaser.unref();

    const result = consumeCardErDraftAuthorization("19984403", "26040417102", file);

    expect(result).toEqual(entry);
  });
});
