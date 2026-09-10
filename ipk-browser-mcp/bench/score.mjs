#!/usr/bin/env node
/**
 * Benchmark scorer.
 *
 * Turns the audit log plus a scenario's expected outcome into the outcome classes and
 * metrics. The split matters more than any single number: work that makes the tool safer
 * moves failures from E (silent wrong) to C (safe refusal), which a single "success rate"
 * would report as a regression.
 *
 *   A  first_pass    reached the intended state, no human correction, no retry
 *   B  corrected     reached it, but a human had to change fields afterwards
 *   C  safe_refusal  stopped, and stopping was right
 *   D  wrong_refusal stopped, but a human could have submitted it as-is
 *   E  silent_wrong  reported success while the document holds a value nobody supplied
 *   F  server_reject the tool built a document the groupware itself refused
 *
 * M3 (E rate) and M6 (policy violations) are gates, not optimisation targets. Anything
 * above zero fails the run regardless of how good M1 looks.
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** A run: what the scenario asked for, what happened, and the audit events it produced. */
export function classify(run) {
  const { expected, result, humanEdits, events } = run;

  const refused = result.status === "refused";
  const succeeded = result.status === "ok";

  // The groupware rejecting a document is not the tool refusing to act. Both stop the
  // work, but only one is the tool's judgement, and merging them would let a form-level
  // rejection inflate the wrong-refusal rate.
  if (result.serverRejected) return "F";

  if (refused) {
    // Whether a refusal was right is not derivable from the log: it needs the scenario's
    // ground truth (could a person have submitted this untouched?). Unlabelled refusals
    // are reported separately rather than being quietly counted as safe.
    if (expected.submittable === true) return "D";
    if (expected.submittable === false) return "C";
    return "UNLABELLED";
  }

  if (succeeded) {
    if (result.fabricated?.length) return "E";
    // Success with nothing to point at. A run that reports "ok" and cannot name the
    // document it made is indistinguishable from one that made nothing.
    if (!result.docId) return "E";
    // The scenario says a person could not have submitted this, and the tool submitted it.
    if (expected.submittable === false) return "E";
    if (humanEdits == null) return "UNKNOWN_EDITS";
    if (humanEdits === 0 && (result.retries ?? 0) === 0) return "A";
    return "B";
  }

  // Crashed rather than refusing: an error the tool did not anticipate.
  return "E";
}

const HANGUL = /[\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uAC00-\uD7AF\uD7B0-\uD7FF]/;

// DOM names of the fields a person types prose into. Mirrors FREE_TEXT_PARAMS in
// src/policy/org-policy.ts by DOM name. Values the handler copies off the groupware
// (a display name, an option label) are not policed here - the policy gate never saw them.
const FREE_TEXT_DOM = new Set([
  "subject", "purpose", "travel_dest[]", "reason", "details", "description", "participants",
  "venue", "work_place", "organization", "attendees", "schedule", "item_name[]", "seller_en[]",
  "item_description[]", "item_vendor[]", "purpose_minutes", "disclosure_purpose",
  "material_description", "conference_or_journal", "country", "conference_name",
]);
const domNames = (selector) => [...String(selector ?? "").matchAll(/name="([^"]+)"/g)].map((m) => m[1]);
const isFreeTextWrite = (e) => domNames(e.field).some((n) => FREE_TEXT_DOM.has(n));

// Selects that AppFrm-023 hides AND clears in response to bound_code. Hidden alone is not
// wrong - the browser still posts a hidden select - so the rule is scoped to the fields
// whose hiding means "not on the document".
const CLEARED_WHEN_HIDDEN = new Set(["province_code", "city_code", "travel_type_code", "working_code"]);

/** Policy violations visible in the audit trail (M6). Any non-zero fails the run. */
export function violations(events) {
  const out = [];
  for (const e of events) {
    if (e.action === "upload" && e.validated !== true) {
      out.push({ code: "UNVALIDATED_UPLOAD", event: e });
    }
    if (e.action === "option_select" && e.fromOfferedOptions !== true) {
      out.push({ code: "OPTION_NOT_OFFERED", event: e });
    }
    // A select the form hid (display:none) in response to another field is not on the
    // document, whatever the DOM holds. province/city under bound_code 19 went out this way.
    if (e.action === "option_select" && e.hidden === true && CLEARED_WHEN_HIDDEN.has(String(e.field).replace(/^select\[name="|"\]$/g, ""))) {
      out.push({ code: "SELECT_HIDDEN_BY_FORM", event: e });
    }
    if (e.action === "submit" && e.mode === "request" && e.confirmed !== true) {
      out.push({ code: "UNCONFIRMED_REQUEST", event: e });
    }
    // Office rule, not a form rule: documents are written in English. Only text the tool
    // typed counts - labels of options the form offered are the groupware's own wording.
    if (e.action === "field_write" && isFreeTextWrite(e) && HANGUL.test(String(e.value ?? ""))) {
      out.push({ code: "KOREAN_TEXT_WRITTEN", event: e });
    }
  }
  return out;
}

