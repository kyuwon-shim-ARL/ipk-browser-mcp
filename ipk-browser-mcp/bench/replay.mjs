#!/usr/bin/env node
/**
 * Golden replay: run each corpus doc's script_values through ipk_submit_form with
 * dry_run:true (and draft_only:true) against the BUILT dist server over stdio - the same
 * harness shape as bench/run.mjs, chosen specifically because it avoids the tsx `__name`
 * injection issue that breaks page.evaluate callbacks under tsx (see dry-run.test.ts /
 * the dry_run round's live-check notes).
 *
 * dry_run:true means nothing is ever saved, drafted or submitted - see
 * src/tools/ipk-submit.ts buildDryRunPreview and its per-form-type short-circuits.
 *
 * Corpus and all corpus-derived output stay under the scratchpad - never read into or
 * written out to the repo. This script and its sibling adapters/lib are the only
 * committable artifacts; they contain no doc ids, names, cards or pots.
 *
 *   node bench/replay.mjs <scratchpad>/replay/corpus_structured.json <scratchpad>/replay
 */
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { adaptDoc } from "./replay-adapters.mjs";
import { compareToFinal, classifyOutcome, classifyHumanChange } from "./replay-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "..", "dist", "ipk-browser-mcp.mjs");
const REPO_ROOT = path.join(__dirname, "..", "..");
const PER_DOC_TIMEOUT_MS = 120000;

function loadFieldSchema(appfrm) {
  const p = path.join(REPO_ROOT, "form_templates", `${appfrm}.json`);
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")).field_schema || {};
  } catch {
    return null;
  }
}

function connect() {
  const proc = spawn("node", [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let id = 0;
  let buf = "";
  proc.stdout.on("data", (d) => {
    buf += d;
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p(msg); }
    }
  });
  const call = (method, params, timeoutMs = PER_DOC_TIMEOUT_MS) =>
    new Promise((resolve, reject) => {
      const rid = ++id;
      pending.set(rid, resolve);
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: rid, method, params }) + "\n");
      setTimeout(() => { if (pending.delete(rid)) reject(new Error("timeout")); }, timeoutMs);
    });
  return { proc, call, close: () => proc.kill("SIGTERM") };
}

function payload(res) {
  if (res?.error) return { error: true, message: `JSON-RPC error: ${res.error.message || JSON.stringify(res.error)}` };
  try { return JSON.parse(res.result.content[0].text); } catch (e) { return { error: true, message: `unparseable response: ${e.message}` }; }
}

// script_values keys that belong to a travel-REPORT (purpose_field/discuss_field/...),
// not a travel REQUEST. Doc 299953 has a travel report appended onto the same AppFrm-023
// document (per commit 770dd13) and the corpus's script_values captured that report, not
// the original request - there is nothing travel_request-shaped to replay for it.
const TRAVEL_REPORT_SHAPED_KEYS = new Set([
  "report_date", "report_leader", "purpose_field", "date_field", "org_field",
  "person_field", "discuss_field", "agenda_field", "result_field", "conclusion_field",
]);
function looksLikeMisboxedReportContent(doc) {
  if (doc.form_type !== "travel_request") return false;
  const keys = Object.keys(doc.script_values || {});
  return keys.some((k) => TRAVEL_REPORT_SHAPED_KEYS.has(k));
}

async function replayDoc(call, doc) {
  if (doc.input_kind === "none") {
    return { status: "not_replayable", reason: doc.note || "no source script found - no input to replay", unmapped: [] };
  }
  if (looksLikeMisboxedReportContent(doc)) {
    return {
      status: "not_replayable",
      reason: "script_values hold travel-REPORT fields (report_leader/discuss_field/...), not travel_request fields - this doc's travel report was appended onto the same AppFrm-023 document (770dd13); nothing travel_request-shaped to replay",
      unmapped: Object.keys(doc.script_values || {}),
    };
  }

  const { form_type, params, unmapped } = adaptDoc(doc);
  if (!params) {
    return { status: "not_replayable", reason: `no adapter for form_type '${form_type}'`, unmapped };
  }

  let res;
  try {
    res = await call("tools/call", { name: "ipk_submit_form", arguments: { form_type, ...params } });
  } catch (e) {
    if (String(e.message || e).includes("timeout")) return { status: "timeout", unmapped };
    return { status: "error", message: String(e.message || e), unmapped };
  }

  const p = payload(res);
  const body = p && p.data ? { ...p, ...p.data } : p;
  if (!body) return { status: "error", message: "unparseable response", unmapped };
  if (body.error) {
    // card_expense_rd's mker page is keyed to a *pending* card transaction (trseq/appr_no).
    // Every corpus doc is already approved, so its transaction is no longer pending by
    // definition - this is not the tool refusing a bad input, it's the replay harness
    // asking for a page that structurally cannot exist for an already-settled doc.
    if (form_type === "card_expense_rd" && /did not prefill/i.test(String(body.message || ""))) {
      return {
        status: "not_replayable",
        reason: "AppFrm-021 mker page requires a still-pending card transaction; this doc's trseq/appr_no is already processed/approved, so the page cannot prefill. No dry_run-safe fallback exists (card_expense_rd has no plain-write-page path).",
        unmapped,
      };
    }
    return { status: "refused", code: body.code, message: body.message, unmapped };
  }
  if (!body.dry_run) return { status: "error", message: "response did not come back as dry_run - refusing to trust it", unmapped };
  return { status: "ok", fields: body.fields || {}, fieldRuleBlocks: body.field_rule_result?.blocks?.length ?? 0, unmapped };
}

