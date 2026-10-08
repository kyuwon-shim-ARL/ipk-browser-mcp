import { describe, it, expect } from "vitest";
import { ORG_POLICY, checkOrgPolicy, containsHangul } from "../../src/policy/org-policy.js";
import { violations } from "../../bench/score.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const travel = (over: Record<string, unknown> = {}) => ({
  form_type: "travel_request",
  subject: "[Request] 2026 Q3 RAPID Sample Collection",
  purpose: "Sample collection for urban microbial surveillance",
  destination: "Seoul Station, Gangnam Station",
  draft_only: true,
  ...over,
});

describe("org policy registry", () => {
  it("every rule states the organisational standard and its pass criterion", () => {
    expect(ORG_POLICY.length).toBeGreaterThan(0);
    for (const r of ORG_POLICY) {
      expect(r.id).toMatch(/^[A-Z_]+$/);
      expect(r.standard.length).toBeGreaterThan(10);
      expect(r.passes.length).toBeGreaterThan(10);
      expect(typeof r.check).toBe("function");
    }
  });
});

describe("ENGLISH_ONLY", () => {
  it("refuses Korean in free-text fields (the doc 299905 case)", () => {
    const v = checkOrgPolicy(
      travel({
        purpose: "도시 환경 내 미생물 군집 분석을 위한 시료채취",
        destination: "분당서울대병원, 강남역",
      })
    );
    expect(v.map((x) => x.rule)).toContain("ENGLISH_ONLY");
    const e = v.find((x) => x.rule === "ENGLISH_ONLY")!;
    expect(e.fields).toEqual(["purpose", "destination"]);
  });

  it("passes English text and ignores code-valued params", () => {
    expect(checkOrgPolicy(travel({ budget_code: "NN2602-0001", bound_code: "19" }))).toEqual([]);
  });

  it("refuses Korean in a card_expense_rd team-activity venue/participants", () => {
    const v = checkOrgPolicy({
      form_type: "card_expense_rd",
      trseq: "1",
      appr_no: "2",
      item_account_code: "412107",
      venue: "ARL 회의실",
      participants: "장수진, 김철수",
      meeting_begin: "2026-09-28 09:30",
      meeting_end: "2026-09-28 11:00",
      purpose_minutes: "Quarterly lunch",
      draft_only: true,
    });
    expect(v.map((x) => x.rule)).toContain("ENGLISH_ONLY");
    expect(v.find((x) => x.rule === "ENGLISH_ONLY")!.fields).toEqual(["participants", "venue"]);
  });

  it("containsHangul detects syllables and jamo, not CJK-free strings", () => {
    expect(containsHangul("관내")).toBe(true);
    expect(containsHangul("ㅋㅋ")).toBe(true);
    expect(containsHangul("Within Metropolitan")).toBe(false);
    expect(containsHangul("")).toBe(false);
  });
});

describe("DRAFT_FIRST", () => {
  it("refuses a real submission without explicit confirmation", () => {
    const v = checkOrgPolicy(travel({ draft_only: false }));
    expect(v.map((x) => x.rule)).toEqual(["DRAFT_FIRST"]);
  });
  it("allows a confirmed submission", () => {
    expect(checkOrgPolicy(travel({ draft_only: false, confirm_submit: true }))).toEqual([]);
  });
});

describe("OVERSEAS_IT_VAT_ZERO", () => {
  it("refuses an expense form that would split VAT for an overseas IT vendor", () => {
    const v = checkOrgPolicy({
      form_type: "expense",
      item_vendor: "RunPod Inc.",
      item_description: "GPU cloud usage",
      amount: 110000,
      draft_only: true,
    });
    expect(v.map((x) => x.rule)).toEqual(["OVERSEAS_IT_VAT_ZERO"]);
  });
  it("does not fire for domestic vendors or forms that take VAT from the receipt", () => {
    expect(
      checkOrgPolicy({ form_type: "expense", item_vendor: "Baemin", amount: 33000, draft_only: true })
    ).toEqual([]);
    expect(
      checkOrgPolicy({ form_type: "card_expense_rd", seller_en: "RunPod Inc.", trseq: "1", appr_no: "2", draft_only: true })
    ).toEqual([]);
  });
});

describe("NO_GENERATED_EVIDENCE", () => {
  it("refuses a script-produced file in /tmp or a scratchpad as evidence", () => {
    const v = checkOrgPolicy(travel({ attachment_path: "/tmp/RAPID_2026_Q3_sampling_approval.pdf" }));
    expect(v.map((x) => x.rule)).toEqual(["NO_GENERATED_EVIDENCE"]);
    expect(checkOrgPolicy(travel({ attachment_paths: ["/tmp/claude-1004/x/scratchpad/a.pdf"] }))[0].rule).toBe("NO_GENERATED_EVIDENCE");
  });
  it("accepts the person's own file from Downloads or data/attachments", () => {
    expect(checkOrgPolicy(travel({ attachment_path: "/home/u/Downloads/2026_Q3_RAPID_sampling을_위한_국내_출장.pdf" }))).toEqual([]);
    expect(checkOrgPolicy(travel({ attachment_path: "/home/u/projects/ipk-browser-mcp/data/attachments/2609/rapid/x.pdf" }))).toEqual([]);
  });
});

