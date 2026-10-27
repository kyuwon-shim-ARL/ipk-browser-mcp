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

const LOCK_STALE_MS = 10_000;
const LOCK_ACQUIRE_TIMEOUT_MS = 5_000;

/**
 * Exclusive lock (fs.openSync(..., 'wx'), so two processes racing to create it can never both
 * succeed) around a read-modify-write of the authorizations file, so two processes consuming
 * the same entry at once can never both see it present. A lock older than LOCK_STALE_MS (a
 * crashed holder) is removed and retried rather than deadlocking forever.
 */
/** A few ms of real blocking, used instead of a busy-spin between lock-acquire retries. */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * M-B: after renaming a lock believed stale to `taken`, a FRESH lock may have been created
 * at `lockPath` by another process between the stat() that produced `staleStat` and this
 * renameSync() - if so, the rename just stole THAT live lock, not the stale one. Verify by
 * identity (inode + mtime, not just the path) before deleting what was taken over; restore
 * it via a hard link (fails safely, EEXIST, if a lock already exists at lockPath again -
 * e.g. its owner, or another takeover, already restored/recreated it) if it was a mismatch.
 * Exported so the identity-check/restore behavior can be tested directly, since simulating
 * the actual race window around a single synchronous renameSync() call is not practical.
 */
export function reconcileTakenLock(lockPath: string, taken: string, staleStat: fs.Stats): void {
  let sameFile = false;
  try {
    const takenStat = fs.statSync(taken);
    sameFile = takenStat.ino === staleStat.ino && takenStat.mtimeMs === staleStat.mtimeMs;
  } catch {
    sameFile = false;
  }
  if (sameFile) {
    fs.rmSync(taken, { force: true });
    return;
  }
  // Took someone else's live lock by accident - put it back and never force an overwrite
  // of a live lock.
  try {
    fs.linkSync(taken, lockPath);
  } catch {
    // lockPath already exists again - fine, nothing to restore.
  }
  fs.rmSync(taken, { force: true });
}

function withAuthorizationsLock<T>(file: string, fn: () => T): T {
  const lockPath = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  let fd: number | null = null;
  for (;;) {
    try {
      fd = fs.openSync(lockPath, "wx");
      break;
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      try {
        const staleStat = fs.statSync(lockPath);
        if (Date.now() - staleStat.mtimeMs > LOCK_STALE_MS) {
          // Take over a stale (crashed holder's) lock by renaming it to a unique name first:
          // rename is atomic, so only the one process whose rename succeeds may remove it and
          // retry the O_EXCL create. A concurrent taker's rename fails (the path is already
          // gone) and it simply loops back to retry openSync - never two winners.
          const taken = `${lockPath}.${process.pid}.${Math.random().toString(36).slice(2)}`;
          try {
            fs.renameSync(lockPath, taken);
          } catch {
            continue; // lost the takeover race (or the lock is gone already) - just retry the open.
          }
          reconcileTakenLock(lockPath, taken, staleStat);
          continue;
        }
      } catch {
        continue; // the lock disappeared between the failed open and this stat; retry.
      }
      if (Date.now() > deadline) throw new Error(`could not acquire ${lockPath} within ${LOCK_ACQUIRE_TIMEOUT_MS}ms`);
      sleepMs(25);
    }
  }
  try {
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    fd = null;
  } catch (err) {
    // The lock file exists but could not be written - remove it so it is not left behind
    // as a phantom (non-stale-until-LOCK_STALE_MS) holder forever.
    try { if (fd !== null) fs.closeSync(fd); } catch {}
    fs.rmSync(lockPath, { force: true });
    throw err;
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lockPath, { force: true });
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
  return withAuthorizationsLock(file, () => {
    const auths = readCardErDraftAuthorizations(file);
    const entry = findCardErDraftAuthorization(auths, apprNo, trseq);
    if (!entry) return null;
    removeEntry(auths, String(apprNo), file);
    return entry;
  });
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
  return withAuthorizationsLock(file, () => {
    const auths = readCardErDraftAuthorizations(file);
    const entry = findCardErDocEditAuthorization(auths, docId);
    if (!entry) return null;
    removeEntry(auths, `doc:${String(docId)}`, file);
    return entry;
  });
}
