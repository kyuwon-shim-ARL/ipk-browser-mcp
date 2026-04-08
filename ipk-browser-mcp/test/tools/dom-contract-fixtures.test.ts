import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const FIXTURES_DIR = path.resolve(__dirname, "../fixtures/inspect-form");
const TEMPLATES_DIR = path.resolve(__dirname, "../../../form_templates");
const REGISTRY = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../src/form-registry.json"), "utf-8")
);

interface FixtureField {
  dom_name: string;
  widget_type: string;
  found: boolean;
}

interface Fixture {
  form_type: string;
  appFrmCode: string;
  fields: FixtureField[];
}

describe("DOM contract: mock fixtures match templates", () => {
  for (const [formType, entry] of Object.entries(REGISTRY) as [string, any][]) {
    it(`${formType}: fixture exists and all dom_names are present`, () => {
      const fixturePath = path.join(FIXTURES_DIR, `${formType}.json`);
      expect(fs.existsSync(fixturePath), `fixture missing: ${formType}.json`).toBe(true);

      const fixture: Fixture = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));
      expect(fixture.form_type).toBe(formType);
      expect(fixture.appFrmCode).toBe(entry.appFrmCode);

      // Load template
      const templatePath = path.join(TEMPLATES_DIR, entry.templateFile);
      if (!fs.existsSync(templatePath)) return;
      const template = JSON.parse(fs.readFileSync(templatePath, "utf-8"));
      const schema = template.field_schema || {};

      // All template fields with non-null dom_name should appear in fixture
      const fixtureDomNames = new Set(fixture.fields.map((f) => f.dom_name));
      const templateDomNames = Object.values(schema as Record<string, any>)
        .filter((f: any) => f.dom_name !== null && f.dom_name !== undefined)
        .map((f: any) => f.dom_name as string);

      const missing = templateDomNames.filter((dn) => !fixtureDomNames.has(dn));
      expect(
        missing,
        `${formType}: template dom_names missing from fixture: ${missing.join(", ")}`
      ).toHaveLength(0);
    });

    it(`${formType}: all fixture fields are found=true`, () => {
      const fixturePath = path.join(FIXTURES_DIR, `${formType}.json`);
      if (!fs.existsSync(fixturePath)) return;
      const fixture: Fixture = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));
      const notFound = fixture.fields.filter((f) => !f.found).map((f) => f.dom_name);
      expect(notFound, `${formType}: fields not found in DOM: ${notFound.join(", ")}`).toHaveLength(0);
    });
  }
});
