import { describe, it, expect } from "vitest";
import { pickApprovedTravelRequest, buildDomesticReportFields, reportIsEmpty, REPORT_CONTENT_FIELDS } from "../../src/forms/travel-report.js";

describe("pickApprovedTravelRequest", () => {
  it("picks the single matching AppFrm-023 link", () => {
    const hrefs = [
      "document_view.php?doc_id=299953&approve_type=AppFrm-023",
      "document_view.php?doc_id=12345&approve_type=AppFrm-073", // unrelated (leave)
    ];
    expect(pickApprovedTravelRequest(hrefs)).toEqual({ docId: "299953", formCode: "AppFrm-023" });
  });

  it("picks an AppFrm-026 (overseas) link and reports its form code", () => {
    const hrefs = ["document_view.php?doc_id=400100&approve_type=AppFrm-026"];
    expect(pickApprovedTravelRequest(hrefs)).toEqual({ docId: "400100", formCode: "AppFrm-026" });
  });

  it("refuses with 0 candidates when nothing matches, rather than guessing", () => {
    const r = pickApprovedTravelRequest(["document_view.php?doc_id=1&approve_type=AppFrm-073"]);
    expect("error" in r && r.candidates).toBe(0);
  });

  it("refuses with the count when more than one matches, rather than picking one", () => {
    const hrefs = [
      "document_view.php?doc_id=1&approve_type=AppFrm-023",
      "document_view.php?doc_id=2&approve_type=AppFrm-023",
    ];
    const r = pickApprovedTravelRequest(hrefs);
    expect("error" in r && r.candidates).toBe(2);
  });
});

describe("reportIsEmpty", () => {
  it("is true when every content field is blank", () => {
    const blank = Object.fromEntries(REPORT_CONTENT_FIELDS.map((k) => [k, ""]));
    expect(reportIsEmpty(blank)).toBe(true);
    expect(reportIsEmpty({})).toBe(true);
  });
  it("is false when any one content field is non-empty", () => {
    expect(reportIsEmpty({ purpose_field: "something" })).toBe(false);
    expect(reportIsEmpty({ agenda_field: "x".repeat(100) })).toBe(false);
  });
  it("treats whitespace-only as empty", () => {
    expect(reportIsEmpty({ purpose_field: "   " })).toBe(true);
  });
});

describe("buildDomesticReportFields", () => {
  const userInfo = { name: "Richard Roe", dept: "Antibacterial Resistance Lab" };

  it("never includes subject/destination/pdoc_id - they don't exist as inputs on this page", () => {
    const fields = buildDomesticReportFields({ purpose: "x".repeat(100) }, userInfo, {}, "2026-10-09");
    expect(fields).not.toHaveProperty("subject");
    expect(fields).not.toHaveProperty("pdoc_id");
    expect(fields).not.toHaveProperty("start_day");
    expect(fields).not.toHaveProperty("end_day");
  });

  it("person_field is the counterparty from persons_met, never defaulted to the writer's own name", () => {
    const withCounterparty = buildDomesticReportFields({ purpose: "x".repeat(100), persons_met: "KHIDI program officer" }, userInfo, {}, "2026-10-09");
    expect(withCounterparty.person_field).toBe("KHIDI program officer");

    const withoutCounterparty = buildDomesticReportFields({ purpose: "x".repeat(100) }, userInfo, {}, "2026-10-09");
    expect(withoutCounterparty.person_field).toBe("");
    expect(withoutCounterparty.person_field).not.toBe(userInfo.name);
  });

  it("no field defaults to the writer's own name except report_name itself", () => {
    const fields = buildDomesticReportFields({ purpose: "x".repeat(100) }, userInfo, {}, "2026-10-09");
    for (const [key, value] of Object.entries(fields)) {
      if (key === "report_name") continue;
      expect(value).not.toBe(userInfo.name);
    }
  });

  it("agenda_field/result_field fall back to purpose exactly like org-policy's length rule predicts", () => {
    const purpose = "y".repeat(100);
    const fields = buildDomesticReportFields({ purpose }, userInfo, {}, "2026-10-09");
    expect(fields.purpose_field).toBe(purpose);
    expect(fields.agenda_field).toBe(purpose); // no schedule given -> falls back to purpose
    expect(fields.result_field).toBe(`Expected outcomes: ${purpose}`); // no reason given
  });

  it("uses the explicit schedule/reason when given, not the fallback", () => {
    const fields = buildDomesticReportFields(
      { purpose: "p".repeat(100), schedule: "s".repeat(100), reason: "r".repeat(100) },
      userInfo, {}, "2026-10-09"
    );
    expect(fields.agenda_field).toBe("s".repeat(100));
    expect(fields.result_field).toBe("r".repeat(100));
  });

  it("report_name is this person's own name; report_post/leader come from env, never guessed", () => {
    const fields = buildDomesticReportFields({ purpose: "x".repeat(100) }, userInfo, { reportPost: "Post-Doc", reportLeader: "Jane Doe" }, "2026-10-09");
    expect(fields.report_name).toBe("Richard Roe");
    expect(fields.report_post).toBe("Post-Doc");
    expect(fields.report_leader).toBe("Jane Doe");
  });

  it("report_post/leader are empty, not guessed, when env doesn't set them", () => {
    const fields = buildDomesticReportFields({ purpose: "x".repeat(100) }, userInfo, {}, "2026-10-09");
    expect(fields.report_post).toBe("");
    expect(fields.report_leader).toBe("");
  });
});
