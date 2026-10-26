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