const cardRD = (over: Record<string, unknown> = {}) => ({
  form_type: "card_expense_rd",
  trseq: "0069AKW950001",
  appr_no: "21580194",
  item_account_code: "412107",
  venue: "ARL 3rd floor meeting room",
  meeting_begin: "2026-09-28 09:30",
  meeting_end: "2026-09-28 11:00",
  participants: "Jang, Kim, Lee",
  purpose_minutes: "Quarterly team lunch to discuss Q3 results",
  draft_only: true,
  ...over,
});

describe("TEAM_ACTIVITY_FIELDS_REQUIRED (every meeting account)", () => {
  it("passes a complete team-activity card_expense_rd", () => {
    expect(checkOrgPolicy(cardRD())).toEqual([]);
  });
  it("refuses when account 412107 is missing meeting fields", () => {
    const v = checkOrgPolicy(cardRD({ meeting_begin: undefined, meeting_end: undefined, venue: undefined }));
    expect(v.map((x) => x.rule)).toEqual(["TEAM_ACTIVITY_FIELDS_REQUIRED"]);
    expect(v[0].fields).toEqual(["venue", "meeting_begin", "meeting_end"]);
  });
  it("fires when the account is picked by label instead of code", () => {
    const v = checkOrgPolicy(cardRD({ item_account_code: undefined, account_code_label: "Team Activities", venue: undefined }));
    expect(v.map((x) => x.rule)).toEqual(["TEAM_ACTIVITY_FIELDS_REQUIRED"]);
    expect(v[0].fields).toEqual(["venue"]);
  });
  it("falls back to purpose when purpose_minutes is absent", () => {
    expect(checkOrgPolicy(cardRD({ purpose_minutes: undefined, purpose: "Quarterly team lunch" }))).toEqual([]);
  });
  it("requires the same fields for other meeting accounts, not just 412107", () => {
    for (const code of ["420421", "410310", "412104"]) {
      const v = checkOrgPolicy(cardRD({ item_account_code: code, venue: undefined, meeting_begin: undefined, meeting_end: undefined, participants: undefined, purpose_minutes: undefined }));
      expect(v.map((x) => x.rule)).toEqual(["TEAM_ACTIVITY_FIELDS_REQUIRED"]);
      expect(v[0].fields).toEqual(["venue", "meeting_begin", "meeting_end", "participants", "purpose_minutes"]);
      expect(v[0].message).toMatch(new RegExp(`Meeting account ${code}`));
    }
    expect(checkOrgPolicy(cardRD({ item_account_code: "420421" }))).toEqual([]);
  });
  it("label fallback covers meeting labels other than Team Activities", () => {
    const v = checkOrgPolicy(cardRD({ item_account_code: undefined, account_code_label: "Meeting Expenses", participants: undefined }));
    expect(v[0].fields).toEqual(["participants"]);
  });
  it("does not fire for a non-meeting account code on card_expense_rd", () => {
    expect(
      checkOrgPolicy({
        form_type: "card_expense_rd",
        trseq: "1",
        appr_no: "2",
        item_account_code: "410318",
        draft_only: true,
      })
    ).toEqual([]);
  });
  it("does not fire for other form types", () => {
    expect(checkOrgPolicy(travel({ item_account_code: "412107" }))).toEqual([]);
  });
});

describe("bench scorer applies the same standard to the audit trail", () => {
  it("counts a Korean field_write as an M6 policy violation", () => {
    const events = [
      { action: "field_write", field: '[name="purpose"]', value: "시료채취", hidden: false, ok: true },
      { action: "field_write", field: '[name="subject"]', value: "[Request] Sampling", hidden: false, ok: true },
      // Labels of options the form itself offered may be Korean; only what we typed counts.
      { action: "option_select", field: "bound_code", value: "19", label: "Within Metropolitan (관내)", fromOfferedOptions: true, ok: true },
      // A value the handler copied off the groupware (a display name) is not policed by the scorer either.
      { action: "field_write", field: 'input[name="substitute_name"]', value: "홍길동", hidden: false, ok: true },
    ];
    const v = violations(events);
    expect(v.map((x) => x.code)).toEqual(["KOREAN_TEXT_WRITTEN"]);
  });
  it("counts a select the form hid as a violation, and requires selects to log their value", () => {
    const v = violations([
      { action: "option_select", field: "province_code", value: "02", label: "Seoul", fromOfferedOptions: true, hidden: true, ok: true },
      { action: "option_select", field: "city_code", value: "192", label: "Seoul", fromOfferedOptions: true, hidden: false, ok: true },
      // A select another form keeps hidden by design is still posted: not a violation.
      { action: "option_select", field: 'select[name="using_type[]"]', value: "1", label: "x", fromOfferedOptions: true, hidden: true, ok: true },
    ]);
    expect(v.map((x) => x.code)).toEqual(["SELECT_HIDDEN_BY_FORM"]);
  });
});

describe("audit trail carries values for every select path", () => {
  it("selectExistingOption logs value and label like setRequiredSelect does", () => {
    const src = readFileSync(join(__dirname, "..", "..", "src", "tools", "ipk-submit.ts"), "utf8");
    const fn = src.slice(src.indexOf("async function selectExistingOption"), src.indexOf("async function selectRadio"));
    expect(fn).toMatch(/audit\(\{ action: "option_select", field: fieldName, value, label: last\.label/);
  });
});
