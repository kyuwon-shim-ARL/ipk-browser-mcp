/**
 * Integration tests against the REAL shipped rulebooks (rules/public/AppFrm-*.json),
 * not the synthetic AppFrm-999 fixture - see field-rules.test.ts for the unit-level
 * (B1-B3) tests. These exist because the first version of this wiring passed the MCP
 * call's params (form_type, draft_only, confirm_submit, ...) to checkFieldRules instead
 * of the live form's own DOM fields; every save on a wired form was refused as
 * FORM_RULE_VIOLATION, and the synthetic fixtures (flat, hand-picked keys) never
 * exercised a real rulebook's full field set to catch it.
 *
 * Draft objects below are shaped the way src/browser/iframe-helper.ts
 * serializeFormFields() actually produces them: DOM names, repeating `name[]` rows as
 * string[] with an empty leading "template row" entry, synthetic values only (dummy
 * card 1234-5678-9012-3456, no real names/cards/amounts).
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkFieldRules, type Rulebook } from "../../src/policy/field-rules.js";
import { checkFieldRulesAgainstForm } from "../../src/tools/ipk-submit.js";
import { emptyProfile, type Profile } from "../../src/profile/profile.js";

const RULES_PUBLIC = join(__dirname, "..", "..", "..", "rules", "public");
const loadReal = (appFrm: string): Rulebook => JSON.parse(readFileSync(join(RULES_PUBLIC, `${appFrm}.json`), "utf-8"));

const DUMMY_CARD = "1234-5678-9012-3456";

/** A profile with the one card and one pot these tests use (B4). Self-scope fields not
 *  yet mapped in field-rules.ts's SELF_FIELD_CHECKS (budget_type, approver,
 *  substitute_*, emergency_*, edu_member, ...) block regardless of what's in here -
 *  that is the documented, correct behaviour until they get a mapping, not a test bug. */
function testProfile(): Profile {
  const p = emptyProfile({ name: "Tester", dept: "ARL" });
  p.cards.push({ number: DUMMY_CARD, kind: "own", holder_match: true, source: "test" });
  p.budget_pots.push({ code: "NN2606-0001", source: "test" });
  return p;
}

describe("card_expense_rd (AppFrm-021) against the real public rulebook", () => {
  const book = loadReal("AppFrm-021");
  const profile = testProfile();

  const goodDraft = () => ({
    subject: "[Card] Office Supplies",
    budget_type: "R&D",
    budget_code: "NN2606-0001",
    payment: "Corporate Credit Card",
    card_no: DUMMY_CARD,
    "invoice[]": ["", "2026-10-01"],
    "item_desc[]": ["", "none"],
    "account_str[]": ["", "[410201] Office Supplies"],
    "item_name[]": ["", "Stationery supplies"],
    "item_qty[]": ["", "1"],
    "item_amount_ral1[]": ["", "35000"],
    "item_amount_vat[]": ["", "split"],
    "item_amount[]": ["", "35000"],
    "control_no[]": ["", "26012345"],
    "seller_korea[]": ["", "오피스디포"],
    "seller[]": ["", "Office Depot"],
    p_reason: "Office supplies purchase",
    notes: "",
    "vender[]": ["", "26012345"],
  });

  it("(a) a correct draft with the dummy card in the profile passes with 0 blocks", () => {
    const r = checkFieldRules(book, goodDraft(), { profile, unknownFields: "warn" });
    expect(r.blocks).toEqual([]);
  });

  it("(b) the account rule fires for a shipping item coded to the wrong account", () => {
    const draft = {
      ...goodDraft(),
      "item_name[]": ["", "FedEx Shipping Fee"],
      // Should be [410911] Commission per the shipping conditional; left as a plain account.
      "account_str[]": ["", "[410201] Office Supplies"],
    };
    const r = checkFieldRules(book, draft, { profile, unknownFields: "warn" });
    expect(r.blocks.some((v) => v.field === "account_str[]")).toBe(true);
  });

  it("(c) an extra field the rulebook doesn't know about is a warning, not a block", () => {
    const draft = { ...goodDraft(), mystery_widget: "a value the colleague corpus never showed" };
    const r = checkFieldRules(book, draft, { profile, unknownFields: "warn" });
    expect(r.blocks).toEqual([]);
    expect(r.warnings.some((v) => v.field.includes("mystery_widget"))).toBe(true);
  });

  it("the dummy card is a stand-in, never a real one, anywhere in this test file's fixtures", () => {
    expect(DUMMY_CARD).toBe("1234-5678-9012-3456");
  });
});

