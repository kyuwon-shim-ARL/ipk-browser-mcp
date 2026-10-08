import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkFieldRules, FieldRulesUnavailable, type Rulebook } from "../../src/policy/field-rules.js";
import type { Profile } from "../../src/profile/profile.js";

// Shared with the Python port (dev/form_rules.py / scripts/extract_public_rules.py) so
// both implementations agree on the same fixtures - see tests/test_extract_public_rules.py.
const FIXTURES = join(__dirname, "..", "..", "..", "test-fixtures", "field-rules");
const fullBook = JSON.parse(readFileSync(join(FIXTURES, "full-book.json"), "utf-8"));
const publicBook = JSON.parse(readFileSync(join(FIXTURES, "public-book.json"), "utf-8"));

const GOOD = { subject: "[Card] Office Supplies", account_str: "410318", budget_code: "NN2606-0001", amount: "123" };
const RUNPOD = { ...GOOD, subject: "[Card] RunPod GPU Compute Credits" };

// Synthetic test cards, built at runtime (no literal card number sits in source) - same
// construction as tests/test_public_leak_guard.py's TEST_CARD.
const SHARED_TEST_CARD = ["4111"].concat(Array(3).fill("2222")).join("-");
const WRONG_TEST_CARD = ["0000"].concat(Array(3).fill("0000")).join("-");

describe("checkFieldRules - full local rulebook (Python-equivalent checks)", () => {
  it("passes a draft that matches every rule", () => {
    expect(checkFieldRules(fullBook, GOOD)).toEqual({ blocks: [], warnings: [] });
  });

  it("reports a violation naming the scope", () => {
    const r = checkFieldRules(fullBook, { ...GOOD, budget_code: "GW17_ARRL" });
    expect(r.blocks.some((v) => v.field === "budget_code" && v.message.includes("[self]"))).toBe(true);
  });

  it("is unavailable (fail-closed) for a field with no rule at all", () => {
    expect(() => checkFieldRules(fullBook, { ...GOOD, mystery: "x" })).toThrow(FieldRulesUnavailable);
  });

  it("a matching conditional overrides the field's own checks", () => {
    expect(checkFieldRules(fullBook, RUNPOD).blocks).toEqual([]);
    const r = checkFieldRules(fullBook, { ...RUNPOD, account_str: "999999" });
    expect(r.blocks.length).toBeGreaterThan(0);
  });
});

describe("checkFieldRules - public-only rulebook, no private pack, no profile (B2 case a)", () => {
  it("org stub fields never block even when their value is unverifiable", () => {
    const r = checkFieldRules(publicBook, GOOD);
    expect(r.blocks.filter((v) => v.field === "account_str")).toEqual([]);
    expect(r.warnings.some((v) => v.field === "account_str")).toBe(true); // team-pack missing -> warn
  });

  it("self stub field blocks and asks the person when the profile lacks the value", () => {
    const r = checkFieldRules(publicBook, GOOD); // no profile passed
    expect(r.blocks.some((v) => v.field === "budget_code" && /ask/i.test(v.message))).toBe(true);
  });

  it("public org field with real checks still enforces them", () => {
    const r = checkFieldRules(publicBook, { ...GOOD, subject: "런팟" });
    expect(r.blocks.some((v) => v.field === "subject")).toBe(true);
  });

  it("case fields are never compared", () => {
    const profile: Profile = {
      schema_version: 1, user: { name: "Tester", dept: "ARL" }, cards: [],
      budget_pots: [{ code: "NN2606-0001", source: "test" }], updated_at: "2026-01-01T00:00:00.000Z",
    };
    const r = checkFieldRules(publicBook, { ...GOOD, amount: "999999" }, { profile });
    expect(r.blocks.filter((v) => v.field === "amount")).toEqual([]);
  });
});

describe("shared card on an allowed account passes via a conditional (the mechanism a private pack uses, not the HARD check)", () => {
  it("a matching conditional for the shared card overrides the HARD self check entirely", () => {
    const book: Rulebook = {
      form: "AppFrm-999", schema_version: 1,
      fields: {
        account_str: { scope: "org", source: "team-pack", on_missing: "warn" },
        card_no: { scope: "self", source: "profile", on_missing: "block" },
      },
      // The shape of the real (local-only, never public) AppFrm-021 conditional: a
      // private pack is what would ship this, since it names a real shared card.
      // SHARED_TEST_CARD is a synthetic stand-in, never a real card number.
      conditional: [{
        when: { field: "account_str", regex: "^\\[412107\\]" },
        then: { field: "card_no", value: SHARED_TEST_CARD },
        visibility: "local",
      }],
    };
    const matching = checkFieldRules(book, { account_str: "[412107] Team Activities", card_no: SHARED_TEST_CARD }, { unknownFields: "warn" });
    expect(matching.blocks).toEqual([]); // no profile needed - the conditional decided it

    const wrongCard = checkFieldRules(book, { account_str: "[412107] Team Activities", card_no: WRONG_TEST_CARD }, { unknownFields: "warn" });
    expect(wrongCard.blocks.some((v) => v.field === "card_no")).toBe(true);

    // Without the conditional matching (a different account), the HARD self check
    // applies as normal and blocks with no profile loaded.
    const noConditional = checkFieldRules(book, { account_str: "[410318] IT Software", card_no: SHARED_TEST_CARD }, { unknownFields: "warn" });
    expect(noConditional.blocks.some((v) => v.field === "card_no")).toBe(true);
  });
});

