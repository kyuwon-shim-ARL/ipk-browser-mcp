import { describe, it, expect } from "vitest";
import {
  normalizeValue,
  valuesEqual,
  buildSchemaIndex,
  matchLabelToSchemaKey,
  compareToFinal,
  classifyHumanChange,
  classifyOutcome,
} from "../../bench/replay-lib.mjs";
import { adaptDoc } from "../../bench/replay-adapters.mjs";

// Synthetic fixtures only - no doc ids, names, cards or pots from the real corpus.
const FIELD_SCHEMA = {
  destination: { dom_name: "travel_dest[]", note: "destination city" },
  purpose: { dom_name: "purpose", note: "purpose of travel" },
  start_date: { dom_name: "start_date" },
  budget_control_no: { dom_name: null, note: "budget control number" },
};

describe("normalizeValue / valuesEqual", () => {
  it("strips thousands commas from numeric strings", () => {
    expect(normalizeValue("1,234,567")).toBe("1234567");
  });
  it("normalizes dot/slash dates to dashes", () => {
    expect(normalizeValue("2026.9.5")).toBe("2026-09-05");
    expect(normalizeValue("2026/09/05")).toBe("2026-09-05");
  });
  it("collapses whitespace and lowercases", () => {
    expect(valuesEqual("  Seoul   Station ", "seoul station")).toBe(true);
  });
  it("treats non-matching text as unequal", () => {
    expect(valuesEqual("Seoul", "Busan")).toBe(false);
  });
});

describe("buildSchemaIndex / matchLabelToSchemaKey", () => {
  it("maps a DOM name (array marker stripped) to its schema key", () => {
    const { domToKey } = buildSchemaIndex(FIELD_SCHEMA);
    expect(domToKey.get("travel_dest")).toBe("destination");
  });
  it("fuzzy-matches a document_view label to a schema key via its note", () => {
    const { keyHints } = buildSchemaIndex(FIELD_SCHEMA);
    expect(matchLabelToSchemaKey("Budget Control No", keyHints)).toBe("budget_control_no");
  });
  it("returns null for an unrelated label", () => {
    const { keyHints } = buildSchemaIndex(FIELD_SCHEMA);
    expect(matchLabelToSchemaKey("Institute Credit Card No", keyHints)).toBeNull();
  });
});

describe("compareToFinal with per-AppFrm label aliases", () => {
  const LEAVE_SCHEMA = {
    leave_type: { dom_name: "leave_kind[]" },
    start_date: { dom_name: "begin_date[]" },
    end_date: { dom_name: "end_date[]" },
  };

  it("maps an alias-table label ('Leave Kind') the fuzzy matcher would miss", () => {
    const { results } = compareToFinal(
      { "leave_kind[]": "Compensatory leave" },
      { "Leave Kind": "Compensatory leave" },
      LEAVE_SCHEMA,
      "AppFrm-073"
    );
    expect(results.find((r) => r.field === "leave_type")?.status).toBe("SAME_AS_FINAL");
  });

  it("handles a '__period__' label with a trailing 'Hours ( N ~ M )' suffix (partial-day leave)", () => {
    const { results, skippedFinalLabel } = compareToFinal(
      { "begin_date[]": "2026-10-07", "end_date[]": "2026-10-07" },
      { Period: "2026-10-07 ~ 2026-10-07  Hours ( 17 ~ 18 )" },
      LEAVE_SCHEMA,
      "AppFrm-073"
    );
    expect(skippedFinalLabel).not.toContain("Period");
    expect(results.find((r) => r.field === "start_date")?.status).toBe("SAME_AS_FINAL");
    expect(results.find((r) => r.field === "end_date")?.status).toBe("SAME_AS_FINAL");
  });

  it("splits a '__period__' label into start_date/end_date comparisons", () => {
    const { results } = compareToFinal(
      { "begin_date[]": "2026-10-07", "end_date[]": "2026-10-07" },
      { Period: "2026-10-07 ~ 2026-10-07" },
      LEAVE_SCHEMA,
      "AppFrm-073"
    );
    expect(results.find((r) => r.field === "start_date")?.status).toBe("SAME_AS_FINAL");
    expect(results.find((r) => r.field === "end_date")?.status).toBe("SAME_AS_FINAL");
  });

  it("reports a null-aliased label (derived, e.g. 'Using Hours') as skipped, not unmapped or EXTRA", () => {
    const { skippedFinalLabel, unmappedFinalLabel, results } = compareToFinal(
      {},
      { "Using Hours": "1" },
      LEAVE_SCHEMA,
      "AppFrm-073"
    );
    expect(skippedFinalLabel).toContain("Using Hours");
    expect(unmappedFinalLabel).not.toContain("Using Hours");
    expect(results).toHaveLength(0);
  });

  it("excludes a profile-sourced EXTRA (substitute contact) from E, but still reports it", () => {
    const schema = { substitute_contact: { dom_name: "substitute_contact", source: "profile" } };
    const { results } = compareToFinal({ substitute_contact: "031-000-0000" }, {}, schema, "AppFrm-073");
    const row = results.find((r) => r.field === "substitute_contact");
    expect(row?.status).toBe("EXTRA");
    expect(row?.profileSourced).toBe(true);
    expect(classifyOutcome({ status: "ok" }, { results })).not.toBe("E");
  });
});

