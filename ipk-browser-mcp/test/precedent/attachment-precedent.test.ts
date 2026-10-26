import { describe, it, expect } from "vitest";
import { buildPrecedentReport, frequentFilenameTokens } from "../../src/precedent/attachment-precedent.js";

const doc410306 = (docId: string, files: string[]) => ({
  docId,
  bodyText:
    `No\tDate of\nInvoice\tCate No\tAccount Code\tDescription\n1\t2026-09-28\tnone\t[410306]\nParticipating in Conferences\n` +
    `File Attachment List\t${files.map((f) => `${f} [1000Bytes] [Delete]`).join("\n")}\n`,
});

describe("buildPrecedentReport", () => {
  it("keeps only docs matching the target account, counts scanned vs found", () => {
    const docs = [
      doc410306("1", ["a_slip.pdf", "a_receipt.pdf"]),
      { docId: "2", bodyText: "No\tDate of\n1\tnone\t[410318]\nIT Software\n" }, // different account
      doc410306("3", ["b_slip.pdf"]),
    ];
    const report = buildPrecedentReport("410306", docs);
    expect(report.docsScanned).toBe(3);
    expect(report.docsFound).toBe(2);
    expect(report.docs.map((d) => d.docId)).toEqual(["1", "3"]);
  });

  it("never changes a rule - the output is text only (candidateRowText), no rule object", () => {
    const report = buildPrecedentReport("410306", [doc410306("1", ["program.pdf", "fee_table.pdf"])]);
    expect(typeof report.candidateRowText).toBe("string");
    expect(report.candidateRowText).toMatch(/proposal, not a rule change/);
  });

  it("reports nothing-found plainly when no doc matches", () => {
    const report = buildPrecedentReport("999999", [doc410306("1", ["x.pdf"])]);
    expect(report.docsFound).toBe(0);
    expect(report.candidateRowText).toMatch(/No precedent documents found/);
  });
});

describe("frequentFilenameTokens", () => {
  it("counts word tokens across filenames, ignoring dates/extensions/numeric fragments", () => {
    const tokens = frequentFilenameTokens([
      ["260928_AI4Sci-CC_sales_slip.pdf", "260929_AI4Sci-CC_sales_slip.pdf"],
      ["260928_AI4Sci-registration_receipt.pdf"],
    ]);
    const byToken = new Map(tokens.map((t) => [t.token, t.count]));
    expect(byToken.get("sales")).toBe(2);
    expect(byToken.get("slip")).toBe(2);
    expect(byToken.get("receipt")).toBe(1);
    expect(byToken.has("260928")).toBe(false); // numeric date fragment dropped
  });
});
