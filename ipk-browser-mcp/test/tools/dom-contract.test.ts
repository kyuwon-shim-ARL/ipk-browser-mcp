import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

/**
 * DOM Contract Tests (T5)
 *
 * Verify that template field_schema dom_name values exist as element names
 * in the corresponding DOM fixture snapshots. This catches regressions where
 * template dom_name references become stale after groupware UI changes.
 */

const fixtureDir = path.resolve(__dirname, "..", "..", "..", "test", "fixtures");
const templateDir = path.resolve(__dirname, "..", "..", "..", "form_templates");

interface DomElement {
  tag: string;
  name: string;
  type: string;
  id: string;
}

interface DomFixture {
  url: string;
  element_count: number;
  elements: DomElement[];
}

interface FieldSchema {
  [key: string]: {
    dom_name?: string;
    dom_note?: string;
    dom_fields?: Record<string, string>;
    required?: boolean;
    [k: string]: unknown;
  };
}

function loadFixture(formCode: string): DomFixture | null {
  const filePath = path.join(fixtureDir, `dom_${formCode}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function loadTemplate(formCode: string): { field_schema: FieldSchema } | null {
  const filePath = path.join(templateDir, `${formCode}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function getFixtureElementNames(fixture: DomFixture): Set<string> {
  const names = new Set<string>();
  for (const el of fixture.elements) {
    if (el.name) names.add(el.name);
  }
  return names;
}

function getTemplateDomNames(schema: FieldSchema): { field: string; domName: string }[] {
  const result: { field: string; domName: string }[] = [];
  for (const [field, def] of Object.entries(schema)) {
    // Skip fields populated indirectly (e.g. via sel_travel hidden field)
    const isIndirect = def.dom_note && /NOT a direct DOM input/i.test(def.dom_note);
    // Direct dom_name
    if (def.dom_name && !isIndirect) {
      result.push({ field, domName: def.dom_name });
    }
    // dom_fields (e.g. daily_fee_total, daily_fee_card, daily_fee_cash)
    if (def.dom_fields && !isIndirect) {
      for (const [subKey, domName] of Object.entries(def.dom_fields)) {
        result.push({ field: `${field}.${subKey}`, domName });
      }
    }
  }
  return result;
}

// Contract pairs: template formCode ↔ DOM fixture formCode
const CONTRACT_PAIRS = [
  { formCode: "AppFrm-023", description: "Domestic Travel Request" },
  { formCode: "AppFrm-054", description: "Domestic Travel Settlement" },
  { formCode: "AppFrm-073", description: "Leave Request" },
];

describe("DOM contract: template dom_name ↔ fixture element names", () => {
  for (const { formCode, description } of CONTRACT_PAIRS) {
    describe(`${formCode} (${description})`, () => {
      const fixture = loadFixture(formCode);
      const template = loadTemplate(formCode);

      it("fixture file exists", () => {
        expect(fixture, `Missing fixture: dom_${formCode}.json`).not.toBeNull();
      });

      it("template file exists", () => {
        expect(template, `Missing template: ${formCode}.json`).not.toBeNull();
      });

      it("all template dom_names exist in fixture DOM", () => {
        if (!fixture || !template) return;
        const elementNames = getFixtureElementNames(fixture);
        const domNames = getTemplateDomNames(template.field_schema);
        const missing: string[] = [];

        for (const { field, domName } of domNames) {
          if (!elementNames.has(domName)) {
            missing.push(`${field} → "${domName}"`);
          }
        }

        expect(
          missing,
          `DOM names in template but NOT in fixture:\n  ${missing.join("\n  ")}`
        ).toHaveLength(0);
      });

      it("fixture has reasonable element count", () => {
        if (!fixture) return;
        expect(fixture.element_count).toBeGreaterThan(10);
        expect(fixture.elements.length).toBe(fixture.element_count);
      });

      it("no duplicate non-array element names in fixture", () => {
        if (!fixture) return;
        const seen = new Map<string, number>();
        for (const el of fixture.elements) {
          if (!el.name || el.name.endsWith("[]")) continue; // arrays are expected duplicates
          seen.set(el.name, (seen.get(el.name) || 0) + 1);
        }
        const duplicates = [...seen.entries()]
          .filter(([, count]) => count > 1)
          .map(([name, count]) => `${name} (×${count})`);
        // Radio buttons can share names, so just warn — not a hard failure
        // Only fail if a non-radio input has duplicates
        if (duplicates.length > 0) {
          const nonRadioDupes = [...seen.entries()]
            .filter(([name, count]) => {
              if (count <= 1) return false;
              const elements = fixture.elements.filter(e => e.name === name);
              return !elements.every(e => e.type === "radio");
            })
            .map(([name]) => name);
          expect(
            nonRadioDupes,
            `Non-radio duplicate element names: ${nonRadioDupes.join(", ")}`
          ).toHaveLength(0);
        }
      });
    });
  }
});
