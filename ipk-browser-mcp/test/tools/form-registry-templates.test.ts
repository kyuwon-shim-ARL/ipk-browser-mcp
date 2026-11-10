import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { FORM_REGISTRY } from "../../src/form-registry.js";

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

// M-1 (code review 2026-11-09): src/form-registry.ts (TS, used by the server) and
// src/form-registry.json (copied to dist/ for the Python bridge) are two independently
// maintained files that must describe the same form the same way - round 1 of this
// change updated the .json's descriptions for travel/overseas_travel but not the .ts,
// leaving them silently out of sync. This locks every field, not only description.
describe("src/form-registry.ts (FORM_REGISTRY) matches src/form-registry.json exactly", () => {
  const tsKeys = Object.keys(FORM_REGISTRY);
  const jsonKeys = Object.keys(REGISTRY);

  it("has the same set of form_type keys", () => {
    expect(tsKeys.sort()).toEqual(jsonKeys.sort());
  });

  for (const formType of tsKeys) {
    it(`${formType}: appFrmCode/templateFile/status/description match`, () => {
      const ts = (FORM_REGISTRY as any)[formType];
      const json = REGISTRY[formType];
      expect(json, `${formType} missing from form-registry.json`).toBeTruthy();
      expect(ts.appFrmCode).toBe(json.appFrmCode);
      expect(ts.templateFile).toBe(json.templateFile);
      expect(ts.status).toBe(json.status);
      expect(ts.description).toBe(json.description);
    });
  }
});
