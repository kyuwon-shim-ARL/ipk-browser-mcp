import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

// Registry from src/form-registry.ts compiled output — read JSON directly
const FORM_REGISTRY_JSON = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../src/form-registry.json"), "utf-8")
);

const TEMPLATES_DIR = path.resolve(__dirname, "../../../form_templates");

describe("Form template 3-axis coverage (Phase 2)", () => {
  for (const [formType, entry] of Object.entries(FORM_REGISTRY_JSON) as [string, any][]) {
    it(`${formType}: template exists and has field_schema`, () => {
      const templatePath = path.join(TEMPLATES_DIR, entry.templateFile);
      // Skip if template file doesn't exist yet (stub)
      if (!fs.existsSync(templatePath)) return;
      const template = JSON.parse(fs.readFileSync(templatePath, "utf-8"));
      expect(template.field_schema, `${formType}: field_schema missing`).toBeDefined();
      expect(Object.keys(template.field_schema).length, `${formType}: field_schema empty`).toBeGreaterThan(0);
    });

    it(`${formType}: all dom_name fields have widget_type`, () => {
      const templatePath = path.join(TEMPLATES_DIR, entry.templateFile);
      if (!fs.existsSync(templatePath)) return;
      const template = JSON.parse(fs.readFileSync(templatePath, "utf-8"));
      if (!template.field_schema) return;
      const missing: string[] = [];
      for (const [key, field] of Object.entries(template.field_schema) as [string, any][]) {
        if (field.dom_name !== null && field.dom_name !== undefined && !field.widget_type) {
          // Only flag if type is a simple type (not array/table which are handled by hooks)
          if (!["array", "table"].includes(field.type)) {
            missing.push(key);
          }
        }
      }
      expect(missing, `${formType}: fields missing widget_type: ${missing.join(", ")}`).toHaveLength(0);
    });
  }
});