describe("checkFieldRules - public-only rulebook with a profile (B2 case b, B4 shape)", () => {
  const profile: Profile = {
    schema_version: 1,
    user: { name: "Tester", dept: "ARL" },
    cards: [],
    budget_pots: [{ code: "NN2606-0001", source: "test" }, { code: "NN2606-0002", source: "test" }],
    updated_at: "2026-01-01T00:00:00.000Z",
  };

  it("self stub field passes when the profile's budget_pots has the code", () => {
    const r = checkFieldRules(publicBook, GOOD, { profile });
    expect(r.blocks.filter((v) => v.field === "budget_code")).toEqual([]);
  });

  it("self stub field still blocks when the profile's pots don't have the code", () => {
    const r = checkFieldRules(publicBook, { ...GOOD, budget_code: "NN2606-9999" }, { profile });
    expect(r.blocks.some((v) => v.field === "budget_code")).toBe(true);
  });

  it("a card field (card_no/credit_card_no/copcard) is compared digits-only against profile.cards", () => {
    const withCard: Profile = { ...profile, cards: [{ number: "1234-5678-9012-3456", kind: "own", holder_match: true, source: "test" }] };
    const r1 = checkFieldRules(publicBook, { ...GOOD, card_no: "1234567890123456" }, { profile: withCard });
    expect(r1.blocks.filter((v) => v.field === "card_no")).toEqual([]);
    const r2 = checkFieldRules(publicBook, { ...GOOD, card_no: "9999-9999-9999-9999" }, { profile: withCard });
    expect(r2.blocks.some((v) => v.field === "card_no")).toBe(true);
  });

  it("a card present in profile.cards as 'shared' (not 'own') blocks with the someone-else message, distinct from 'not found at all'", () => {
    const profile2: Profile = {
      schema_version: 1, user: { name: "Tester", dept: "ARL" },
      cards: [{ number: "1234-5678-9012-3456", kind: "shared", holder_match: false, source: "test" }],
      budget_pots: [], updated_at: "2026-01-01T00:00:00.000Z",
    };
    const seen = checkFieldRules(publicBook, { ...GOOD, card_no: "1234-5678-9012-3456" }, { profile: profile2 });
    const v = seen.blocks.find((x) => x.field === "card_no");
    expect(v).toBeDefined();
    expect(v!.message).toMatch(/belongs to someone else/);

    const unseen = checkFieldRules(publicBook, { ...GOOD, card_no: "0000-0000-0000-0000" }, { profile: profile2 });
    expect(unseen.blocks.find((x) => x.field === "card_no")!.message).not.toMatch(/belongs to someone else/);
  });

  it("a card with kind 'own-unconfirmed' passes the HARD check but with a warning, not silently", () => {
    const unconfirmed: Profile = { ...profile, cards: [{ number: "1234-5678-9012-3456", kind: "own-unconfirmed", holder_match: false, source: "test" }] };
    const r = checkFieldRules(publicBook, { ...GOOD, card_no: "1234-5678-9012-3456" }, { profile: unconfirmed });
    expect(r.blocks).toEqual([]);
    expect(r.warnings.some((v) => v.field === "card_no" && /unconfirmed/.test(v.message))).toBe(true);
  });

  it("an unconfigured soft self field (e.g. approver, before approval_line/env is set) warns, not blocks", () => {
    const r = checkFieldRules(publicBook, { ...GOOD, approver: "Jane Doe" }, { profile });
    expect(r.blocks.find((x) => x.field === "approver")).toBeUndefined();
    const v = r.warnings.find((x) => x.field === "approver");
    expect(v).toBeDefined();
    expect(v!.message).toMatch(/not independently verifiable/);
  });

  it("approver is soft: passes when the configured group leader matches, blocks when it differs, warns when unconfigured", () => {
    const withLeader: Profile = { ...profile, approval_line: { group_leader: "Jane Doe" } };
    const match = checkFieldRules(publicBook, { ...GOOD, approver: "Jane Doe" }, { profile: withLeader });
    expect(match.blocks).toEqual([]);
    expect(match.warnings.filter((v) => v.field === "approver")).toEqual([]);

    const mismatch = checkFieldRules(publicBook, { ...GOOD, approver: "Someone Else" }, { profile: withLeader });
    expect(mismatch.blocks.some((v) => v.field === "approver")).toBe(true);

    const unconfigured = checkFieldRules(publicBook, { ...GOOD, approver: "Jane Doe" }, { profile });
    expect(unconfigured.blocks).toEqual([]);
    expect(unconfigured.warnings.some((v) => v.field === "approver")).toBe(true);
  });
});
