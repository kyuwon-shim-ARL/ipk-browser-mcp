import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

// Unlike the 3-axis completeness gate (template-completeness.test.ts), which silently
// skips a missing template, this asserts existence and field_schema outright - a form
// registered without its template is UNKNOWN_FORM at runtime (ipk-submit.ts
// loadTemplateFieldSchema / ipk-inspect.ts), not a degraded-but-working form.
const ROOT = path.resolve(__dirname, "../..");
const TEMPLATES_DIR = path.resolve(ROOT, "../form_templates");
const REGISTRY = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../src/form-registry.json"), "utf-8"));

describe("every form-registry.json templateFile loads with a field_schema", () => {
  for (const [formType, entry] of Object.entries(REGISTRY) as [string, any][]) {
    it(`${formType} -> ${entry.templateFile}`, () => {
      const templatePath = path.join(TEMPLATES_DIR, entry.templateFile);
      expect(fs.existsSync(templatePath), `${templatePath} does not exist`).toBe(true);
      const template = JSON.parse(fs.readFileSync(templatePath, "utf-8"));
      expect(template.field_schema, `${entry.templateFile} has no field_schema`).toBeTruthy();
      expect(Object.keys(template.field_schema).length).toBeGreaterThan(0);
    });
  }
});
