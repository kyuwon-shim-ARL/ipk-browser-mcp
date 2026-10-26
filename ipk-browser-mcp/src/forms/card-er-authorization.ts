/**
 * One-time, per-transaction authorization for saving ONE card ER (AppFrm-021 mker=Y) through
 * the form's own [Draft] flow (allow_card_er_save=true). card_expense_rd is otherwise
 * preview-only: on 2026-10-23 a save submitted doc 302098 for approval, so a save needs a
 * person's explicit go-ahead for that exact card transaction.
 *
 * File: ~/.config/ipk-browser-mcp/card-er-draft-authorizations.json, written by a person (or
 * an agent at the person's request) outside the tool:
 *   { "<appr_no>": { "trseq": "<trseq>", "authorized_at": "<ISO 8601>", "note": "<why>" } }
 * The tool only reads it and consumes the matching entry (both appr_no and trseq must match)
 * BEFORE any click, so one entry can never produce two saves, even if the call fails midway.
 *
 * The same file also holds one-time authorizations to EDIT one existing card ER draft
 * (ipk_card_er_fix_vat), keyed "doc:<doc_id>" so they can never match an appr_no:
 *   { "doc:<doc_id>": { "doc_id": "<doc_id>", "authorized_at": "<ISO 8601>", "note": "<why>" } }
 * The key and the entry's doc_id must both name the doc. Consumed before any click, like above.
 */
import * as fs from "fs";
import * as path from "path";
import { profileDir } from "../profile/profile.js";

export interface CardErDraftAuthorization {
  trseq: string;
  authorized_at?: string;
  note?: string;
}

export interface CardErDocEditAuthorization {
  doc_id: string;
  authorized_at?: string;
  note?: string;
}

export type CardErDraftAuthorizations = Record<string, CardErDraftAuthorization>;

export function cardErAuthorizationPath(home?: string): string {
  return path.join(profileDir(home), "card-er-draft-authorizations.json");
}

/** Missing or invalid file -> {} (no authorization). */
export function readCardErDraftAuthorizations(file: string = cardErAuthorizationPath()): CardErDraftAuthorizations {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export function findCardErDraftAuthorization(
  auths: CardErDraftAuthorizations,
  apprNo: unknown,
  trseq: unknown
): CardErDraftAuthorization | null {
  const key = String(apprNo ?? "");
  const want = String(trseq ?? "");
  if (!key || !want || !Object.prototype.hasOwnProperty.call(auths, key)) return null;
  const entry = auths[key];
  if (!entry || typeof entry !== "object" || typeof entry.trseq !== "string") return null;
  return entry.trseq === want ? entry : null;
}

/** Removes auths[key] (temp file + rename, so the file is never half-written). */
function removeEntry(auths: Record<string, unknown>, key: string, file: string): void {
  const rest = { ...auths };
  delete rest[key];
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(rest, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Removes the matching entry and returns it; null when nothing matches - the file is then
 * left untouched. Throws if the rewrite fails, so the caller refuses rather than saving on
 * an unconsumed authorization.
 */
export function consumeCardErDraftAuthorization(
  apprNo: unknown,
  trseq: unknown,
  file: string = cardErAuthorizationPath()
): CardErDraftAuthorization | null {
  const auths = readCardErDraftAuthorizations(file);
  const entry = findCardErDraftAuthorization(auths, apprNo, trseq);
  if (!entry) return null;
  removeEntry(auths, String(apprNo), file);
  return entry;
}

/** The "doc:<doc_id>" entry whose doc_id is that same doc, else null. */
export function findCardErDocEditAuthorization(
  auths: Record<string, unknown>,
  docId: unknown
): CardErDocEditAuthorization | null {
  const id = String(docId ?? "");
  const key = `doc:${id}`;
  if (!id || !Object.prototype.hasOwnProperty.call(auths, key)) return null;
  const entry = auths[key] as CardErDocEditAuthorization | null;
  if (!entry || typeof entry !== "object" || entry.doc_id !== id) return null;
  return entry;
}

/** Same contract as consumeCardErDraftAuthorization, for a "doc:<doc_id>" entry. */
export function consumeCardErDocEditAuthorization(
  docId: unknown,
  file: string = cardErAuthorizationPath()
): CardErDocEditAuthorization | null {
  const auths = readCardErDraftAuthorizations(file);
  const entry = findCardErDocEditAuthorization(auths, docId);
  if (!entry) return null;
  removeEntry(auths, `doc:${String(docId)}`, file);
  return entry;
}
