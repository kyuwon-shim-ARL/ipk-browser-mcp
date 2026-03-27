import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ipkSubmitFormSchema } from "../../src/tools/ipk-submit.js";
import { FORM_CODES } from "../../src/types.js";

const formTypeSchema = z.object({ form_type: ipkSubmitFormSchema.form_type });

const ALL_FORM_TYPES = [
  // Implemented
  "leave", "expense", "working", "travel", "travel_request", "budget_transfer",
  // Stub types added in T1
  "travel_settlement", "leave_return", "card_expense", "seminar", "overseas_travel",
] as const;

describe("FormType validity", () => {
  it("all 11 FormTypes pass Zod parse", () => {
    for (const ft of ALL_FORM_TYPES) {
      expect(() => formTypeSchema.parse({ form_type: ft })).not.toThrow();
    }
  });

  it("rejects unknown form type with ZodError", () => {
    expect(() => formTypeSchema.parse({ form_type: "unknown_form" })).toThrow(z.ZodError);
  });

  it("rejects empty string", () => {
    expect(() => formTypeSchema.parse({ form_type: "" })).toThrow(z.ZodError);
  });

  it("FORM_CODES has an entry for every FormType", () => {
    for (const ft of ALL_FORM_TYPES) {
      expect(FORM_CODES[ft]).toBeTruthy();
      expect(FORM_CODES[ft]).toMatch(/^AppFrm-\d{3}$/);
    }
  });

  it("expense maps to AppFrm-020 (not the incorrect AppFrm-021)", () => {
    expect(FORM_CODES["expense"]).toBe("AppFrm-020");
  });
});
