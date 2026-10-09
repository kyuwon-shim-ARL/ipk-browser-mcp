import { describe, it, expect, afterEach } from "vitest";
import { ORG_POLICY, checkOrgPolicy, containsHangul } from "../../src/policy/org-policy.js";
import { violations } from "../../bench/score.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const travel = (over: Record<string, unknown> = {}) => ({
  form_type: "travel_request",
  subject: "[Request] 2026 Q3 RAPID Sample Collection",
  purpose: "Sample collection for urban microbial surveillance",
  destination: "Seoul Station, Gangnam Station",
  bound_code: "20", // Seoul is out-of-metro for IPK (Pangyo) - see SEOUL_IS_OUTSIDE_METRO
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
    // Non-Seoul destination: isolates "code-valued params are not free text" from the
    // separate SEOUL_IS_OUTSIDE_METRO rule, which would otherwise fire on bound_code '19'.
    expect(checkOrgPolicy(travel({ budget_code: "NN2602-0001", bound_code: "19", destination: "Daejeon KRISS" }))).toEqual([]);
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

describe("NO_FINAL_SUBMIT", () => {
  const prevEnv = process.env.IPK_ALLOW_SUBMIT;
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.IPK_ALLOW_SUBMIT;
    else process.env.IPK_ALLOW_SUBMIT = prevEnv;
  });

  it("refuses a real submission without explicit confirmation", () => {
    delete process.env.IPK_ALLOW_SUBMIT;
    const v = checkOrgPolicy(travel({ draft_only: false }));
    expect(v.map((x) => x.rule)).toEqual(["NO_FINAL_SUBMIT"]);
  });
  it("refuses a confirmed submission when IPK_ALLOW_SUBMIT is not set", () => {
    delete process.env.IPK_ALLOW_SUBMIT;
    const v = checkOrgPolicy(travel({ draft_only: false, confirm_submit: true }));
    expect(v.map((x) => x.rule)).toEqual(["NO_FINAL_SUBMIT"]);
  });
  it("allows a confirmed submission only once IPK_ALLOW_SUBMIT=1 is also set", () => {
    process.env.IPK_ALLOW_SUBMIT = "1";
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
    // seller_en naming RunPod on card_expense_rd also triggers VENDOR_ATTACHMENTS_REQUIRED
    // (separate rule, see that describe block) unless the attachments are present too.
    expect(
      checkOrgPolicy({
        form_type: "card_expense_rd", seller_en: "RunPod Inc.", trseq: "1", appr_no: "2", draft_only: true,
        attachment_paths: [
          "/home/u/data/attachments/260920_Runpod-invoice_signed.pdf",
          "/home/u/data/attachments/260920_Runpod_CC_sales_slip.pdf",
          "/home/u/data/attachments/260920_Runpod_daily_usage.png",
          "/home/u/data/attachments/260920_Runpod-receipt.pdf",
        ],
      }).map((x) => x.rule)
    ).not.toContain("OVERSEAS_IT_VAT_ZERO");
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

describe("SEOUL_IS_OUTSIDE_METRO", () => {
  it("refuses a Seoul travel_request filed as bound_code '19' (within metro)", () => {
    const v = checkOrgPolicy(travel({ bound_code: "19" }));
    expect(v.map((x) => x.rule)).toContain("SEOUL_IS_OUTSIDE_METRO");
    expect(v.find((x) => x.rule === "SEOUL_IS_OUTSIDE_METRO")!.fields).toEqual(["bound_code", "destination"]);
  });
  it("refuses when bound_code is missing entirely", () => {
    const v = checkOrgPolicy(travel({ bound_code: undefined }));
    expect(v.map((x) => x.rule)).toContain("SEOUL_IS_OUTSIDE_METRO");
  });
  it("passes a Seoul trip filed as bound_code '20' (out of metro)", () => {
    expect(checkOrgPolicy(travel({ bound_code: "20" }))).toEqual([]);
  });
  it("matches 서울 in Korean too (even though ENGLISH_ONLY will also fire)", () => {
    const v = checkOrgPolicy(travel({ destination: "서울역", bound_code: "19" }));
    expect(v.map((x) => x.rule)).toContain("SEOUL_IS_OUTSIDE_METRO");
  });
  it("does not fire for a non-Seoul destination", () => {
    expect(checkOrgPolicy(travel({ destination: "Daejeon KRISS", bound_code: "19" }))).toEqual([]);
  });
  it("does not fire for other form types", () => {
    expect(checkOrgPolicy({ form_type: "card_expense_rd", destination: "Seoul", bound_code: "19", trseq: "1", appr_no: "2", draft_only: true })).toEqual([]);
  });
});

describe("VENDOR_ATTACHMENTS_REQUIRED (card_expense_rd)", () => {
  const runpodEr = (over: Record<string, unknown> = {}) => ({
    form_type: "card_expense_rd",
    trseq: "1",
    appr_no: "2",
    item_name: "RunPod GPU usage",
    draft_only: true,
    ...over,
  });
  const ALL_FOUR = [
    "/home/u/data/attachments/2609/runpod/260920_Runpod-invoice_signed.pdf",
    "/home/u/data/attachments/2609/runpod/260920_Runpod_CC_sales_slip.pdf",
    "/home/u/data/attachments/2609/runpod/260920_Runpod_daily_usage.png",
    "/home/u/data/attachments/2609/runpod/260920_Runpod-receipt.pdf",
  ];

  it("passes a RunPod ER with all 4 attachment kinds", () => {
    expect(checkOrgPolicy(runpodEr({ attachment_paths: ALL_FOUR }))).toEqual([]);
  });
  it("refuses a RunPod ER missing attachments, listing which kinds", () => {
    const v = checkOrgPolicy(runpodEr({ attachment_paths: [ALL_FOUR[0], ALL_FOUR[2]] })); // invoice + daily_usage only
    expect(v.map((x) => x.rule)).toEqual(["VENDOR_ATTACHMENTS_REQUIRED"]);
    const missingPart = v[0].message.split("missing:")[1];
    expect(missingPart).toMatch(/card sales slip/i);
    expect(missingPart).toMatch(/receipt/i);
    expect(missingPart).not.toMatch(/signed invoice/i); // present, not listed as missing
    expect(missingPart).not.toMatch(/daily usage/i); // present, not listed as missing
  });
  it("refuses a RunPod ER with no attachments at all", () => {
    const v = checkOrgPolicy(runpodEr());
    expect(v.map((x) => x.rule)).toEqual(["VENDOR_ATTACHMENTS_REQUIRED"]);
  });
  it("matches the vendor via seller_en/item_vendor too, not just item_name", () => {
    expect(checkOrgPolicy(runpodEr({ item_name: "GPU compute", seller_en: "RunPod Inc.", attachment_paths: ALL_FOUR }))).toEqual([]);
    expect(checkOrgPolicy(runpodEr({ item_name: "GPU compute", seller_en: "RunPod Inc." })).map((x) => x.rule)).toEqual(["VENDOR_ATTACHMENTS_REQUIRED"]);
  });
  it("does not fire for a vendor with no configured attachment requirement", () => {
    expect(checkOrgPolicy(runpodEr({ item_name: "Office supplies from Office Depot" }))).toEqual([]);
  });
  it("does not fire for other form types", () => {
    // expense + RunPod also trips OVERSEAS_IT_VAT_ZERO (a separate, correct rule) - the
    // point here is specifically that VENDOR_ATTACHMENTS_REQUIRED stays card_expense_rd-only.
    expect(checkOrgPolicy({ form_type: "expense", item_vendor: "RunPod Inc.", amount: 1000, draft_only: true }).map((x) => x.rule)).not.toContain("VENDOR_ATTACHMENTS_REQUIRED");
  });
});

describe("NO_REPORT_FOR_DAY_TRIP (travel = domestic travel report)", () => {
  const report = (over: Record<string, unknown> = {}) => ({
    form_type: "travel",
    pdoc_id: "299953",
    purpose: "x".repeat(100),
    schedule: "x".repeat(100),
    reason: "x".repeat(100),
    start_date: "2026-09-14",
    end_date: "2026-09-16", // 2 nights
    draft_only: true,
    ...over,
  });

  it("passes a 2-night (2박3일) trip", () => {
    expect(checkOrgPolicy(report())).toEqual([]);
  });
  it("refuses a same-day (0-night) trip", () => {
    const v = checkOrgPolicy(report({ end_date: "2026-09-14" }));
    expect(v.map((x) => x.rule)).toContain("NO_REPORT_FOR_DAY_TRIP");
  });
  it("refuses a 1-night trip too (only 2N3D+ gets a report)", () => {
    const v = checkOrgPolicy(report({ end_date: "2026-09-15" }));
    expect(v.map((x) => x.rule)).toContain("NO_REPORT_FOR_DAY_TRIP");
  });
  it("does not fire when dates are absent (nothing to compute yet)", () => {
    expect(checkOrgPolicy(report({ start_date: undefined, end_date: undefined })).map((x) => x.rule)).not.toContain("NO_REPORT_FOR_DAY_TRIP");
  });
  it("does not fire for other form types", () => {
    expect(checkOrgPolicy(travel({ start_date: "2026-09-14", end_date: "2026-09-14" })).map((x) => x.rule)).not.toContain("NO_REPORT_FOR_DAY_TRIP");
  });
});

describe("TRAVEL_REPORT_FIELDS_MIN_LENGTH (travel_report_write.php's own >=100 char rule)", () => {
  const report = (over: Record<string, unknown> = {}) => ({
    form_type: "travel",
    pdoc_id: "299953",
    purpose: "x".repeat(100),
    schedule: "x".repeat(100),
    reason: "x".repeat(100),
    start_date: "2026-09-14",
    end_date: "2026-09-16",
    draft_only: true,
    ...over,
  });

  it("passes when purpose/schedule/reason are each >=100 chars", () => {
    expect(checkOrgPolicy(report())).toEqual([]);
  });
  it("refuses short fields, naming which ones (mirrors submitTravel's own fallbacks)", () => {
    const v = checkOrgPolicy(report({ purpose: "short purpose", schedule: undefined, reason: undefined }));
    // schedule falls back to purpose (agenda_field), reason falls back to "Expected outcomes: <purpose>" (result_field)
    expect(v.map((x) => x.rule)).toEqual(["TRAVEL_REPORT_FIELDS_MIN_LENGTH"]);
    expect(v[0].fields).toEqual(["purpose_field", "agenda_field", "result_field"]);
  });
  it("a short purpose still fails purpose_field even with long schedule/reason - schedule/reason only fall back TO purpose, not the reverse", () => {
    const v = checkOrgPolicy(report({ purpose: "short", schedule: "x".repeat(100), reason: "y".repeat(100) }));
    expect(v.map((x) => x.rule)).toEqual(["TRAVEL_REPORT_FIELDS_MIN_LENGTH"]);
    expect(v[0].fields).toEqual(["purpose_field"]);
  });
  it("does not fire for other form types", () => {
    expect(checkOrgPolicy(travel({ purpose: "short" })).map((x) => x.rule)).not.toContain("TRAVEL_REPORT_FIELDS_MIN_LENGTH");
  });
});

describe("audit trail carries values for every select path", () => {
  it("selectExistingOption logs value and label like setRequiredSelect does", () => {
    const src = readFileSync(join(__dirname, "..", "..", "src", "tools", "ipk-submit.ts"), "utf8");
    const fn = src.slice(src.indexOf("async function selectExistingOption"), src.indexOf("async function selectRadio"));
    expect(fn).toMatch(/audit\(\{ action: "option_select", field: fieldName, value, label: last\.label/);
  });
});
