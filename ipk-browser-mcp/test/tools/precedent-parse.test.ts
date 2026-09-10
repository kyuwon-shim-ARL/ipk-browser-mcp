import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTravelRequestDoc, practiceProfile } from "../../src/precedent/travel-request-doc.js";
import { diffAgainstPractice } from "../../src/precedent/fetch.js";

const fx = (n: string) => readFileSync(join(__dirname, "..", "fixtures", "precedent", n), "utf8");

describe("parseTravelRequestDoc", () => {
  it("reads the practice fields off an approved request", () => {
    const d = parseTravelRequestDoc(fx("AppFrm-023_295147.txt"));
    expect(d.budget_code).toBe("NN2602-0002");
    expect(d.credit_card_no).toBe("XXXX-XXXX-XXXX-XXXX");
    expect(d.bound).toBe("out");            // a named city means bound_code 20
    expect(d.province).toBe("Seoul (서울특별시)");
    expect(d.city).toBe("Seoul (서울)");
    expect(d.transport).toBe("Other Public Transporation");
    expect(d.purpose_type).toBe("Simple visit to vendor & etc");
    expect(d.food_allowance).toBe(0);
    expect(d.labels_found).toBeGreaterThan(4);
    expect(d.attachments).toEqual([{ slot: "verification", file: "출장요청_merged.pdf" }]);
  });
  it("reads 관내 and a Transport-slot file off the tool's own first draft", () => {
    const d = parseTravelRequestDoc(fx("AppFrm-023_299953_draft.txt"));
    expect(d.bound).toBe("in");
    expect(d.province).toBeUndefined();
    expect(d.credit_card_no).toBeUndefined();
    expect(d.budget_code).toBe("NN2602-0001");
    expect(d.attachments).toEqual([{ slot: "transport", file: "RAPID_2026_Q3_sampling_approval.pdf" }]);
  });
  it("reads two files in the ETC slot", () => {
    const d = parseTravelRequestDoc(fx("AppFrm-023_295178.txt"));
    expect(d.attachments.map((a) => a.slot)).toEqual(["etc", "etc"]);
  });
});

describe("practiceProfile", () => {
  it("keeps only fields that agree across every precedent, with the evidence", () => {
    const docs = ["AppFrm-023_295147.txt", "AppFrm-023_295178.txt", "AppFrm-023_299953.txt"].map((n) => parseTravelRequestDoc(fx(n)));
    const p = practiceProfile(docs);
    expect(p.stable.budget_code).toEqual({ value: "NN2602-0002", n: 3 });
    // presence only: a card number is a fact about the traveler and never leaves the document
    expect(p.stable.credit_card_no).toEqual({ value: "present", n: 3 });
    expect(JSON.stringify(p)).not.toMatch(/\d{4}-[X\d]{4}-[X\d]{4}-\d{4}/);
    expect(p.stable.daily_expense).toBeUndefined();  // not on the allowlist
    expect(p.stable.bound).toEqual({ value: "out", n: 3 });
    expect(p.stable.city).toEqual({ value: "Seoul (서울)", n: 3 });
    // attachment slot differs (verification, etc, verification) -> not stable, but reported
    expect(p.stable.attachment_slot).toBeUndefined();
    expect(p.varied.attachment_slot).toEqual({ verification: 2, etc: 1 });
  });
  it("is empty for fewer than two precedents", () => {
    expect(practiceProfile([parseTravelRequestDoc(fx("AppFrm-023_295147.txt"))]).stable).toEqual({});
  });
});

describe("diffAgainstPractice (precedent minus draft, on rendered documents)", () => {
  const profile = practiceProfile(["AppFrm-023_295147.txt", "AppFrm-023_295178.txt", "AppFrm-023_299953.txt"].map((n) => parseTravelRequestDoc(fx(n))));
  it("names every practice field the tool's first draft lacked or got differently", () => {
    const d = diffAgainstPractice(parseTravelRequestDoc(fx("AppFrm-023_299953_draft.txt")), profile);
    const byField = Object.fromEntries(d.map((x) => [x.field, x]));
    expect(byField.budget_code).toEqual({ field: "budget_code", draft: "NN2602-0001", practice: "NN2602-0002", n: 3 });
    expect(byField.credit_card_no).toEqual({ field: "credit_card_no", draft: "absent", practice: "present", n: 3 });
    expect(byField.bound).toEqual({ field: "bound", draft: "in", practice: "out", n: 3 });
    expect(byField.city.draft).toBeUndefined();
  });
  it("is empty for the human-final document against a profile it is NOT part of", () => {
    const held_out = practiceProfile(["AppFrm-023_295147.txt", "AppFrm-023_295178.txt"].map((n) => parseTravelRequestDoc(fx(n))));
    expect(diffAgainstPractice(parseTravelRequestDoc(fx("AppFrm-023_299953.txt")), held_out)).toEqual([]);
  });
  it("reports a page that is not a rendered request as unreadable", () => {
    expect(parseTravelRequestDoc("Welcome to Institut Pasteur Korea GroupWare\nLogin").labels_found).toBe(0);
  });
});