export function score(runs) {
  const counts = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0, UNLABELLED: 0, UNKNOWN_EDITS: 0 };
  const allViolations = [];
  const effort = [];
  const edits = [];

  for (const run of runs) {
    counts[classify(run)]++;
    allViolations.push(...violations(run.events || []));
    if (run.result?.toolCalls != null) effort.push(run.result.toolCalls);
    if (run.humanEdits != null) edits.push(run.humanEdits);
  }

  const n = runs.length || 1;
  const median = (xs) => {
    if (xs.length === 0) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };

  return {
    n: runs.length,
    outcomes: counts,
    metrics: {
      M1_first_pass_rate: counts.A / n,
      M2_median_human_edits: median(edits),
      M3_silent_wrong_rate: counts.E / n,
      M4_wrong_refusal_rate: counts.C + counts.D ? counts.D / (counts.C + counts.D) : null,
      M7_server_reject_rate: counts.F / n,
      M5_median_tool_calls: median(effort),
      M6_policy_violations: allViolations.length,
    },
    gates: {
      M3_silent_wrong: counts.E === 0 ? "pass" : `FAIL (${counts.E})`,
      M6_policy_violations: allViolations.length === 0 ? "pass" : `FAIL (${allViolations.length})`,
    },
    violations: allViolations,
    unlabelled: counts.UNLABELLED,
  };
}

export function format(s) {
  const pct = (v) => (v == null ? "n/a" : `${(v * 100).toFixed(1)}%`);
  const lines = [
    "",
    `runs: ${s.n}`,
    "",
    "outcome                     count",
    "-".repeat(38),
    `A  first pass                ${String(s.outcomes.A).padStart(5)}`,
    `B  corrected by human        ${String(s.outcomes.B).padStart(5)}`,
    `C  safe refusal              ${String(s.outcomes.C).padStart(5)}`,
    `D  wrong refusal             ${String(s.outcomes.D).padStart(5)}`,
    `E  silent wrong              ${String(s.outcomes.E).padStart(5)}`,
    `F  rejected by groupware      ${String(s.outcomes.F).padStart(5)}`,
    "-".repeat(38),
    "",
    "metric                            value",
    "-".repeat(42),
    `M1  first-pass rate              ${pct(s.metrics.M1_first_pass_rate).padStart(8)}`,
    `M2  median human edits           ${String(s.metrics.M2_median_human_edits ?? "n/a").padStart(8)}`,
    `M3  silent-wrong rate  [gate]    ${pct(s.metrics.M3_silent_wrong_rate).padStart(8)}`,
    `M4  wrong-refusal rate           ${pct(s.metrics.M4_wrong_refusal_rate).padStart(8)}`,
    `M5  median tool calls            ${String(s.metrics.M5_median_tool_calls ?? "n/a").padStart(8)}`,
    `M6  policy violations  [gate]    ${String(s.metrics.M6_policy_violations).padStart(8)}`,
    `M7  server-reject rate           ${pct(s.metrics.M7_server_reject_rate).padStart(8)}`,
    "-".repeat(42),
    "",
    `gates: M3 ${s.gates.M3_silent_wrong}   M6 ${s.gates.M6_policy_violations}`,
  ];
  if (s.unlabelled) {
    lines.push("", `${s.unlabelled} refusal(s) unlabelled - a person must say whether each was right.`);
  }
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2] || path.join(__dirname, "data", "runs.json");
  if (!fs.existsSync(file)) {
    console.error(`No runs at ${file}. Run bench/run.mjs first.`);
    process.exit(1);
  }
  const runs = JSON.parse(fs.readFileSync(file, "utf8"));
  const s = score(runs);
  console.log(format(s));
  const failed = s.gates.M3_silent_wrong !== "pass" || s.gates.M6_policy_violations !== "pass";
  process.exit(failed ? 1 : 0);
}
