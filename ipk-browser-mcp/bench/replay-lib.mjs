/**
 * Golden-replay pure logic: param adapters, field comparison and A-F classification.
 *
 * Kept separate from bench/replay.mjs (the stdio runner) so it can be unit-tested with
 * synthetic fixtures - no groupware access, no real documents, nothing personal.
 *
 * Schema this operates on (corpus_structured.json, produced by a separate agent):
 *   { doc_id, appfrm, form_type, input_kind: "script"|"derived-from-final",
 *     script_values: { <DOM name or script key>: value, ... },
 *     final: { <label as shown in document_view>: value, ... },
 *     multi_save: bool }
 */

// ---------------------------------------------------------------------------
// Normalization - must agree on both sides of a comparison, or every number/date
// field looks like a diff for no reason.
// ---------------------------------------------------------------------------

/** Collapse whitespace, strip thousands-separator commas from numbers, lowercase. */
export function normalizeValue(v) {
  if (v == null) return "";
  let s = String(v).trim().replace(/\s+/g, " ");
  // A bare number with comma thousands-separators ("1,234,567") -> "1234567".
  if (/^-?[\d,]+(\.\d+)?$/.test(s) && s.includes(",")) s = s.replace(/,/g, "");
  // Normalize "YYYY.MM.DD" / "YYYY/MM/DD" to "YYYY-MM-DD" so date fields compare equal
  // regardless of which separator the groupware happened to render.
  const dateMatch = s.match(/^(\d{4})[.\/](\d{1,2})[.\/](\d{1,2})$/);
  if (dateMatch) s = `${dateMatch[1]}-${dateMatch[2].padStart(2, "0")}-${dateMatch[3].padStart(2, "0")}`;
  return s.toLowerCase();
}

export function valuesEqual(a, b) {
  return normalizeValue(a) === normalizeValue(b);
}

// ---------------------------------------------------------------------------
// DOM name <-> schema key <-> final label
// ---------------------------------------------------------------------------

/** Strip a trailing "[]" / "[N]" array marker from a DOM name. */
export function baseDomName(name) {
  return String(name ?? "").replace(/\[\d*\]$/, "");
}

/**
 * form_templates/<AppFrm>.json field_schema has no "label" field today (checked the
 * actual files - only dom_name/note/type). So the schema *key* itself (e.g. "destination",
 * "purpose_category") is the only label-ish text available, plus its free-text "note".
 * Build dom_name -> schema key, and a list of {key, hints} for fuzzy-matching a
 * document_view label against it.
 */
export function buildSchemaIndex(fieldSchema) {
  const domToKey = new Map();
  const keyHints = [];
  for (const [key, def] of Object.entries(fieldSchema || {})) {
    const dom = baseDomName(def.dom_name);
    if (dom) domToKey.set(dom, key);
    const hints = [key.replace(/_/g, " ")];
    if (def.note) hints.push(def.note);
    keyHints.push({ key, hints: hints.map((h) => h.toLowerCase()) });
  }
  return { domToKey, keyHints };
}

const squash = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Explicit document_view label -> schema key overrides, per AppFrm, for labels the
 * fuzzy matcher in matchLabelToSchemaKey gets wrong or can't reach (schema has no
 * "label" field - see the module comment). A value of `null` means "this label is
 * real but derived/computed, not a direct tool param" (e.g. "Using Hours" is computed
 * server-side from start_hour/end_hour) - it is reported separately as skipped, not
 * silently dropped and not scored as a diff. `"__period__"` means "label holds a
 * 'START ~ END' range" and is exploded into start_date/end_date comparisons.
 */
export const LABEL_ALIASES = {
  "AppFrm-073": {
    "leave kind": "leave_type",
    period: "__period__",
    "using days": null,
    "using hours": null,
    status: null,
    approved: null,
    "document no": null,
    subject: "subject",
    "purpose for leave": "purpose",
    purpose: "purpose",
    destination: "destination",
    "destination for leaves": "destination",
    substitute: "substitute_name",
    "pa exception": null,
    "attached approved document": null,
  },
  "AppFrm-023": {
    "document no": null,
    status: null,
    "approved date": null,
    "start date": "start_date",
    "end date": "end_date",
    "travel destination": "destination",
    "purpose type": "purpose_type",
    materials: "matrials",
    "bound code": "bound_code",
    "working code": "working_code",
  },
  "AppFrm-054": {
    "document no": null,
    status: null,
    "approved date": null,
  },
  "AppFrm-039": {
    "document no": null,
    status: null,
    "approved date": null,
    "control no": null,
  },
  "AppFrm-021": {
    "document no": null,
    status: null,
    "approved date": null,
  },
};

