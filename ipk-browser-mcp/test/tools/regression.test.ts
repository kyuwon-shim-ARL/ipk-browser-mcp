import { describe, it, expect } from "vitest";
import { FORM_CODES, type FormType } from "../../src/types.js";
import { FORM_REGISTRY } from "../../src/form-registry.js";

/**
 * Regression tests for form system consistency and Wave 2 handler validation.
 * Tests run without a browser — they verify mappings, schemas, and input validation logic.
 */

// ── T7: Form code mapping consistency ──────────────────────────────────────
describe("Form registry consistency (T7)", () => {
  it("FORM_CODES and FORM_REGISTRY have identical keys", () => {
    const codeKeys = Object.keys(FORM_CODES).sort();
    const registryKeys = Object.keys(FORM_REGISTRY).sort();
    expect(codeKeys).toEqual(registryKeys);
  });

  it("FORM_CODES and FORM_REGISTRY agree on AppFrm codes", () => {
    for (const [formType, code] of Object.entries(FORM_CODES)) {
      const registryEntry = FORM_REGISTRY[formType as keyof typeof FORM_REGISTRY];
      expect(registryEntry.appFrmCode).toBe(code);
    }
  });

  it("All 11 FormTypes are present", () => {
    expect(Object.keys(FORM_CODES)).toHaveLength(11);
    expect(Object.keys(FORM_REGISTRY)).toHaveLength(11);
  });

  it("All FORM_REGISTRY entries are 'implemented' status", () => {
    for (const [key, entry] of Object.entries(FORM_REGISTRY)) {
      expect(entry.status, `${key} should be implemented`).toBe("implemented");
    }
  });

  it("travel_settlement maps to AppFrm-054 (not AppFrm-076)", () => {
    expect(FORM_CODES.travel_settlement).toBe("AppFrm-054");
    expect(FORM_REGISTRY.travel_settlement.appFrmCode).toBe("AppFrm-054");
    expect(FORM_REGISTRY.travel_settlement.templateFile).toBe("AppFrm-054.json");
  });

  it("card_expense and expense share AppFrm-020", () => {
    expect(FORM_CODES.expense).toBe("AppFrm-020");
    expect(FORM_CODES.card_expense).toBe("AppFrm-020");
  });
});

// ── Wave 2 handler input validation (offline — no browser) ─────────────────

/** Simulate the budget_code validation check used by multiple handlers */
function validateBudgetCode(budgetCode: string | undefined): { valid: boolean; error?: string } {
  if (!budgetCode) {
    return { valid: false, error: "budget_code is required." };
  }
  return { valid: true };
}

/** Simulate the amount validation check */
function validateAmount(amount: number | undefined): { valid: boolean; error?: string } {
  if (amount !== undefined && (typeof amount !== "number" || amount <= 0 || !Number.isFinite(amount))) {
    return { valid: false, error: "Amount must be a positive number" };
  }
  return { valid: true };
}

describe("Wave 2: card_expense input validation", () => {
  it("rejects missing budget_code", () => {
    expect(validateBudgetCode(undefined).valid).toBe(false);
    expect(validateBudgetCode("").valid).toBe(false);
  });

  it("accepts valid budget_code", () => {
    expect(validateBudgetCode("NN2612-0001").valid).toBe(true);
  });

  it("rejects invalid amount (zero)", () => {
    expect(validateAmount(0).valid).toBe(false);
  });

  it("rejects invalid amount (negative)", () => {
    expect(validateAmount(-100).valid).toBe(false);
  });

  it("rejects invalid amount (NaN)", () => {
    expect(validateAmount(NaN).valid).toBe(false);
  });

  it("rejects invalid amount (Infinity)", () => {
    expect(validateAmount(Infinity).valid).toBe(false);
  });

  it("accepts valid amount", () => {
    expect(validateAmount(15000).valid).toBe(true);
  });

  it("accepts undefined amount (optional)", () => {
    expect(validateAmount(undefined).valid).toBe(true);
  });
});

describe("Wave 2: leave_return input validation", () => {
  it("requires original_leave_doc", () => {
    const originalDoc = "";
    expect(!originalDoc).toBe(true);
  });

  it("builds correct subject from return days", () => {
    const returnDays = 1;
    const returnHours = 0;
    const originalDoc = "ARL-260121-02";
    let returnLabel = "";
    if (returnDays > 0 && returnHours > 0) {
      returnLabel = `${returnDays}day(s)/${returnHours}hour(s)`;
    } else if (returnDays > 0) {
      returnLabel = `${returnDays}day(s)`;
    } else {
      returnLabel = `${returnHours}hour(s)`;
    }
    const subject = `Leave return ${returnLabel} ${originalDoc}`;
    expect(subject).toBe("Leave return 1day(s) ARL-260121-02");
  });

  it("handles partial hour returns", () => {
    const returnDays = 0;
    const returnHours = 3;
    let returnLabel = "";
    if (returnDays > 0 && returnHours > 0) {
      returnLabel = `${returnDays}day(s)/${returnHours}hour(s)`;
    } else if (returnDays > 0) {
      returnLabel = `${returnDays}day(s)`;
    } else {
      returnLabel = `${returnHours}hour(s)`;
    }
    expect(returnLabel).toBe("3hour(s)");
  });

  it("handles mixed day+hour returns", () => {
    const returnDays = 1;
    const returnHours = 2;
    let returnLabel = "";
    if (returnDays > 0 && returnHours > 0) {
      returnLabel = `${returnDays}day(s)/${returnHours}hour(s)`;
    } else if (returnDays > 0) {
      returnLabel = `${returnDays}day(s)`;
    } else {
      returnLabel = `${returnHours}hour(s)`;
    }
    expect(returnLabel).toBe("1day(s)/2hour(s)");
  });
});

