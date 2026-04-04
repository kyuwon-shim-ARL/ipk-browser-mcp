import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { SessionManager } from "../browser/session.js";
import { Config } from "../types.js";
import { navigateInFrame } from "../browser/iframe-helper.js";
import { textResult } from "../util.js";

export const ipkInspectFormSchema = {
  form_code: z.string().describe("Form code to inspect, e.g. AppFrm-054"),
  compare_template: z
    .boolean()
    .default(true)
    .describe("Cross-verify against form_templates JSON"),
};

export const ipkInspectFormDescription =
  "Inspect a groupware form's DOM elements and cross-verify against form templates. " +
  "Use to discover actual field names, types, and options for any form.";

interface DomElement {
  tag: string;
  name: string;
  type: string;
  id: string;
  required: boolean;
  options?: Array<{ value: string; text: string }>;
}

interface MismatchReport {
  in_template_not_in_dom: string[];
  in_dom_not_in_template: string[];
  type_mismatches: Array<{ field: string; template_type: string; dom_type: string }>;
}

export async function handleIpkInspectForm(
  sessionManager: SessionManager,
  config: Config,
  params: { form_code: string; compare_template?: boolean }
) {
  if (!sessionManager.isLoggedIn()) {
    return textResult({ error: true, code: "NOT_LOGGED_IN", message: "Call ipk_login first" });
  }

  const page = sessionManager.getPage()!;
  const formCode = params.form_code;
  const compareTemplate = params.compare_template !== false;

  try {
    // Navigate to the empty form page
    const url = `/Document/document_write.php?approve_type=${formCode}`;
    const frame = await navigateInFrame(page, url, config);
    if (!frame) {
      return textResult({
        error: true,
        code: "FRAME_NOT_FOUND",
        message: "main_menu frame not found. Ensure you are logged in and the groupware is accessible.",
      });
    }

    // Wait for form elements
    await frame.waitForSelector("input, select, textarea", { timeout: 8000 }).catch(() => null);

    // Enumerate all form elements inside the iframe - parameterized evaluate
    const domElements: DomElement[] = await frame.evaluate(() => {
      const elements: Array<{
        tag: string;
        name: string;
        type: string;
        id: string;
        required: boolean;
        options?: Array<{ value: string; text: string }>;
      }> = [];

      document.querySelectorAll("input, select, textarea").forEach((el: any) => {
        if (!el.name) return;
        const info: {
          tag: string;
          name: string;
          type: string;
          id: string;
          required: boolean;
          options?: Array<{ value: string; text: string }>;
        } = {
          tag: el.tagName.toLowerCase(),
          name: el.name,
          type: el.type || el.tagName.toLowerCase(),
          id: el.id || "",
          required: el.required || false,
        };
        if (el.tagName === "SELECT") {
          info.options = Array.from(el.options).map((o: any) => ({
            value: o.value,
            text: (o.textContent || "").trim(),
          }));
        }
        elements.push(info);
      });

      return elements;
    });

    const result: {
      form_code: string;
      dom_url: string;
      element_count: number;
      elements: DomElement[];
      template_comparison?: {
        template_found: boolean;
        template_path?: string;
        mismatch_report?: MismatchReport;
        error?: string;
      };
    } = {
      form_code: formCode,
      dom_url: frame.url(),
      element_count: domElements.length,
      elements: domElements,
    };

    if (compareTemplate) {
      // Resolve template path relative to project root (__dirname works in both src and dist)
      const projectRoot = path.resolve(__dirname, "..", "..");
      const templatePath = path.join(projectRoot, "form_templates", `${formCode}.json`);

      try {
        const raw = fs.readFileSync(templatePath, "utf-8");
        const template = JSON.parse(raw);
        const fieldSchema: Record<string, { type: string; required?: boolean }> =
          template.field_schema || {};

        const templateKeys = new Set(Object.keys(fieldSchema));
        const domNames = new Set(domElements.map((e) => e.name));

        const inTemplateNotInDom = [...templateKeys].filter((k) => !domNames.has(k));
        const inDomNotInTemplate = [...domNames].filter((k) => !templateKeys.has(k));

        // Type mismatches: compare template type to DOM tag/type
        const typeMismatches: Array<{ field: string; template_type: string; dom_type: string }> = [];
        for (const el of domElements) {
          if (!templateKeys.has(el.name)) continue;
          const tType = fieldSchema[el.name].type;
          // Normalize DOM type for comparison
          const domType = el.tag === "textarea" ? "textarea" : el.tag === "select" ? "select" : el.type;
          // Only flag meaningful mismatches (e.g. select vs text, textarea vs text)
          const normalize = (t: string) => {
            if (t === "textarea") return "textarea";
            if (t === "select" || t === "select-one" || t === "select-multiple") return "select";
            if (t === "number" || t === "text" || t === "date" || t === "time") return t;
            return t;
          };
          const normTemplate = normalize(tType);
          const normDom = normalize(domType);
          if (normTemplate !== normDom) {
            typeMismatches.push({
              field: el.name,
              template_type: tType,
              dom_type: domType,
            });
          }
        }

        result.template_comparison = {
          template_found: true,
          template_path: templatePath,
          mismatch_report: {
            in_template_not_in_dom: inTemplateNotInDom,
            in_dom_not_in_template: inDomNotInTemplate,
            type_mismatches: typeMismatches,
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.template_comparison = {
          template_found: false,
          template_path: templatePath,
          error: `Template not found or parse error: ${msg}`,
        };
      }
    }

    return textResult({ error: false, data: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return textResult({ error: true, code: "INSPECT_ERROR", message: msg });
  }
}
