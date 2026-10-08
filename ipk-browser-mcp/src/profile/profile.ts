/**
 * profile.json: the values a rulebook's self-scope stub (field-rules.ts) checks a draft
 * against when there is no private pack - the card you use, the budget pot assigned to
 * you, who approves your leave. Never a colleague's: a self field is "assigned to this
 * person" (dev/form_rules.py's own definition), so this file holds one person's facts,
 * written by ipk_profile_init (src/tools/ipk-profile.ts) from groupware the logged-in
 * session can already read, and read back by field-rules.ts before a save.
 *
 * Lives at ~/.config/ipk-browser-mcp/profile.json (chmod 600 - it names cards). Never
 * committed, never logged in full; every response that touches it masks card numbers to
 * their last 4 digits (maskCardNumber) and this module itself never prints a raw one.
 */
import * as fs from "fs";
import * as path from "path";

export const PROFILE_SCHEMA_VERSION = 1;

export interface ProfileCard {
  /** Full card number as the groupware shows it (dashes or not), or a masked one
   *  (NNNN-XXXX-XXXX-NNNN - outer digits real, as an approved document's own view
   *  renders it) when that's the only form this was ever readable in. Compared via
   *  cardMatches() below, which knows how to compare a masked entry. */
  number: string;
  /**
   * "own" - the groupware itself said this card belongs to the logged-in person:
   *   corporation_card_list.php's Owner column matched their name, or it appeared on
   *   >=2 of their own non-meeting approved AppFrm-021 documents (one occurrence alone
   *   could be a one-off borrow, a typo'd account, or a card used once before this
   *   person changed cards - two agreeing documents is the bar for "confirmed own").
   * "own-unconfirmed" - seen on exactly one of this person's own non-meeting approved
   *   documents. Satisfies field-rules.ts's HARD card check (it is still this person's
   *   own document, not someone else's), but with a warning attached rather than
   *   silently - see field-rules.ts's CARD_SELF_FIELDS handling.
   * "shared" - seen on the card list, but the Owner column named someone else, or it
   *   only ever appeared on a meeting-account (Team Activities, ...) approved document,
   *   which proves nothing about ownership (that account is paid with the lab's shared
   *   card by design). Kept here only as a record of what was seen; never satisfies the
   *   self check on its own - a shared card is allowed only through an explicit rule (a
   *   form_rules conditional in a private pack), never by sitting in this array.
   */
  kind: "own" | "own-unconfirmed" | "shared";
  /** Whether the Owner-column match (or the approved-ER fallback) actually fired for
   *  this entry, vs. a default assumed when the page gave no holder signal at all. */
  holder_match: boolean;
  /** Where this was read from, e.g. "corporation_card_list.php" or "AppFrm-021 approved (masked)". */
  source: string;
}

export interface ProfileBudgetPot {
  code: string;
  label?: string;
  /** Derived from the code where the convention holds (NN26xx-xxxx -> 2026); see
   *  fiscalYearFromCode. Left out when it can't be derived - never guessed. */
  fiscal_year?: number;
  source: string;
}

export interface ApprovalLine {
  group_leader?: string;
  substitute?: string;
}

export interface Profile {
  schema_version: number;
  user: { name: string; dept: string };
  cards: ProfileCard[];
  budget_pots: ProfileBudgetPot[];
  approval_line?: ApprovalLine;
  /** Vendor (lowercased) -> the fixed note text this person always uses for it, e.g.
   *  the RunPod ER note (feedback_runpod_er_note.md). Nothing here is office practice -
   *  it's this person's own habit, so it is local/self by construction. */
  notes_by_vendor?: Record<string, string>;
  updated_at: string;
}

export function emptyProfile(user: { name: string; dept: string }): Profile {
  return {
    schema_version: PROFILE_SCHEMA_VERSION,
    user,
    cards: [],
    budget_pots: [],
    updated_at: new Date().toISOString(),
  };
}

/** ~/.config/ipk-browser-mcp/profile.json - IPK_HOME_DIR overrides HOME for tests, same
 *  convention as ipk-submit.ts's loadFieldRulesOptions. */
export function profileDir(home: string = process.env.IPK_HOME_DIR ?? process.env.HOME ?? ""): string {
  return path.join(home, ".config", "ipk-browser-mcp");
}

export function profilePath(home?: string): string {
  return path.join(profileDir(home), "profile.json");
}

export function loadProfile(home?: string): Profile | null {
  try {
    return JSON.parse(fs.readFileSync(profilePath(home), "utf-8"));
  } catch {
    return null;
  }
}

/** Writes profile.json with mode 600 (it names cards) and the directory created if
 *  needed. Overwrites whatever was there - ipk_profile_init is meant to be re-run. */
export function saveProfile(profile: Profile, home?: string): string {
  const dir = profileDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const p = profilePath(home);
  fs.writeFileSync(p, JSON.stringify(profile, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(p, 0o600); // belt-and-suspenders: writeFileSync's mode is umask-subject on some platforms.
  return p;
}

/** 1234-5678-9012-3456 / 1234567890123456 -> ****-****-****-3456. Never returns more
 *  than the last 4 digits; a number too short to have 4 digits is fully masked. */
export function maskCardNumber(number: string): string {
  const digits = number.replace(/\D/g, "");
  if (digits.length < 4) return "****";
  return `****-****-****-${digits.slice(-4)}`;
}

/** Digits-only comparison key for a card number - groupware renders the same card with
 *  or without dashes depending on the page, so "1234-5678-9012-3456" and
 *  "1234567890123456" must compare equal. */
export function cardDigits(number: string): string {
  return number.replace(/\D/g, "");
}

/** Does a profile card entry (possibly masked, NNNN-XXXX-XXXX-NNNN) match a full DOM
 *  card value? A masked entry - the only form an approved document's own view ever
 *  renders a card in - is compared by its outer 4+4 real digits only, since the middle
 *  is never recoverable from that source; an unmasked entry compares full digits. */
export function cardMatches(profileNumber: string, domValue: string): boolean {
  const domDigits = cardDigits(domValue);
  if (!/[Xx]/.test(profileNumber)) {
    return cardDigits(profileNumber) === domDigits;
  }
  const groups = profileNumber.split(/[-\s]+/).filter(Boolean);
  const first = cardDigits(groups[0] ?? "");
  const last = cardDigits(groups[groups.length - 1] ?? "");
  if (!first || !last) return false;
  return domDigits.startsWith(first) && domDigits.endsWith(last) && domDigits.length >= first.length + last.length;
}

/** NN2606-0001 -> 2026 (the two digits right after the letters are a 2-digit year).
 *  Returns undefined rather than guessing when the code doesn't fit that shape -
 *  shared-knowledge-v4 C5 only ever expires a pot it can actually read a year off. */
export function fiscalYearFromCode(code: string): number | undefined {
  const m = /^[A-Za-z]{2}(\d{2})/.exec(code);
  if (!m) return undefined;
  return 2000 + Number(m[1]);
}
