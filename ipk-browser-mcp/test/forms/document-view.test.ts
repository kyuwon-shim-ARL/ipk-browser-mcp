import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  parseApprovalOpinions,
  parseAdditionalDocuments,
  parseAccountCode,
  parseEventDates,
  parseTotalAmount,
  parseOrganizer,
  parseFileAttachmentList,
  parseTakeoverDepartments,
} from "../../src/forms/document-view.js";

// Real document_view.php?doc_id=301306 (AppFrm-021, 2026-10-12, still in revision - returned
// by BPF for a missing program table/fee table, then revised). Colleague names redacted to
// "Approver A"/"Approver B", opinion text paraphrased in English (not reproduced verbatim),
// card number and budget pot replaced with dummy values.
const BODY_TEXT = fs.readFileSync(
  path.join(__dirname, "..", "fixtures", "card-er-location", "document-view-301306-revision.rawtext.txt"), "utf8"
);

describe("parseApprovalOpinions", () => {
  it("pairs each header line with its opinion text, including [No opinion]", () => {
    const opinions = parseApprovalOpinions(BODY_TEXT);
    expect(opinions.length).toBeGreaterThanOrEqual(6);
    expect(opinions[0]).toEqual({ name: "Kyuwon Shim", role: "Antibacterial Resistance Lab - Team Member", date: "2026-10-08 17:02:56", text: "[No opinion]", hasOpinion: false });
  });

  it("finds the real returned-for-revision opinion text (not [No opinion])", () => {
    const opinions = parseApprovalOpinions(BODY_TEXT);
    const real = opinions.filter((o) => o.hasOpinion);
    expect(real.length).toBe(2);
    expect(real[0].role).toMatch(/BPF/);
    expect(real[0].text).toMatch(/program table/i);
    expect(real[1].name).toBe("Kyuwon Shim");
    expect(real[1].text).toMatch(/added/i);
  });
});

describe("parseAdditionalDocuments", () => {
  it("lists the files already added under 'Additional document'", () => {
    const docs = parseAdditionalDocuments(BODY_TEXT);
    expect(docs).toEqual([
      "260927_AI4Sci-conference_program_revised.pdf",
      "260927_AI4Sci-conference_program_registration_fee.png",
    ]);
  });

  it("returns [] when there is no Additional document section", () => {
    expect(parseAdditionalDocuments("Subject\t[Card] Test\n")).toEqual([]);
  });
});

describe("parseFileAttachmentList", () => {
  it("lists the original submission's files", () => {
    expect(parseFileAttachmentList(BODY_TEXT)).toEqual([
      "260928_AI4Sci-CC_sales_slip.pdf",
      "260928_AI4Sci-registration_receipt.pdf",
      "260911_AI4Sci-invitation_permission.pdf",
      "260927_AI4Sci-conference_program.pdf",
    ]);
  });
  it("returns [] when there is no File Attachment List section", () => {
    expect(parseFileAttachmentList("Subject\t[Card] Test\n")).toEqual([]);
  });
});

describe("parseTakeoverDepartments", () => {
  it("reads both Takeover column departments", () => {
    expect(parseTakeoverDepartments(BODY_TEXT)).toEqual(["Budget Planning & Finance", "Budget Planning & Finance"]);
  });
  it("returns null when there is no Takeover section", () => {
    expect(parseTakeoverDepartments("Subject\t[Card] Test\n")).toBeNull();
  });
});

describe("parseAccountCode / parseEventDates / parseTotalAmount / parseOrganizer", () => {
  it("reads the resolved account code from the item table", () => {
    expect(parseAccountCode(BODY_TEXT)).toBe("410306");
  });
  it("reads the event date range", () => {
    expect(parseEventDates(BODY_TEXT)).toEqual({ start: "2026-09-27", end: "2026-10-01" });
  });
  it("reads the total amount", () => {
    expect(parseTotalAmount(BODY_TEXT)).toBe(650000);
  });
  it("reads the organizer name", () => {
    expect(parseOrganizer(BODY_TEXT)).toMatch(/AI4Sci Korea 2026 Organizing Committee/);
  });
  it("all four return null/undefined gracefully on a page without this content", () => {
    expect(parseAccountCode("nothing here")).toBeNull();
    expect(parseEventDates("nothing here")).toBeNull();
    expect(parseTotalAmount("nothing here")).toBeNull();
    expect(parseOrganizer("nothing here")).toBeNull();
  });
});