async function main() {
  const corpusPath = process.argv[2];
  const outDir = process.argv[3];
  if (!corpusPath || !outDir) {
    console.error("usage: node bench/replay.mjs <corpus_structured.json> <output dir>");
    process.exit(1);
  }
  let corpus = JSON.parse(fs.readFileSync(corpusPath, "utf8"));
  const onlyIdx = process.argv.indexOf("--only");
  if (onlyIdx !== -1) {
    const only = new Set(process.argv[onlyIdx + 1].split(","));
    corpus = corpus.filter((d) => only.has(String(d.doc_id)) || only.has(d.form_type));
  }

  const { call, close } = connect();
  await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "replay", version: "1" } });
  // The shared host can be under heavy load from other concurrent agents' browsers;
  // retry login a few times before giving up rather than failing on one slow navigation.
  let login = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    login = payload(await call("tools/call", { name: "ipk_login", arguments: {} }));
    if (login && !login.error) break;
    console.error(`login attempt ${attempt} failed:`, login?.message || login);
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (!login || login.error) { console.error("login failed after retries:", login); close(); process.exit(1); }

  const docResults = [];
  for (const doc of corpus) {
    const t0 = Date.now();
    const toolResult = await replayDoc(call, doc);
    const schema = loadFieldSchema(doc.appfrm);
    let compare = null;
    let humanChanges = [];
    if (toolResult.status === "ok" && schema) {
      compare = compareToFinal(toolResult.fields, doc.final, schema, doc.appfrm);
      if (doc.multi_save && doc.script_values && doc.final) {
        // Best-effort: only compares where script_values and final happen to share an
        // exact key name (schema has no document_view label, see replay-lib.mjs).
        for (const [k, scriptVal] of Object.entries(doc.script_values)) {
          if (doc.final[k] === undefined) continue; // only compare where final used the same key
          const toolMatch = compare.results.find((r) => r.field === k);
          humanChanges.push({ field: k, ...classifyHumanChange(scriptVal, doc.final[k], toolMatch?.tool) });
        }
      }
    }
    const outcome = classifyOutcome(toolResult, compare);
    docResults.push({
      doc_id: doc.doc_id,
      appfrm: doc.appfrm,
      form_type: doc.form_type,
      outcome,
      status: toolResult.status,
      message: toolResult.message || toolResult.reason || null,
      unmappedScriptKeys: toolResult.unmapped || [],
      unmappedToolDom: compare?.unmappedToolDom || [],
      unmappedFinalLabel: compare?.unmappedFinalLabel || [],
      skippedFinalLabel: compare?.skippedFinalLabel || [],
      compare: compare?.results || [],
      humanChanges,
      ms: Date.now() - t0,
    });
    console.error(`${String(doc.doc_id).padEnd(10)} ${doc.form_type.padEnd(18)} ${outcome}`);
  }

  close();

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(docResults, null, 2));
  fs.writeFileSync(path.join(outDir, "results.md"), toMarkdown(docResults));
  console.log(`wrote ${path.join(outDir, "results.json")} and results.md`);
}

function toMarkdown(docResults) {
  const lines = ["# Golden replay results", "", "| doc | form | outcome | same | diff | missing | extra | unmapped(script/dom/label) |", "|---|---|---|---|---|---|---|---|"];
  for (const r of docResults) {
    const counts = { same: 0, diff: 0, missing: 0, extra: 0 };
    for (const c of r.compare) {
      if (c.status === "SAME_AS_FINAL") counts.same++;
      else if (c.status === "DIFF_FROM_FINAL") counts.diff++;
      else if (c.status === "MISSING") counts.missing++;
      else if (c.status === "EXTRA") counts.extra++;
    }
    lines.push(
      `| ${r.doc_id} | ${r.form_type} | ${r.outcome} | ${counts.same} | ${counts.diff} | ${counts.missing} | ${counts.extra} | ${r.unmappedScriptKeys.length}/${r.unmappedToolDom.length}/${r.unmappedFinalLabel.length} |`
    );
  }
  lines.push("", "## Per-doc detail", "");
  for (const r of docResults) {
    lines.push(`### ${r.doc_id} (${r.form_type}, ${r.appfrm}) - ${r.outcome}`);
    if (r.message) lines.push(`- message: ${r.message}`);
    const diffs = r.compare.filter((c) => c.status !== "SAME_AS_FINAL");
    if (diffs.length) lines.push(`- field diffs: ${diffs.map((d) => `${d.field}(${d.status})`).join(", ")}`);
    if (r.unmappedScriptKeys.length) lines.push(`- unmapped script keys: ${r.unmappedScriptKeys.join(", ")}`);
    if (r.unmappedToolDom.length) lines.push(`- unmapped tool DOM fields: ${r.unmappedToolDom.join(", ")}`);
    if (r.unmappedFinalLabel.length) lines.push(`- unmapped final labels: ${r.unmappedFinalLabel.join(", ")}`);
    if (r.skippedFinalLabel?.length) lines.push(`- skipped final labels (derived/not a direct param): ${r.skippedFinalLabel.join(", ")}`);
    if (r.humanChanges.length) {
      lines.push(`- human changes (multi-save): ${r.humanChanges.map((h) => `${h.field}:${h.humanChanged ? (h.toolNowMatchesFinal ? "tool now matches" : "tool still differs") : "no change"}`).join(", ")}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
