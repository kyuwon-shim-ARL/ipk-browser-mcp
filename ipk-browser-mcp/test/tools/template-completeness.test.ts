import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../..");
const TEMPLATES_DIR = path.resolve(ROOT, "../form_templates");
const REGISTRY = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../src/form-registry.json"), "utf-8"));

function measure3Axis(formType: string, entry: any) {
  const templatePath = path.join(TEMPLATES_DIR, entry.templateFile);
  if (!fs.existsSync(templatePath)) return null;
  const template = JSON.parse(fs.readFileSync(templatePath, "utf-8"));
  const schema = template.field_schema;
  if (!schema) return null;

  const fields = Object.entries(schema) as [string, any][];
  const complexTypes = ["array", "table"];

  const withDomName = fields.filter(([, f]) => Object.prototype.hasOwnProperty.call(f, "dom_name"));
  const domNameCoverage = fields.length > 0 ? withDomName.length / fields.length : 1;

  const routable = fields.filter(([, f]) => f.dom_name !== null && f.dom_name !== undefined && Object.prototype.hasOwnProperty.call(f, "dom_name"));
  const dispatchable = routable.filter(([, f]) => !complexTypes.includes(f.type));
  const withWidget = dispatchable.filter(([, f]) => f.widget_type);
  const widgetTypeCoverage = dispatchable.length > 0 ? withWidget.length / dispatchable.length : 1;

  const special = fields.filter(([, f]) => f.widget_type === "file_upload" || f.widget_type === "account_lookup");
  const specialWithActions = special.filter(([, f]) => Array.isArray(f.post_actions));
  const postActionsCoverage = special.length > 0 ? specialWithActions.length / special.length : 1;

  return {
    domNameCoverage,
    widgetTypeCoverage,
    postActionsCoverage,
    missing: {
      dom_name: fields.filter(([, f]) => !Object.prototype.hasOwnProperty.call(f, "dom_name")).map(([k]) => k),
      widget_type: dispatchable.filter(([, f]) => !f.widget_type).map(([k]) => k),
      post_actions: special.filter(([, f]) => !Array.isArray(f.post_actions)).map(([k]) => k),
    },
  };
}

// Deduplicate by templateFile (card_expense and expense share AppFrm-020.json)
const seen = new Set<string>();
const uniqueEntries: [string, any][] = [];
for (const [formType, entry] of Object.entries(REGISTRY) as [string, any][]) {
  if (!seen.has(entry.templateFile)) {
    seen.add(entry.templateFile);
    uniqueEntries.push([formType, entry]);
  }
}

describe("3-axis completeness gate", () => {
  for (const [formType, entry] of uniqueEntries) {
    it(`${formType} (${entry.templateFile}): dom_name 100%`, () => {
      const result = measure3Axis(formType, entry);
      if (!result) return; // skip missing templates
      expect(result.missing.dom_name, `fields missing dom_name: ${result.missing.dom_name.join(", ")}`).toHaveLength(0);
    });

    it(`${formType} (${entry.templateFile}): widget_type 100%`, () => {
      const result = measure3Axis(formType, entry);
      if (!result) return;
      expect(result.missing.widget_type, `fields missing widget_type: ${result.missing.widget_type.join(", ")}`).toHaveLength(0);
    });

    it(`${formType} (${entry.templateFile}): post_actions 100%`, () => {
      const result = measure3Axis(formType, entry);
      if (!result) return;
      expect(result.missing.post_actions, `file_upload/account_lookup fields missing post_actions: ${result.missing.post_actions.join(", ")}`).toHaveLength(0);
    });
  }
});