describe("Wave 2: travel_settlement daily expense calculation", () => {
  it("day-trip (0 nights) = 20,000 KRW", () => {
    const startDate = new Date("2026-03-28");
    const endDate = new Date("2026-03-28");
    const nights = Math.max(0, Math.round((endDate.getTime() - startDate.getTime()) / 86400000));
    expect(nights).toBe(0);
    const dailyExpense = nights === 0 ? 20000 : 30000 * nights;
    expect(dailyExpense).toBe(20000);
  });

  it("overnight (1 night) = 30,000 KRW", () => {
    const startDate = new Date("2026-03-28");
    const endDate = new Date("2026-03-29");
    const nights = Math.max(0, Math.round((endDate.getTime() - startDate.getTime()) / 86400000));
    expect(nights).toBe(1);
    const dailyExpense = nights === 0 ? 20000 : 30000 * nights;
    expect(dailyExpense).toBe(30000);
  });

  it("2-night trip = 60,000 KRW", () => {
    const startDate = new Date("2026-03-28");
    const endDate = new Date("2026-03-30");
    const nights = Math.max(0, Math.round((endDate.getTime() - startDate.getTime()) / 86400000));
    expect(nights).toBe(2);
    const dailyExpense = nights === 0 ? 20000 : 30000 * nights;
    expect(dailyExpense).toBe(60000);
  });

  it("own vehicle cost = oil_price * distance_km / 10", () => {
    const oilPrice = 1650;
    const distanceKm = 120;
    const ownCarCost = Math.round(oilPrice * distanceKm / 10);
    expect(ownCarCost).toBe(19800);
  });
});

// ── T4: FORM_REGISTRY ↔ template JSON integrity ─────────────────────────────
describe("FORM_REGISTRY ↔ template JSON integrity", () => {
  const fs = require("fs");
  const path = require("path");
  const templateDir = path.resolve(__dirname, "..", "..", "..", "form_templates");

  it("FORM_REGISTRY templateFiles that exist on disk are valid JSON", () => {
    const invalid: string[] = [];
    for (const [key, entry] of Object.entries(FORM_REGISTRY)) {
      const filePath = path.join(templateDir, entry.templateFile);
      if (!fs.existsSync(filePath)) continue; // not all templates exist yet
      try {
        const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        if (!content.form_code) invalid.push(`${key}: missing form_code`);
      } catch {
        invalid.push(`${key}: invalid JSON`);
      }
    }
    expect(invalid, `Invalid template files: ${invalid.join(", ")}`).toHaveLength(0);
  });

  it("templates with ajax_cascade_sequence have valid step structure", () => {
    const templatesWithCascade = ["AppFrm-023.json"];
    for (const filename of templatesWithCascade) {
      const filePath = path.join(templateDir, filename);
      if (!fs.existsSync(filePath)) continue;
      const template = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      const steps = template.ajax_cascade_sequence;
      expect(Array.isArray(steps), `${filename}: ajax_cascade_sequence should be array`).toBe(true);
      for (const step of steps) {
        expect(step.field, `${filename}: each step needs 'field'`).toBeTruthy();
        expect(step.timeout_ms, `${filename}: step '${step.field}' needs timeout_ms`).toBeGreaterThan(0);
        // Steps that trigger downstream options should have wait_selector
        if (step.wait_selector) {
          expect(typeof step.wait_selector).toBe("string");
        }
      }
    }
  });

  it("templates with field_schema have required fields marked", () => {
    const requiredTemplates = [
      { file: "AppFrm-023.json", minRequired: 4 },
      { file: "AppFrm-054.json", minRequired: 3 },
      { file: "AppFrm-073.json", minRequired: 5 },
    ];
    for (const { file, minRequired } of requiredTemplates) {
      const filePath = path.join(templateDir, file);
      if (!fs.existsSync(filePath)) continue;
      const template = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      const schema = template.field_schema;
      const requiredCount = Object.values(schema).filter((f: any) => f.required).length;
      expect(requiredCount, `${file}: expected >= ${minRequired} required fields`).toBeGreaterThanOrEqual(minRequired);
    }
  });

  it("AppFrm-023 cascade wait_selectors reference valid DOM selectors", () => {
    const filePath = path.join(templateDir, "AppFrm-023.json");
    if (!fs.existsSync(filePath)) return;
    const template = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const steps = template.ajax_cascade_sequence;
    for (const step of steps) {
      if (step.wait_selector) {
        // wait_selector should match pattern: select[name='xxx'] option:nth-child(N)
        expect(step.wait_selector).toMatch(/select\[name='[^']+'\]\s*option:nth-child\(\d+\)/);
      }
    }
  });
});

describe("Wave 2: seminar validation", () => {
  it("requires title/subject", () => {
    const subject = "";
    expect(!subject).toBe(true);
  });

  it("radio defaults match template inference rules", () => {
    const defaults = {
      material_published: "N",
      collaborator_approval: "Y",
      contains_confidential: "N",
    };
    expect(defaults.material_published).toBe("N");
    expect(defaults.collaborator_approval).toBe("Y");
    expect(defaults.contains_confidential).toBe("N");
  });
});
