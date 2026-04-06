import { describe, it, expect } from "vitest";

/**
 * Tests for the normalize function logic used in ipk-inspect.ts template comparison.
 * The normalize function is inlined in handleIpkInspectForm (line ~146), so we replicate
 * it here to test the 6 type-normalisation branches independently.
 */

// Replicated normalize function from ipk-inspect.ts (lines 146-151)
function normalize(t: string): string {
  if (t === "textarea") return "textarea";
  if (t === "select" || t === "select-one" || t === "select-multiple") return "select";
  if (t === "number" || t === "text" || t === "date" || t === "time") return t;
  return t;
}

// ─── normalize type-normalisation branches ──────────────────────

describe("normalize (type-normalisation)", () => {
  it("textarea → textarea", () => {
    expect(normalize("textarea")).toBe("textarea");
  });

  it("select → select", () => {
    expect(normalize("select")).toBe("select");
  });

  it("select-one → select", () => {
    expect(normalize("select-one")).toBe("select");
  });

  it("select-multiple → select", () => {
    expect(normalize("select-multiple")).toBe("select");
  });

  it("number → number", () => {
    expect(normalize("number")).toBe("number");
  });

  it("text → text", () => {
    expect(normalize("text")).toBe("text");
  });

  it("date → date", () => {
    expect(normalize("date")).toBe("date");
  });

  it("time → time", () => {
    expect(normalize("time")).toBe("time");
  });

  it("unknown type passes through unchanged", () => {
    expect(normalize("hidden")).toBe("hidden");
    expect(normalize("checkbox")).toBe("checkbox");
  });
});

// ─── Template comparison logic ──────────────────────────────────

describe("template comparison logic", () => {
  // Replicate the comparison logic from ipk-inspect.ts
  interface DomElement {
    tag: string;
    name: string;
    type: string;
    id: string;
    required: boolean;
  }

  function compareTemplateWithDom(
    fieldSchema: Record<string, { type: string; required?: boolean }>,
    domElements: DomElement[]
  ) {
    const templateKeys = new Set(Object.keys(fieldSchema));
    const domNames = new Set(domElements.map((e) => e.name));

    const inTemplateNotInDom = [...templateKeys].filter((k) => !domNames.has(k));
    const inDomNotInTemplate = [...domNames].filter((k) => !templateKeys.has(k));

    const typeMismatches: Array<{ field: string; template_type: string; dom_type: string }> = [];
    for (const el of domElements) {
      if (!templateKeys.has(el.name)) continue;
      const tType = fieldSchema[el.name].type;
      const domType = el.tag === "textarea" ? "textarea" : el.tag === "select" ? "select" : el.type;
      const normTemplate = normalize(tType);
      const normDom = normalize(domType);
      if (normTemplate !== normDom) {
        typeMismatches.push({ field: el.name, template_type: tType, dom_type: domType });
      }
    }

    return { inTemplateNotInDom, inDomNotInTemplate, typeMismatches };
  }

  it("detects fields in template but not in DOM", () => {
    const schema = {
      subject: { type: "text", required: true },
      budget_code: { type: "select", required: true },
    };
    const dom: DomElement[] = [
      { tag: "input", name: "subject", type: "text", id: "", required: true },
    ];
    const result = compareTemplateWithDom(schema, dom);
    expect(result.inTemplateNotInDom).toEqual(["budget_code"]);
    expect(result.inDomNotInTemplate).toHaveLength(0);
  });

  it("detects fields in DOM but not in template", () => {
    const schema = {
      subject: { type: "text", required: true },
    };
    const dom: DomElement[] = [
      { tag: "input", name: "subject", type: "text", id: "", required: true },
      { tag: "input", name: "extra_field", type: "hidden", id: "", required: false },
    ];
    const result = compareTemplateWithDom(schema, dom);
    expect(result.inTemplateNotInDom).toHaveLength(0);
    expect(result.inDomNotInTemplate).toEqual(["extra_field"]);
  });

  it("detects type mismatch between template and DOM", () => {
    const schema = {
      budget_code: { type: "text", required: true }, // template says text
    };
    const dom: DomElement[] = [
      { tag: "select", name: "budget_code", type: "select-one", id: "", required: true }, // DOM is select
    ];
    const result = compareTemplateWithDom(schema, dom);
    expect(result.typeMismatches).toHaveLength(1);
    expect(result.typeMismatches[0].field).toBe("budget_code");
    expect(result.typeMismatches[0].template_type).toBe("text");
  });

  it("no mismatch when template select matches DOM select-one", () => {
    const schema = {
      budget_type: { type: "select", required: true },
    };
    const dom: DomElement[] = [
      { tag: "select", name: "budget_type", type: "select-one", id: "", required: true },
    ];
    const result = compareTemplateWithDom(schema, dom);
    expect(result.typeMismatches).toHaveLength(0);
  });

  it("no mismatch when both are textarea", () => {
    const schema = {
      contents1: { type: "textarea", required: false },
    };
    const dom: DomElement[] = [
      { tag: "textarea", name: "contents1", type: "textarea", id: "", required: false },
    ];
    const result = compareTemplateWithDom(schema, dom);
    expect(result.typeMismatches).toHaveLength(0);
  });

  it("handles empty template and DOM", () => {
    const result = compareTemplateWithDom({}, []);
    expect(result.inTemplateNotInDom).toHaveLength(0);
    expect(result.inDomNotInTemplate).toHaveLength(0);
    expect(result.typeMismatches).toHaveLength(0);
  });
});