describe("budget_transfer (AppFrm-039) against the real public rulebook - minimal good draft", () => {
  const book = loadReal("AppFrm-039");
  const profile = testProfile();

  it("passes with 0 blocks (budget_code mapped and present); subject is an org team-pack stub, warns only", () => {
    const draft = {
      subject: "Budget transfer request",
      request_type: "Transfer",
      budget_code: "NN2606-0001",
      source_account: "anything",
      target_account: "[ 410201] Domestic Business Travel",
      amount1: "10000",
      control_no: "26012345",
      contents_data: "Budget transfer for domestic travel",
      retention: "5",
    };
    const r = checkFieldRules(book, draft, { profile, unknownFields: "warn" });
    expect(r.blocks).toEqual([]);
    expect(r.warnings.some((v) => v.field === "subject")).toBe(true);
  });
});

describe("travel_settlement (AppFrm-054) against the real public rulebook - minimal good draft", () => {
  const book = loadReal("AppFrm-054");
  const profile = testProfile();

  it("passes with 0 blocks; budget_type (unmapped) and subject (team-pack) only warn", () => {
    const draft = {
      subject: "[Settlement] Vendor technical meeting",
      budget_type: "R&D",
      budget_code: "NN2606-0001",
      item_no: "410201",
      daily_fee_card: "0",
      food_fee_card: "0",
      province: "Seoul",
      food_fee_sum: "0",
      "attach_row:verification": "receipt.pdf",
    };
    const r = checkFieldRules(book, draft, { profile, unknownFields: "warn" });
    expect(r.blocks).toEqual([]);
    expect(r.warnings.map((v) => v.field).sort()).toEqual(["budget_type", "subject"].sort());
  });
});

describe("checkFieldRulesAgainstForm reads the live form, never the MCP call's params", () => {
  it("(d) serializes the frame's own DOM fields - its signature has no params argument to leak", async () => {
    // checkFieldRulesAgainstForm(frame, formType) takes no `params`: it is structurally
    // impossible for form_type/draft_only/confirm_submit (or any other MCP-only name) to
    // reach checkFieldRules through this function, because nothing here ever sees them.
    expect(checkFieldRulesAgainstForm.length).toBe(2);

    const evaluate = vi.fn(async () => ({
      // DOM names only - exactly what serializeFormFields reads off the real card_expense_rd
      // form, never form_type/draft_only/confirm_submit.
      subject: "[Card] Office Supplies",
      budget_type: "R&D",
      budget_code: "NN2606-0001",
      payment: "Corporate Credit Card",
      card_no: DUMMY_CARD,
    }));
    const frame = { evaluate } as any;

    const refusal = await checkFieldRulesAgainstForm(frame, "card_expense_rd");

    // The frame's DOM was actually read (the serializer calls frame.evaluate) ...
    expect(evaluate).toHaveBeenCalled();
    // ... and MCP-only param names never appear in what gets checked: a refusal naming
    // form_type/draft_only would mean params leaked in, as the first (reported-and-fixed)
    // version of this wiring did.
    const names = JSON.stringify(refusal ?? {});
    expect(names).not.toMatch(/form_type|draft_only|confirm_submit/);
  });
});

describe("travel_request (AppFrm-023) against the real public rulebook - minimal good draft", () => {
  const book = loadReal("AppFrm-023");
  const profile = testProfile();

  it("every mapped self field (copcard -> cards, budget_code -> budget_pots) passes with 0 blocks; budget_type has no mapping yet and only warns", () => {
    const draft = {
      subject: "[Request] Vendor technical meeting",
      bound_code: "20",
      province_code: "Seoul",
      city_code: "Gangnam",
      travel_type_code: "Other Public Transporation",
      purpose_type: "Technical meeting",
      copcard: DUMMY_CARD,
      purpose: "Technical discussion with a vendor about equipment specifications.",
      "travel_dest[]": ["Seoul(VendorCo)"],
      daily_stand: "20000",
      food_stand: "0",
      notes: "",
      budget_type: "R&D",
      budget_code: "NN2606-0001",
      item_no: "Domestic Business Travel[410201]",
    };
    const r = checkFieldRules(book, draft, { profile, unknownFields: "warn" });
    expect(r.blocks).toEqual([]);
    expect(r.warnings.some((v) => v.field === "budget_type")).toBe(true);
  });
});

