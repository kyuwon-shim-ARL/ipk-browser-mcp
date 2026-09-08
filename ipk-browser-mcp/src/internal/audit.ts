/**
 * Run audit log.
 *
 * Every mutation the tool performs on a groupware form is recorded as a structured event,
 * so a run can be scored after the fact: what did it change, did it stay inside what the
 * form offered, and did anything irreversible happen.
 *
 * This is the evidence behind the M6 (policy violations) and M5 (effort) metrics. It is
 * deliberately append-only and best-effort: auditing must never block or fail a submission.
 */
import * as fs from "fs";
import * as path from "path";

export type AuditAction =
  /** wrote a value into a text/textarea field */
  | "field_write"
  /** chose an existing option in a select */
  | "option_select"
  /** refused to act, with a reason code */
  | "refusal"
  /** uploaded a file */
  | "upload"
  /** saved a draft or submitted for approval */
  | "submit"
  /** opened a form */
  | "navigate";

export interface AuditEvent {
  ts: string;
  runId: string;
  action: AuditAction;
  /** DOM name of the field, where the action targets one */
  field?: string;
  /** true when the element was readOnly - written by design, but worth counting */
  readOnly?: boolean;
  /** true when the element was in the DOM but not rendered. Hidden fields ARE submitted
   *  (unlike disabled ones), so writing them is legitimate - but worth seeing in the log. */
  hidden?: boolean;
  /** for option_select: whether the value came from the options the form already offered */
  fromOfferedOptions?: boolean;
  /** for upload: whether the path passed validateAttachmentPath before the upload */
  validated?: boolean;
  /** for submit: draft (reversible) vs request (goes to an approver) */
  mode?: "draft" | "request";
  /** for submit: whether the caller passed confirm_submit */
  confirmed?: boolean;
  /** for refusal: the error code raised */
  code?: string;
  ok?: boolean;
}

const LOG_PATH = path.resolve(
  process.env.IPK_AUDIT_DIR ||
    path.join(process.env.HOME || "/tmp", ".cache", "ipk-mcp"),
  "audit.jsonl"
);

let runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let enabled = process.env.IPK_AUDIT !== "0";

/** Start a new run. Returns the run id so a harness can correlate its scenario with events. */
export function beginRun(id?: string): string {
  runId = id || `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return runId;
}

export function currentRunId(): string {
  return runId;
}

export function setAuditEnabled(on: boolean): void {
  enabled = on;
}

export function audit(event: Omit<AuditEvent, "ts" | "runId">): void {
  if (!enabled) return;
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true, mode: 0o700 });
    fs.appendFileSync(LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), runId, ...event }) + "\n", "utf8");
  } catch {
    // Never let auditing break a form submission.
  }
}

export function auditLogPath(): string {
  return LOG_PATH;
}

/** Read back the events for one run (used by the benchmark scorer). */
export function readRun(id: string): AuditEvent[] {
  try {
    return fs
      .readFileSync(LOG_PATH, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => e.runId === id);
  } catch {
    return [];
  }
}
