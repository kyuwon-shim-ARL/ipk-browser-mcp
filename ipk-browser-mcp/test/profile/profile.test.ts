import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  emptyProfile,
  loadProfile,
  saveProfile,
  profilePath,
  maskCardNumber,
  cardDigits,
  cardMatches,
  fiscalYearFromCode,
  PROFILE_SCHEMA_VERSION,
} from "../../src/profile/profile.js";

describe("maskCardNumber", () => {
  it("keeps only the last 4 digits, dashed or not", () => {
    expect(maskCardNumber("1234-5678-9012-3456")).toBe("****-****-****-3456");
    expect(maskCardNumber("1234567890123456")).toBe("****-****-****-3456");
  });
  it("fully masks anything too short to have 4 digits", () => {
    expect(maskCardNumber("12")).toBe("****");
    expect(maskCardNumber("")).toBe("****");
  });
});

describe("cardDigits", () => {
  it("strips non-digits so dashed and undashed forms compare equal", () => {
    expect(cardDigits("1234-5678-9012-3456")).toBe(cardDigits("1234567890123456"));
  });
});

describe("cardMatches", () => {
  it("compares full digits when the profile entry is unmasked", () => {
    expect(cardMatches("1234-5678-9012-3456", "1234567890123456")).toBe(true);
    expect(cardMatches("1234-5678-9012-3456", "9999567890123456")).toBe(false);
  });
  it("compares only the outer 4+4 digits when the profile entry is masked", () => {
    expect(cardMatches("1234-XXXX-XXXX-3456", "1234567890123456")).toBe(true);
    expect(cardMatches("1234-XXXX-XXXX-3456", "1234000000009999")).toBe(false); // last 4 differ
    expect(cardMatches("1234-XXXX-XXXX-3456", "9999567890123456")).toBe(false); // first 4 differ
  });
});

describe("fiscalYearFromCode", () => {
  it("reads the 2-digit year after the letters", () => {
    expect(fiscalYearFromCode("NN2606-0001")).toBe(2026);
    expect(fiscalYearFromCode("NN9999-0001")).toBe(2099);
  });
  it("returns undefined rather than guessing for a code that doesn't fit the shape", () => {
    expect(fiscalYearFromCode("weird")).toBeUndefined();
    expect(fiscalYearFromCode("")).toBeUndefined();
  });
});

describe("saveProfile / loadProfile", () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "ipk-profile-test-")); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it("round-trips through disk", () => {
    const profile = emptyProfile({ name: "Tester", dept: "ARL" });
    profile.cards.push({ number: "1234-5678-9012-3456", source: "corporation_card_list.php" });
    profile.budget_pots.push({ code: "NN2606-0001", fiscal_year: 2026, source: "AppFrm-021 select" });

    const written = saveProfile(profile, home);
    expect(written).toBe(profilePath(home));

    const back = loadProfile(home);
    expect(back).toEqual(profile);
  });

  it("writes with mode 600 (profile.json names cards)", () => {
    saveProfile(emptyProfile({ name: "Tester", dept: "ARL" }), home);
    const mode = fs.statSync(profilePath(home)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("returns null, not a throw, when nothing has been written yet", () => {
    expect(loadProfile(home)).toBeNull();
  });

  it("re-running overwrites rather than merging", () => {
    saveProfile({ ...emptyProfile({ name: "Tester", dept: "ARL" }), cards: [{ number: "1111", source: "x" }] }, home);
    saveProfile(emptyProfile({ name: "Tester", dept: "ARL" }), home);
    expect(loadProfile(home)!.cards).toEqual([]);
  });
});

describe("emptyProfile", () => {
  it("carries the current schema version and an ISO updated_at", () => {
    const p = emptyProfile({ name: "Tester", dept: "ARL" });
    expect(p.schema_version).toBe(PROFILE_SCHEMA_VERSION);
    expect(() => new Date(p.updated_at).toISOString()).not.toThrow();
  });
});
