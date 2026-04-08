#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const TEMPLATES_DIR = path.join(ROOT, "form_templates");
const REGISTRY_PATH = path.join(__dirname, "../src/form-registry.json");

const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf-8"));

let allPass = true;
const results = [];

for (const [formType, entry] of Object.entries(registry)) {
  const templatePath = path.join(TEMPLATES_DIR, entry.templateFile);
  if (!fs.existsSync(templatePath)) {
    results.push({ formType, error: `Template file not found: ${entry.templateFile}` });
    allPass = false;
    continue;
  }

  const template = JSON.parse(fs.readFileSync(templatePath, "utf-8"));
  const schema = template.field_schema;
  if (!schema) {
    results.push({ formType, error: "Missing field_schema" });
    allPass = false;
    continue;
  }

  const fields = Object.entries(schema);
  const totalFields = fields.length;

  // Axis 1: dom_name_coverage — fields with dom_name property explicitly set
  const withDomName = fields.filter(([, f]) => Object.prototype.hasOwnProperty.call(f, "dom_name"));
  const domNameCoverage = totalFields > 0 ? withDomName.length / totalFields : 1;

  // Axis 2: widget_type_coverage — fields with dom_name !== null that have widget_type
  const routableFields = fields.filter(([, f]) => f.dom_name !== null && f.dom_name !== undefined && Object.prototype.hasOwnProperty.call(f, "dom_name"));
  const complexTypes = ["array", "table"];
  const dispatchableFields = routableFields.filter(([, f]) => !complexTypes.includes(f.type));
  const withWidgetType = dispatchableFields.filter(([, f]) => f.widget_type);
  const widgetTypeCoverage = dispatchableFields.length > 0 ? withWidgetType.length / dispatchableFields.length : 1;

  // Axis 3: post_actions_coverage — file_upload/account_lookup fields with post_actions defined
  const specialFields = fields.filter(([, f]) => f.widget_type === "file_upload" || f.widget_type === "account_lookup");
  const specialWithActions = specialFields.filter(([, f]) => Array.isArray(f.post_actions));
  const postActionsCoverage = specialFields.length > 0 ? specialWithActions.length / specialFields.length : 1;

  const pct = (n) => `${(n * 100).toFixed(0)}%`;
  const pass = domNameCoverage >= 1 && widgetTypeCoverage >= 1 && postActionsCoverage >= 1;
  if (!pass) allPass = false;

  results.push({
    formType,
    templateFile: entry.templateFile,
    dom_name_coverage: pct(domNameCoverage),
    widget_type_coverage: pct(widgetTypeCoverage),
    post_actions_coverage: pct(postActionsCoverage),
    pass,
    missing_dom_name: fields.filter(([, f]) => !Object.prototype.hasOwnProperty.call(f, "dom_name")).map(([k]) => k),
    missing_widget_type: dispatchableFields.filter(([, f]) => !f.widget_type).map(([k]) => k),
    missing_post_actions: specialFields.filter(([, f]) => !Array.isArray(f.post_actions)).map(([k]) => k),
  });
}

// Deduplicate by templateFile (card_expense and expense share AppFrm-020.json)
const seen = new Set();
const dedupResults = results.filter((r) => {
  if (!r.templateFile) return true;
  if (seen.has(r.templateFile)) return false;
  seen.add(r.templateFile);
  return true;
});

console.log("\n=== IPK Form Template 3-Axis Completeness Report ===\n");
for (const r of dedupResults) {
  if (r.error) {
    console.log(`FAIL  ${r.formType}: ${r.error}`);
    continue;
  }
  const status = r.pass ? "PASS" : "FAIL";
  console.log(`${status}  ${r.formType} (${r.templateFile})`);
  console.log(`      dom_name: ${r.dom_name_coverage}  widget_type: ${r.widget_type_coverage}  post_actions: ${r.post_actions_coverage}`);
  if (r.missing_dom_name?.length) console.log(`      missing dom_name: ${r.missing_dom_name.join(", ")}`);
  if (r.missing_widget_type?.length) console.log(`      missing widget_type: ${r.missing_widget_type.join(", ")}`);
  if (r.missing_post_actions?.length) console.log(`      missing post_actions: ${r.missing_post_actions.join(", ")}`);
}

if (allPass) {
  console.log("\n✓ All templates pass 3-axis completeness gate.\n");
  process.exit(0);
} else {
  console.log("\n✗ Some templates FAILED. Fix above issues.\n");
  process.exit(1);
}