describe("leave (AppFrm-073) against the real public rulebook", () => {
  const book = loadReal("AppFrm-073");

  const draft = {
    subject: "Annual Leave, 2026-11-02~2026-11-02, Home, Richard Roe",
    "leave_kind[]": ["Annual"],
    "using_type[]": ["Full day"],
    "begin_date[]": ["2026-11-02"],
    "end_date[]": ["2026-11-02"],
    "start_time[]": [""],
    "end_time[]": [""],
    purpose: "Personal matters",
    destination: "Home",
    approver: "Jane Doe",
    substitute_name: "Jane Doe",
    substitute_payroll: "00000",
    substitute_position: "ARL/Researcher",
    substitute_contact: "031-8018-0000",
    emergency_address: "123 Example St, Seongnam",
    emergency_telephone: "010-0000-0000",
  };

  it("with nothing configured: subject/purpose/destination pass; every self field warns (not configured), 0 blocks", () => {
    const profile = emptyProfile({ name: "Tester", dept: "ARL" });
    const r = checkFieldRules(book, draft, { profile, unknownFields: "warn" });
    expect(r.blocks).toEqual([]);
    const warnedFields = r.warnings.map((v) => v.field).sort();
    expect(warnedFields).toEqual([
      "approver", "emergency_address", "emergency_telephone",
      "substitute_contact", "substitute_name", "substitute_payroll", "substitute_position",
    ].sort());
  });

  it("with approver/substitute configured (profile.approval_line) and emergency contact configured (env): the same good draft passes with 0 blocks and 0 warnings for those fields", () => {
    const profile = emptyProfile({ name: "Tester", dept: "ARL" });
    profile.approval_line = { group_leader: "Jane Doe", substitute: "Jane Doe" };
    const env = { IPK_EMERGENCY_ADDRESS: "123 Example St, Seongnam", IPK_EMERGENCY_TELEPHONE: "010-0000-0000" };
    const r = checkFieldRules(book, draft, { profile, env, unknownFields: "warn" });
    expect(r.blocks).toEqual([]);
    expect(r.warnings.filter((v) => ["approver", "substitute_name", "emergency_address", "emergency_telephone"].includes(v.field))).toEqual([]);
    // substitute_payroll/position/contact still have no mapping at all - they warn, never block.
    expect(r.warnings.map((v) => v.field).sort()).toEqual(["substitute_contact", "substitute_payroll", "substitute_position"].sort());
  });

  it("a configured approver that doesn't match the DOM value blocks (wrong person), not warns", () => {
    const profile = emptyProfile({ name: "Tester", dept: "ARL" });
    profile.approval_line = { group_leader: "A Different Person" };
    const r = checkFieldRules(book, draft, { profile, unknownFields: "warn" });
    expect(r.blocks.some((v) => v.field === "approver")).toBe(true);
  });
});

describe("working (AppFrm-074) against the real public rulebook - minimal good draft (B0: was wrongly AppFrm-027)", () => {
  const book = loadReal("AppFrm-074");

  it("subject/reason/app_dt[]/working_time[] pass; the self identity fields (no mapping yet) only warn, 0 blocks", () => {
    const profile = emptyProfile({ name: "Tester", dept: "ARL" });
    const draft = {
      subject: "Application for Working on 2026-11-07, Richard Roe",
      reason: "Nextflow based urban metagenomic surveillance pipeline optimization",
      "app_dt[]": ["2026-11-07"],
      "working_time[]": ["02:00"],
      user_nm: "Richard Roe",
      user_emp_no: "00000",
      division_nm: "Research Division",
      group_nm: "ARL",
      grade_nm: "Post-Doc",
      position_nm: "Post-Doc",
      "view:Approval (2) Team Head (R)": "Jane Doe",
    };
    const r = checkFieldRules(book, draft, { profile, unknownFields: "warn" });
    expect(r.blocks).toEqual([]);
    expect(r.warnings.map((v) => v.field).sort()).toEqual([
      // user_emp_no is in the rulebook's `ignore` list (not a self field it tracks) -
      // see rules/public/AppFrm-074.json.
      "user_nm", "division_nm", "group_nm", "grade_nm", "position_nm", "view:Approval (2) Team Head (R)",
    ].sort());
  });

  it("an out-of-range working_time[] value blocks (not among the form's own 01:00-12:00 options)", () => {
    const r = checkFieldRules(book, {
      subject: "Application for Working on 2026-11-07, Richard Roe",
      reason: "Nextflow based urban metagenomic surveillance pipeline optimization",
      "app_dt[]": ["2026-11-07"],
      "working_time[]": ["13:00"],
    }, { unknownFields: "warn" });
    expect(r.blocks.some((v) => v.field === "working_time[]")).toBe(true);
  });
});
