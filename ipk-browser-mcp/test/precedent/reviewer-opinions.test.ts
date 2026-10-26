import { describe, it, expect } from "vitest";
import { extractProcessingOpinions, clusterOpinions, type ProcessingOpinion } from "../../src/precedent/reviewer-opinions.js";

// Synthetic document_view.php body text - same tab-separated layout as the real fixtures
// in test/fixtures/card-er-location/ (document-view.ts's parsers), with made-up names.
function doc(opts: { drafter: string; processor: string; processorDept: string; text: string; otherApproverText?: string }): string {
  return (
    `Approval\t( 1 )\t( 2 )\n` +
    `A Person in Charge\tTeam Head\n` +
    `\t\n` +
    `${opts.drafter}\tSomeone Else\n` +
    `2026-10-01\t2026-10-01\n` +
    `Takeover\n` +
    `( 5 )\n` +
    `${opts.processorDept}\n` +
    `[Sign]\n` +
    `Team Member\n` +
    ` \n\n` +
    `Opinion of approval\t${opts.drafter} (Antibacterial Resistance Lab - Team Member) 2026-10-01 09:00:00\n` +
    `[No opinion]\n` +
    `${opts.otherApproverText ? `Someone Else (Other Dept - Role) 2026-10-01 10:00:00\n${opts.otherApproverText}\n` : ""}` +
    `${opts.processor} (${opts.processorDept} - Team Member) 2026-10-01 11:00:00\n` +
    `${opts.text}\n` +
    `Document Modify History\t${opts.drafter} - 2026-10-01 09:00:00\n`
  );
}

describe("extractProcessingOpinions", () => {
  it("keeps the processing department's opinion, by exact Takeover match", () => {
    const body = doc({ drafter: "Drafter A", processor: "Reviewer X", processorDept: "Budget Planning & Finance", text: "please attach the fee table" });
    const result = extractProcessingOpinions("1", "Drafter A", "card_expense_rd", "410306", body);
    expect(result.opinions).toHaveLength(1);
    expect(result.opinions[0].department).toBe("Budget Planning & Finance");
    expect(result.opinions[0].text).toMatch(/fee table/);
    expect(result.unmatchedDepartments).toEqual([]);
  });

  it("matches via a known alias (BPF)", () => {
    const body = doc({ drafter: "Drafter A", processor: "Reviewer X", processorDept: "BPF", text: "please attach the program" });
    const result = extractProcessingOpinions("1", "Drafter A", "card_expense_rd", "410306", body);
    expect(result.opinions).toHaveLength(1);
  });

  it("reports an unknown department as unmatched rather than guessing a match", () => {
    const body = doc({
      drafter: "Drafter A", processor: "Reviewer X", processorDept: "Budget Planning & Finance",
      text: "ok", otherApproverText: "unrelated comment",
    });
    const result = extractProcessingOpinions("1", "Drafter A", "card_expense_rd", "410306", body);
    expect(result.unmatchedDepartments).toContain("Other Dept");
  });

  it("excludes the drafter's own follow-up reply", () => {
    const body = doc({ drafter: "Drafter A", processor: "Budget Planning & Finance", processorDept: "Budget Planning & Finance", text: "added the file" });
    // processor name intentionally equals drafter name here to exercise the self-exclusion
    const result = extractProcessingOpinions("1", "Budget Planning & Finance", "card_expense_rd", "410306", body);
    expect(result.opinions).toHaveLength(0);
  });

  it("returns nothing when the document has no Takeover step", () => {
    const result = extractProcessingOpinions("1", "Drafter A", "card_expense_rd", "410306", "Subject\t[Card] Test\n");
    expect(result.opinions).toEqual([]);
    expect(result.unmatchedDepartments).toEqual([]);
  });
});

describe("clusterOpinions", () => {
  const op = (docId: string, drafter: string, text: string): ProcessingOpinion => ({
    docId, drafter, formType: "card_expense_rd", accountCode: "410306", department: "Budget Planning & Finance", text,
  });

  it("flags a near-identical request repeated by >=2 different drafters as a rule candidate", () => {
    const opinions = [
      op("1", "Drafter A", "please attach the fee table for the conference"),
      op("2", "Drafter B", "please attach fee table for conference"),
    ];
    const candidates = clusterOpinions(opinions);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].docIds.sort()).toEqual(["1", "2"]);
    expect(candidates[0].drafters.sort()).toEqual(["Drafter A", "Drafter B"]);
  });

  it("does NOT flag the same drafter repeating a request across docs - not evidence of an org-wide rule", () => {
    const opinions = [
      op("1", "Drafter A", "please attach the fee table"),
      op("2", "Drafter A", "please attach the fee table"),
    ];
    expect(clusterOpinions(opinions)).toEqual([]);
  });

  it("does NOT flag a single occurrence", () => {
    expect(clusterOpinions([op("1", "Drafter A", "please attach the fee table")])).toEqual([]);
  });

  it("does NOT cluster unrelated requests together", () => {
    const opinions = [
      op("1", "Drafter A", "please attach the fee table"),
      op("2", "Drafter B", "the budget code is wrong, please fix"),
    ];
    expect(clusterOpinions(opinions)).toEqual([]);
  });

  it("keeps clusters separate per form type / account code", () => {
    const sameTextDifferentAccount: ProcessingOpinion[] = [
      { ...op("1", "Drafter A", "please attach the fee table"), accountCode: "410306" },
      { ...op("2", "Drafter B", "please attach the fee table"), accountCode: "410911" },
    ];
    expect(clusterOpinions(sameTextDifferentAccount)).toEqual([]);
  });
});
