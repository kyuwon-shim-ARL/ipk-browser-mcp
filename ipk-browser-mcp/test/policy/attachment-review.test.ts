import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  reviewAttachments,
  quoteMatchesDate,
  quoteMatchesAmount,
  quoteMatchesIssuer,
  type AttachmentInput,
} from "../../src/policy/attachment-review.js";

// Synthetic fixture files - real attachments never go in the repo (feedback_attachment).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ipk-attach-"));
function file(name: string): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, "synthetic fixture content");
  return p;
}

const EVENT = { eventStart: "2026-09-27", eventEnd: "2026-10-01" };
const TOTAL = 650000;
const ISSUER = "AI4Sci Korea 2026 Organizing Committee (AiFrenz, KSAIF, GIST)";

function attachments(overrides: Partial<Record<string, AttachmentInput>> = {}): AttachmentInput[] {
  const base: Record<string, AttachmentInput> = {
    card_slip: { path: file("slip.pdf"), kind: "card_slip" },
    society_receipt: { path: file("receipt.pdf"), kind: "society_receipt", quotes: [`Issued by ${ISSUER}`] },
    permission: { path: file("permission.pdf"), kind: "permission" },
    fee_table: { path: file("fee.pdf"), kind: "fee_table", quotes: ["Total: KRW 650,000"] },
    program: { path: file("program.pdf"), kind: "program", quotes: ["Day 0 · Sep 27 (Sun)", "Sep 28", "Sep 29", "Sep 30", "Oct 1"] },
  };
  return Object.values({ ...base, ...overrides });
}

describe("date quote matching", () => {
  it("matches many real-world date variants", () => {
    const cases: [string, number, number][] = [
      ["Sep 27 (Sun)", 9, 27], ["27 Sep", 9, 27], ["Sept. 27", 9, 27],
      ["9/27", 9, 27], ["9.27", 9, 27], ["27.09.", 9, 27],
      ["9월 27일", 9, 27], ["2026-09-27", 9, 27], ["28/Sept/2026", 9, 28],
    ];
    for (const [q, m, d] of cases) expect(quoteMatchesDate(q, m, d)).toBe(true);
  });

  it("rejects a bare number with no month", () => {
    expect(quoteMatchesDate("27", 9, 27)).toBe(false);
    expect(quoteMatchesDate("Day 2 of the conference", 9, 27)).toBe(false);
  });

  it("rejects a year mismatch", () => {
    expect(quoteMatchesDate("2025-09-27", 9, 27, 2026)).toBe(false);
    expect(quoteMatchesDate("28/Sept/2025", 9, 28, 2026)).toBe(false);
  });
});

describe("amount and issuer quote matching", () => {
  it("normalizes commas/currency when matching amount", () => {
    expect(quoteMatchesAmount("Total: KRW 650,000", 650000)).toBe(true);
    expect(quoteMatchesAmount("Total: KRW 650,001", 650000)).toBe(false);
  });

  it("matches issuer after stripping stopwords", () => {
    expect(quoteMatchesIssuer("Issued by AiFrenz Society", ISSUER)).toBe(true);
    expect(quoteMatchesIssuer("Issued by an unrelated vendor", ISSUER)).toBe(false);
  });
});