/** Match a document_view label (free text) to a schema key by substring either way. */
export function matchLabelToSchemaKey(label, keyHints) {
  const sq = squash(label);
  if (!sq) return null;
  let best = null;
  for (const { key, hints } of keyHints) {
    const keySq = squash(key);
    if (sq.includes(keySq) || keySq.includes(sq)) { best = key; break; }
    for (const h of hints) {
      const hSq = squash(h);
      if (hSq.length >= 4 && (sq.includes(hSq) || hSq.includes(sq))) { best = key; break; }
    }
    if (best) break;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/**
 * Compare the tool's dry_run `fields` (DOM name -> value, as serializeFormFields returns
 * it) against the document's `final` (label -> value) through the form's field_schema.
 *
 * Returns per-field classification plus the fields that could not be mapped on either
 * side - unmapped fields are reported, never silently dropped.
 */
export function compareToFinal(dryRunFields, finalFields, fieldSchema, appfrm) {
  const { domToKey, keyHints } = buildSchemaIndex(fieldSchema);
  const sourceOf = (key) => (fieldSchema || {})[key]?.source;
  const aliases = LABEL_ALIASES[appfrm] || {};

  // schema key -> dry_run value (collapsing array rows: take the first non-empty value).
  const toolByKey = new Map();
  const unmappedToolDom = [];
  for (const [dom, value] of Object.entries(dryRunFields || {})) {
    const key = domToKey.get(baseDomName(dom));
    if (!key) { unmappedToolDom.push(dom); continue; }
    const v = Array.isArray(value) ? value.find((x) => String(x ?? "").trim()) : value;
    if (!toolByKey.has(key) || (v != null && String(v).trim())) toolByKey.set(key, v);
  }

  // final label -> schema key, via the explicit per-AppFrm alias table first, then the
  // generic fuzzy matcher as a fallback for labels the alias table doesn't mention.
  const finalByKey = new Map();
  const unmappedFinalLabel = [];
  const skippedFinalLabel = [];
  const results = [];
  for (const [label, value] of Object.entries(finalFields || {})) {
    const aliasKey = squash(label) in aliases ? aliases[squash(label)] : undefined;
    if (aliasKey === null) { skippedFinalLabel.push(label); continue; }
    if (aliasKey === "__period__") {
      // The raw label can carry a trailing "Hours ( 17 ~ 18 )" suffix after the date
      // range (full-day leave has none) - anchor on the two leading ISO dates rather
      // than blind-splitting on "~", which would also split that suffix.
      const m = String(value ?? "").match(/^(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})/);
      if (m) {
        for (const [k, v] of [["start_date", m[1]], ["end_date", m[2]]]) {
          if (!finalByKey.has(k)) finalByKey.set(k, v);
        }
      } else {
        skippedFinalLabel.push(label);
      }
      continue;
    }
    const key = aliasKey ?? matchLabelToSchemaKey(label, keyHints);
    if (!key) { unmappedFinalLabel.push(label); continue; }
    finalByKey.set(key, value);
  }

  const allKeys = new Set([...toolByKey.keys(), ...finalByKey.keys()]);
  for (const key of allKeys) {
    const hasTool = toolByKey.has(key) && String(toolByKey.get(key) ?? "").trim() !== "";
    const hasFinal = finalByKey.has(key) && String(finalByKey.get(key) ?? "").trim() !== "";
    if (hasTool && hasFinal) {
      results.push({
        field: key,
        status: valuesEqual(toolByKey.get(key), finalByKey.get(key)) ? "SAME_AS_FINAL" : "DIFF_FROM_FINAL",
        tool: toolByKey.get(key),
        final: finalByKey.get(key),
      });
    } else if (!hasTool && hasFinal) {
      results.push({ field: key, status: "MISSING", final: finalByKey.get(key) });
    } else if (hasTool && !hasFinal) {
      // A field whose schema entry is itself sourced from the groupware (the writer's or a
      // substitute's own profile: name, payroll no, contact, address) is legitimately on
      // every such document - it reads EXTRA only because the corpus's `final` dict is a
      // reduced label summary that never listed it, not because the tool invented it.
      // Reported either way; only excluded from outcome scoring (classifyOutcome's caller
      // filters on `profileSourced`).
      const src = sourceOf(key);
      results.push({
        field: key,
        status: "EXTRA",
        tool: toolByKey.get(key),
        profileSourced: src === "profile" || src === "auto_filled",
      });
    }
  }

  return { results, unmappedToolDom, unmappedFinalLabel, skippedFinalLabel };
}

/**
 * For a multi-save doc: did the human change a field the script set, away from what the
 * tool (now) produces? `scriptValue` is what input_params/the script originally wrote;
 * `finalValue` is what the approved document ended up holding; `toolValue` is what this
 * dry_run run produced for the same schema key.
 */
export function classifyHumanChange(scriptValue, finalValue, toolValue) {
  const scriptMatchesFinal = valuesEqual(scriptValue, finalValue);
  if (scriptMatchesFinal) return { humanChanged: false };
  return {
    humanChanged: true,
    toolNowMatchesFinal: toolValue !== undefined && valuesEqual(toolValue, finalValue),
  };
}

// ---------------------------------------------------------------------------
// Outcome classification (A-F), adapted from bench/score.mjs's semantics for a replay
// (no live human-edit measurement - the ground truth is the already-approved final doc).
// ---------------------------------------------------------------------------

/**
 * @param {object} toolResult {status: "ok"|"refused"|"error"|"not_replayable"|"timeout", ...}
 * @param {object} compare    result of compareToFinal, or null if toolResult wasn't "ok"
 */
export function classifyOutcome(toolResult, compare) {
  if (toolResult.status === "timeout") return "TIMEOUT";
  if (toolResult.status === "not_replayable") return "NOT_REPLAYABLE";
  if (toolResult.status === "error") return "E"; // crashed rather than refusing cleanly
  if (toolResult.status === "refused") return "REFUSED"; // right/wrong needs a human call

  // status === "ok": dry_run succeeded and returned fields.
  const diffs = compare.results.filter((r) => r.status === "DIFF_FROM_FINAL");
  const missing = compare.results.filter((r) => r.status === "MISSING");
  // EXTRA = the tool put a mapped-field value the approved document does not show at all -
  // a value nobody supplied making it onto a document, silently wrong. Profile-sourced
  // fields (substitute identity, emergency contact, writer's own auto-filled block) are
  // excluded: they are always on the real document, and only look EXTRA here because the
  // corpus's `final` label summary never listed that category at all.
  const extra = compare.results.filter((r) => r.status === "EXTRA" && !r.profileSourced);
  if (extra.length > 0) return "E";
  if (diffs.length === 0 && missing.length === 0) return "A";
  return "B";
}