describe("compareToFinal", () => {
  it("classifies a matching field as SAME_AS_FINAL", () => {
    const { results } = compareToFinal(
      { "travel_dest[]": ["Seoul Station"] },
      { Destination: "Seoul Station" },
      FIELD_SCHEMA
    );
    expect(results.find((r) => r.field === "destination")?.status).toBe("SAME_AS_FINAL");
  });

  it("classifies a differing field as DIFF_FROM_FINAL", () => {
    const { results } = compareToFinal(
      { "travel_dest[]": ["Busan"] },
      { Destination: "Seoul Station" },
      FIELD_SCHEMA
    );
    expect(results.find((r) => r.field === "destination")?.status).toBe("DIFF_FROM_FINAL");
  });

  it("classifies a final-only field as MISSING", () => {
    const { results } = compareToFinal({}, { Purpose: "Sample collection" }, FIELD_SCHEMA);
    expect(results.find((r) => r.field === "purpose")?.status).toBe("MISSING");
  });

  it("classifies a tool-only field as EXTRA", () => {
    const { results } = compareToFinal({ purpose: "Fabricated purpose" }, {}, FIELD_SCHEMA);
    expect(results.find((r) => r.field === "purpose")?.status).toBe("EXTRA");
  });

  it("reports unmapped fields on both sides rather than dropping them", () => {
    const { unmappedToolDom, unmappedFinalLabel } = compareToFinal(
      { unknown_dom_field: "x" },
      { "Totally Unrelated Label": "y" },
      FIELD_SCHEMA
    );
    expect(unmappedToolDom).toContain("unknown_dom_field");
    expect(unmappedFinalLabel).toContain("Totally Unrelated Label");
  });
});

describe("classifyHumanChange", () => {
  it("reports no change when the script's value survived to final", () => {
    expect(classifyHumanChange("Seoul", "Seoul", "Seoul")).toEqual({ humanChanged: false });
  });
  it("reports a human change, and whether the tool now matches final", () => {
    expect(classifyHumanChange("Seoul", "Busan", "Busan")).toEqual({ humanChanged: true, toolNowMatchesFinal: true });
    expect(classifyHumanChange("Seoul", "Busan", "Seoul")).toEqual({ humanChanged: true, toolNowMatchesFinal: false });
  });
});

describe("classifyOutcome", () => {
  it("A: all mapped fields match final", () => {
    const compare = { results: [{ field: "x", status: "SAME_AS_FINAL" }] };
    expect(classifyOutcome({ status: "ok" }, compare)).toBe("A");
  });
  it("B: some fields differ or are missing", () => {
    const compare = { results: [{ field: "x", status: "DIFF_FROM_FINAL" }] };
    expect(classifyOutcome({ status: "ok" }, compare)).toBe("B");
  });
  it("E: the tool produced a value the final document never shows (EXTRA)", () => {
    const compare = { results: [{ field: "x", status: "EXTRA" }] };
    expect(classifyOutcome({ status: "ok" }, compare)).toBe("E");
  });
  it("E: the tool errored instead of refusing cleanly", () => {
    expect(classifyOutcome({ status: "error" }, null)).toBe("E");
  });
  it("REFUSED when the tool refused - rightness is a human call, not auto-scored", () => {
    expect(classifyOutcome({ status: "refused" }, null)).toBe("REFUSED");
  });
  it("TIMEOUT and NOT_REPLAYABLE pass through as their own classes", () => {
    expect(classifyOutcome({ status: "timeout" }, null)).toBe("TIMEOUT");
    expect(classifyOutcome({ status: "not_replayable" }, null)).toBe("NOT_REPLAYABLE");
  });
});

describe("adaptDoc", () => {
  it("maps known travel_request script keys to params and flags the rest as unmapped", () => {
    const doc = {
      form_type: "travel_request",
      script_values: { "travel_dest[0]": "Seoul", purpose: "Sample collection", some_unknown_script_field: "x" },
    };
    const { params, unmapped } = adaptDoc(doc);
    expect(params.destination).toBe("Seoul");
    expect(params.purpose).toBe("Sample collection");
    expect(params.dry_run).toBe(true);
    expect(params.draft_only).toBe(true);
    expect(unmapped).toContain("some_unknown_script_field");
  });

  it("returns a null-params, fully-unmapped result for an unknown form_type", () => {
    const { params, unmapped } = adaptDoc({ form_type: "not_a_real_form", script_values: { a: 1 } });
    expect(params).toBeNull();
    expect(unmapped).toEqual(["a"]);
  });

  it("maps budget_transfer source/target/amount aliases", () => {
    const { params, unmapped } = adaptDoc({
      form_type: "budget_transfer",
      script_values: {
        source_account_match: "410703",
        target_account_match: "410306",
        amount1: 700000,
        contents_data: "transfer reason",
      },
    });
    expect(params.from_budget_code).toBe("410703");
    expect(params.to_budget_code).toBe("410306");
    expect(params.transfer_amount).toBe(700000);
    expect(params.reason).toBe("transfer reason");
    expect(unmapped).toEqual([]);
  });

  it("never maps a substitute's payroll number to a name field (fabrication risk)", () => {
    const { params, unmapped } = adaptDoc({
      form_type: "leave",
      script_values: { leave_kind: "Compensatory leave", substitute_payroll_no: "00528", substitute_present: true },
    });
    expect(params.substitute_name).toBeUndefined();
    expect(unmapped).toContain("substitute_payroll_no");
  });
});