describe("reviewAttachments for account 410306", () => {
  it("301306-style four kinds (no fee_table) -> blocked", () => {
    const list = attachments();
    const result = reviewAttachments({ accountCode: "410306", attachments: list.filter((a) => a.kind !== "fee_table"), ...EVENT, totalAmount: TOTAL, issuerName: ISSUER });
    expect(result.blocks.some((b) => /fee_table/.test(b))).toBe(true);
  });

  it("missing the 27th's program quote -> blocked; adding it -> passes", () => {
    const missing27 = attachments({ program: { path: file("program.pdf"), kind: "program", quotes: ["Sep 28", "Sep 29", "Sep 30", "Oct 1"] } });
    const blocked = reviewAttachments({ accountCode: "410306", attachments: missing27, ...EVENT, totalAmount: TOTAL, issuerName: ISSUER });
    expect(blocked.blocks.some((b) => /2026-09-27/.test(b))).toBe(true);

    const complete = attachments();
    const ok = reviewAttachments({ accountCode: "410306", attachments: complete, ...EVENT, totalAmount: TOTAL, issuerName: ISSUER });
    expect(ok.blocks).toEqual([]);
  });

  it("fee_table quote without the total -> blocked", () => {
    const list = attachments({ fee_table: { path: file("fee.pdf"), kind: "fee_table", quotes: ["Total: KRW 100,000"] } });
    const result = reviewAttachments({ accountCode: "410306", attachments: list, ...EVENT, totalAmount: TOTAL, issuerName: ISSUER });
    expect(result.blocks.some((b) => /fee_table/.test(b))).toBe(true);
  });

  it("ICML-type complete submission -> zero blocks", () => {
    const result = reviewAttachments({ accountCode: "410306", attachments: attachments(), ...EVENT, totalAmount: TOTAL, issuerName: ISSUER });
    expect(result.blocks).toEqual([]);
  });

  it("non-410306 account is unaffected", () => {
    const result = reviewAttachments({ accountCode: "420421", attachments: [], ...EVENT, totalAmount: TOTAL, issuerName: ISSUER });
    expect(result.blocks).toEqual([]);
  });

  it("bare '27' citation -> blocked", () => {
    const list = attachments({ program: { path: file("program.pdf"), kind: "program", quotes: ["27", "Sep 28", "Sep 29", "Sep 30", "Oct 1"] } });
    const result = reviewAttachments({ accountCode: "410306", attachments: list, ...EVENT, totalAmount: TOTAL, issuerName: ISSUER });
    expect(result.blocks.some((b) => /2026-09-27/.test(b))).toBe(true);
  });

  it("year-mismatched citation -> blocked", () => {
    const list = attachments({ program: { path: file("program.pdf"), kind: "program", quotes: ["2025-09-27", "Sep 28", "Sep 29", "Sep 30", "Oct 1"] } });
    const result = reviewAttachments({ accountCode: "410306", attachments: list, ...EVENT, totalAmount: TOTAL, issuerName: ISSUER });
    expect(result.blocks.some((b) => /2026-09-27/.test(b))).toBe(true);
  });

  it("attestation_exception with person_confirmed -> passes and is flagged", () => {
    const list = attachments({ fee_table: { path: file("fee.pdf"), kind: "fee_table", quotes: ["members pay a reduced fee, see grid"] } });
    const result = reviewAttachments({
      accountCode: "410306", attachments: list, ...EVENT, totalAmount: TOTAL, issuerName: ISSUER,
      exceptions: [{ kind: "fee_table", reason: "member/non-member grid, no single total line", person_confirmed: true }],
    });
    expect(result.blocks.some((b) => /fee_table/.test(b))).toBe(false);
    expect(result.flagged.some((f) => f.kind === "fee_table")).toBe(true);
  });

  it("an unconfirmed exception does not pass", () => {
    const list = attachments({ fee_table: { path: file("fee.pdf"), kind: "fee_table", quotes: ["no total here"] } });
    // @ts-expect-error - exercising the missing person_confirmed path
    const result = reviewAttachments({ accountCode: "410306", attachments: list, ...EVENT, totalAmount: TOTAL, issuerName: ISSUER, exceptions: [{ kind: "fee_table", reason: "x" }] });
    expect(result.blocks.some((b) => /fee_table/.test(b))).toBe(true);
  });

  it("duplicate kind -> blocked", () => {
    const list = attachments();
    list.push({ path: file("extra.pdf"), kind: "fee_table" });
    const result = reviewAttachments({ accountCode: "410306", attachments: list, ...EVENT, totalAmount: TOTAL, issuerName: ISSUER });
    expect(result.blocks.some((b) => /one file = one kind/.test(b))).toBe(true);
  });

  it("unlabeled 410306 (legacy attachment_paths, no kinds) -> blocked", () => {
    const result = reviewAttachments({ accountCode: "410306", legacyPaths: [file("a.pdf"), file("b.pdf")], ...EVENT, totalAmount: TOTAL, issuerName: ISSUER });
    expect(result.blocks.length).toBeGreaterThan(0);
  });

  it("filename not matching label only warns, never blocks", () => {
    const list = attachments({ card_slip: { path: file("totally_unrelated_name.pdf"), kind: "card_slip" } });
    const result = reviewAttachments({ accountCode: "410306", attachments: list, ...EVENT, totalAmount: TOTAL, issuerName: ISSUER });
    expect(result.blocks).toEqual([]);
    expect(result.warnings.some((w) => /totally_unrelated_name/.test(w))).toBe(true);
  });

  it("records {path, sha256, kind, quote} per attachment for audit", () => {
    const result = reviewAttachments({ accountCode: "410306", attachments: attachments(), ...EVENT, totalAmount: TOTAL, issuerName: ISSUER });
    expect(result.auditRecords.length).toBe(5);
    for (const r of result.auditRecords) {
      expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(r.kind).toBeTruthy();
    }
  });
});

describe("RunPod vendor-keyed requirement (relocated from org-policy.ts)", () => {
  it("still requires all four kinds", () => {
    const result = reviewAttachments({ vendorKey: "runpod", attachments: [{ path: file("invoice.pdf"), kind: "invoice" }] });
    expect(result.blocks.some((b) => /card_slip/.test(b))).toBe(true);
  });

  it("passes with all four kinds present", () => {
    const result = reviewAttachments({
      vendorKey: "runpod",
      attachments: [
        { path: file("invoice.pdf"), kind: "invoice" },
        { path: file("slip.pdf"), kind: "card_slip" },
        { path: file("usage.png"), kind: "usage" },
        { path: file("receipt.pdf"), kind: "receipt" },
      ],
    });
    expect(result.blocks).toEqual([]);
  });
});
