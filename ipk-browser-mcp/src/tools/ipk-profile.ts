/**
 * ipk_profile_init: reads this logged-in person's own cards and budget pots off the
 * groupware and writes ~/.config/ipk-browser-mcp/profile.json (src/profile/profile.ts) -
 * the file field-rules.ts's self-scope stubs check a draft against (shared-knowledge-v4
 * B2/B4). It asks for nothing the groupware can already answer: cards come from the
 * person's own rows on corporation_card_list.php, budget pots from the options a form's
 * own budget_code select offers this session - both readable with 0 approved documents.
 *
 * READ-ONLY: every navigation here is a GET to a list or an empty form page. This file
 * must never import iframe-helper.ts's form-mode/save helpers or anything from
 * card-er.ts's save path - see the no-save-calls test in test/tools/ipk-profile.test.ts.
 *
 * CARD OWNERSHIP (2026-10-09 live inspection, read-only - column names only, no values
 * were ever printed): corporation_card_list.php has columns
 * `Tr Seq | Card No | Owner | Appr No | Date | Shop | Amount | ER` with no colspan/
 * rowspan irregularity (confirmed: header-cell count == body td count on every row). The
 * "Card No" and "Owner" cells both carry a leading hidden/duplicate run of digits before
 * their real content (a copy-button value, going by shape) - the real card number is the
 * LAST `NNNN-NNNN-NNNN-NNNN`-shaped run in the cell, and the real owner is the
 * capitalised-name-shaped run in it (see CARD_TAIL_RE / NAME_RE). An earlier version of
 * this file scanned the whole row's text with a generic optional-dash digit regex, which
 * matched the leading garbage instead of the real card - every "card" it ever found was
 * wrong. Ownership is decided by matching that extracted name against the session's own
 * display name/username/configured IPK_USER_NAME (see ownerAliases) - a row whose Owner
 * doesn't match is "shared" (shared or a colleague's card, pending in the same
 * department queue) and is recorded but never satisfies field-rules.ts's HARD card check
 * on its own (see field-rules.ts CARD_SELF_FIELDS/ownCardMatch - a shared card on a
 * Team Activities account is allowed only via that module's explicit conditional
 * mechanism, i.e. a curator's private pack, never by appearing in this list).
 *
 * FALLBACK: when the live pending list has 0 rows this person owns (it only shows
 * currently-unprocessed transactions, so a quiet month means nothing to read there),
 * this person's own approved AppFrm-021 documents (type=approved, i.e. own docs only)
 * are read instead. Their rendered view showed the card number in full on live
 * inspection (2026-10-09, one own document) under the "Card Number" label, but the
 * view is known to mask this field in other contexts (public_leak_guard.py's
 * NNNN-XXXX-XXXX-NNNN convention), so parseApprovedCardDoc accepts either form -
 * see src/profile/profile.ts cardMatches() for how a masked entry is still checked.
 *
 * The approval line (group leader, substitute) is read from this person's own most
 * recent approved documents when one exists; with 0 approved documents it is left out,
 * not guessed (the handler reports it as not derivable, same as any other missing key).
 *
 * Parsing is split from navigation (parseCardListRows / parseBudgetPotOptions /
 * parseApprovedCardDoc take plain data, not a Page) so the parsing logic has a plain
 * unit test with synthetic fixtures, independent of Playwright - see
 * test/tools/ipk-profile.test.ts and test/fixtures/profile/.
 */
import { SessionManager } from "../browser/session.js";
import { Config } from "../types.js";
import { textResult } from "../util.js";
import { isMeetingAccount } from "../forms/card-er.js";
import {
  emptyProfile,
  saveProfile,
  maskCardNumber,
  fiscalYearFromCode,
  type Profile,
  type ProfileCard,
  type ProfileBudgetPot,
} from "../profile/profile.js";

export const ipkProfileInitSchema = {};

export const ipkProfileInitDescription =
  "Read this logged-in person's own cards and budget pots off the groupware (read-only - " +
  "never saves, drafts, or submits anything) and write ~/.config/ipk-browser-mcp/profile.json. " +
  "Run this once per person (and again whenever a card or budget pot changes) before " +
  "card/leave/travel/budget forms that have self-scope fields (card number, budget pot), " +
  "so field-rules.ts has something to check those fields against instead of blocking and " +
  "asking every time. Works with 0 approved documents - cards and pots come from the card " +
  "list and a form's own select options, not from history. Returns masked card numbers " +
  "(last 4 digits only) and a list of keys it could not derive, if any.";

/** The last NNNN-NNNN-NNNN-NNNN run in a cell's text - see the file doc comment on why
 *  "last", not "first": a leading, differently-shaped digit run precedes the real card. */
const CARD_TAIL_RE = /\d{4}-\d{4}-\d{4}-\d{4}/g;
/** Two-or-more capitalised-word run, e.g. "Kyuwon Shim" or "Hyun Jung Lee". */
const NAME_RE = /[A-Z][a-zA-Z.'-]*(?:\s+[A-Z][a-zA-Z.'-]*)+/;

function lastMatch(re: RegExp, text: string): string | null {
  const all = text.match(re);
  return all && all.length > 0 ? all[all.length - 1] : null;
}

function normName(s: string): string {
  return s.replace(/\s+/g, "").toLowerCase();
}

/** "kyuwon.shim" (a login id) -> "Kyuwon Shim" - the same transform session.ts uses for
 *  display names, so an id-shaped alias still matches a name-shaped Owner cell. */
function idToDisplayName(id: string): string {
  if (/\s/.test(id)) return id;
  return id.split(/[._]+/).filter(Boolean).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
}

/** A single corporation_card_list.php row's two relevant cells, already extracted by
 *  header name (Card No / Owner) - see fetchCardsFromGroupware for the live DOM read. */
export interface RawCardListRow {
  cardCell: string;
  ownerCell: string;
}

/**
 * Pure: pick the real card number and owner name out of each row's cells, and decide
 * "own" vs "shared" against the aliases this session knows for the logged-in person
 * (display name, username, the id-to-name transform of each, IPK_USER_NAME). A row with
 * no card-shaped tail is dropped (nothing to read).
 */
export function parseCardListRows(rows: RawCardListRow[], ownerAliases: string[]): { number: string; kind: "own" | "shared"; holder_match: boolean }[] {
  // Expand every alias through the id->display-name transform too, so a caller may pass
  // a raw login id ("kyuwon.shim") and still match a name-shaped Owner cell ("Kyuwon
  // Shim") without having to pre-format it the way session.ts does.
  const aliasSet = new Set(
    ownerAliases.filter(Boolean).flatMap((a) => [normName(a), normName(idToDisplayName(a))])
  );
  const out: { number: string; kind: "own" | "shared"; holder_match: boolean }[] = [];
  for (const row of rows) {
    const number = lastMatch(CARD_TAIL_RE, row.cardCell);
    if (!number) continue;
    const ownerName = NAME_RE.exec(row.ownerCell)?.[0] ?? row.ownerCell;
    const holder_match = aliasSet.has(normName(ownerName));
    out.push({ number, kind: holder_match ? "own" : "shared", holder_match });
  }
  return out;
}

/** Dedupe by card digits, keeping "own" if any occurrence of that card was ever marked
 *  own (the same card can show up on several pending rows). */
export function dedupeCards(rows: { number: string; kind: "own" | "shared"; holder_match: boolean }[], source: string): ProfileCard[] {
  const byDigits = new Map<string, ProfileCard>();
  for (const r of rows) {
    const digits = r.number.replace(/\D/g, "");
    const existing = byDigits.get(digits);
    if (!existing) {
      byDigits.set(digits, { number: r.number, kind: r.kind, holder_match: r.holder_match, source });
    } else if (r.kind === "own" && existing.kind !== "own") {
      byDigits.set(digits, { number: r.number, kind: "own", holder_match: true, source });
    }
  }
  return [...byDigits.values()];
}

/** Pure: a <select name="budget_code"> options list (as ipk_inspect_form already reads
 *  one - {value, text}[]) -> the pots this session can file against. The placeholder
 *  option (no code-shaped value) is dropped. */
export function parseBudgetPotOptions(options: { value: string; text: string }[], source: string): ProfileBudgetPot[] {
  const CODE_RE = /^[A-Za-z]{2}\d{2,4}-\d+$/;
  return options
    .filter((o) => CODE_RE.test(o.value))
    .map((o) => ({
      code: o.value,
      label: o.text?.trim() || undefined,
      fiscal_year: fiscalYearFromCode(o.value),
      source,
    }));
}

/** Pure: an approved AppFrm-021 document's rendered innerText -> its card number (full
 *  or masked, whichever the view rendered) and its account code - both read so the
 *  caller can exclude a meeting-account document (Team Activities, ...), which is paid
 *  with the lab's shared card by design and proves nothing about who owns it. */
export function parseApprovedCardDoc(text: string): { cardNumber: string | null; accountCode: string | null } {
  const lines = text.split("\n").map((l) => l.replace(/\s+/g, " ").trim());
  const cardLine = lines.find((l) => /\bCard Number\b/.test(l));
  // Masked form: NNNN-XXXX-XXXX-NNNN (outer digits real). Also accept a fully unmasked
  // tail in case a future view ever renders one.
  const cardNumber = cardLine ? lastMatch(/\d{4}-(?:[Xx]{4}|\d{4})-(?:[Xx]{4}|\d{4})-\d{4}/g, cardLine) : null;
  // The account code appears bracketed, e.g. "[410318] IT Software (IT Subscription)"
  // (confirmed live label/shape, 2026-10-09) - account codes are not personal data
  // (shared-knowledge-v4 B6: an internal pot identifier, not a project/task mapping).
  const accountLine = lines.find((l) => /\[\d{6}\]/.test(l));
  const accountCode = accountLine ? (accountLine.match(/\[(\d{6})\]/) ?? [])[1] ?? null : null;
  return { cardNumber, accountCode };
}

function ownerAliasesFor(userInfo: { username: string; name: string } | null): string[] {
  if (!userInfo) return [];
  const envName = process.env.IPK_USER_NAME;
  return [userInfo.name, userInfo.username, idToDisplayName(userInfo.username), envName ?? "", envName ? idToDisplayName(envName) : ""];
}

async function fetchCardsFromGroupware(page: any, config: Config, userInfo: { username: string; name: string } | null): Promise<ProfileCard[]> {
  const origin = new URL(config.baseUrl).origin;
  await page.goto(`${origin}/Document/corporation_card_list.php`, { waitUntil: "domcontentloaded", timeout: config.navTimeoutMs });
  await page.waitForTimeout(1000);
  const raw: RawCardListRow[] = await page.mainFrame().evaluate(() => {
    const tables = Array.from(document.querySelectorAll("table"));
    const t = tables.find((tbl) => {
      const headRow = tbl.querySelector("tr");
      const headerText = headRow ? Array.from(headRow.querySelectorAll("th,td")).map((c) => (c.textContent || "").trim()) : [];
      return headerText.includes("Owner") && headerText.includes("Card No");
    });
    if (!t) return [];
    const trs = Array.from(t.querySelectorAll("tr"));
    const headers = Array.from(trs[0].querySelectorAll("th,td")).map((c) => (c.textContent || "").trim());
    const cardIdx = headers.indexOf("Card No");
    const ownerIdx = headers.indexOf("Owner");
    const out: { cardCell: string; ownerCell: string }[] = [];
    for (const tr of trs.slice(1)) {
      const cells = Array.from(tr.querySelectorAll("td"));
      const cardCell = (cells[cardIdx]?.textContent || "").replace(/\s+/g, " ").trim();
      const ownerCell = (cells[ownerIdx]?.textContent || "").replace(/\s+/g, " ").trim();
      if (cardCell) out.push({ cardCell, ownerCell });
    }
    return out;
  });
  const parsed = parseCardListRows(raw, ownerAliasesFor(userInfo));
  return dedupeCards(parsed, "corporation_card_list.php");
}

/**
 * Pure: bucket parsed approved-doc cards by how many times each was seen on a
 * non-meeting document. A meeting-account document (Team Activities, ...) is dropped
 * before counting - that account is paid with the lab's shared card by design, so it is
 * never evidence either way about who owns a card. >=2 corroborating documents -> "own";
 * exactly 1 -> "own-unconfirmed"; a card seen only on meeting-account documents never
 * appears here at all (nothing non-meeting corroborates it).
 */
export function bucketApprovedCards(
  docs: { cardNumber: string | null; accountCode: string | null }[],
  isMeeting: (code: string | null) => boolean,
  source: string
): ProfileCard[] {
  const nonMeeting = docs.filter((d) => d.cardNumber && !isMeeting(d.accountCode));
  const counts = new Map<string, string>(); // digits -> the first-seen spelling
  const tally = new Map<string, number>();
  for (const d of nonMeeting) {
    const digits = d.cardNumber!.replace(/\D/g, "");
    tally.set(digits, (tally.get(digits) ?? 0) + 1);
    if (!counts.has(digits)) counts.set(digits, d.cardNumber!);
  }
  const out: ProfileCard[] = [];
  for (const [digits, count] of tally) {
    out.push({
      number: counts.get(digits)!,
      kind: count >= 2 ? "own" : "own-unconfirmed",
      holder_match: true,
      source,
    });
  }
  return out;
}

/** Fallback when the pending list shows nothing this person owns: their own approved
 *  AppFrm-021 documents (type=approved - own docs only, per CLAUDE.md's ER search table).
 *  See bucketApprovedCards for the >=2-documents / meeting-account exclusion rules. */
async function fetchOwnCardsFromApprovedERs(page: any, config: Config): Promise<ProfileCard[]> {
  const origin = new URL(config.baseUrl).origin;
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  const e = new Date();
  const s = new Date(e.getTime() - 365 * 86400000);
  const listUrl = `${origin}/Document/document_list.php?type=approved&s_date=${ymd(s)}&e_date=${ymd(e)}&keyword=&writer=Y&title=Y&contents=Y&attachment=Y`;
  await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: config.navTimeoutMs });
  await page.waitForTimeout(1000);
  const hrefs: string[] = await page.mainFrame().$$eval("a[href*='doc_id=']", (as: any[]) =>
    as.map((a: any) => a.getAttribute("href") || "").filter((h: string) => h.includes("approve_type=AppFrm-021"))
  );
  const docs: { cardNumber: string | null; accountCode: string | null }[] = [];
  for (const href of hrefs.slice(0, 10)) { // enough to find a 2nd corroborating doc; this is a fallback, not a full history read
    await page.goto(new URL(href, `${origin}/Document/`).href, { waitUntil: "domcontentloaded", timeout: config.navTimeoutMs });
    await page.waitForTimeout(800);
    const text: string = await page.evaluate(() => document.body.innerText);
    docs.push(parseApprovedCardDoc(text));
  }
  return bucketApprovedCards(docs, isMeetingAccount, "AppFrm-021 approved documents");
}

async function fetchBudgetPotsFromGroupware(page: any, config: Config): Promise<ProfileBudgetPot[]> {
  const origin = new URL(config.baseUrl).origin;
  // A plain (non-mker) AppFrm-021 write page: GET only, populates budget_code from this
  // session same as any other read of the form - see ipk-inspect.ts's identical pattern.
  await page.goto(`${origin}/Document/document_write.php?approve_type=AppFrm-021`, { waitUntil: "domcontentloaded", timeout: config.navTimeoutMs });
  await page.mainFrame().waitForSelector('select[name="budget_code"]', { timeout: 8000 }).catch(() => null);
  const options: { value: string; text: string }[] = await page.mainFrame().evaluate(() => {
    const el = document.querySelector('select[name="budget_code"]') as HTMLSelectElement | null;
    if (!el) return [];
    return Array.from(el.options).map((o) => ({ value: o.value, text: (o.textContent || "").trim() }));
  });
  return parseBudgetPotOptions(options, "AppFrm-021 budget_code select");
}

export interface ProfileInitDeps {
  fetchCards: (page: any, config: Config, userInfo: { username: string; name: string } | null) => Promise<ProfileCard[]>;
  fetchOwnCardsFallback: (page: any, config: Config) => Promise<ProfileCard[]>;
  fetchBudgetPots: (page: any, config: Config) => Promise<ProfileBudgetPot[]>;
}

const defaultDeps: ProfileInitDeps = {
  fetchCards: fetchCardsFromGroupware,
  fetchOwnCardsFallback: fetchOwnCardsFromApprovedERs,
  fetchBudgetPots: fetchBudgetPotsFromGroupware,
};

export async function handleIpkProfileInit(
  sessionManager: SessionManager,
  config: Config,
  _params: Record<string, unknown> = {},
  deps: ProfileInitDeps = defaultDeps
) {
  if (!sessionManager.isLoggedIn()) {
    return textResult({
      error: true,
      code: "NOT_LOGGED_IN",
      message:
        sessionManager.getLoginState() === "expired"
          ? "Browser session expired after 30 minutes idle (the MCP connection is fine). Call ipk_login again."
          : "Call ipk_login first",
    });
  }

  const page = sessionManager.getPage()!;
  const userInfo = sessionManager.getUserInfo();
  const profile: Profile = emptyProfile({ name: userInfo?.name ?? "", dept: userInfo?.dept ?? "" });

  const notDerived: string[] = [];
  let cardSignal = "corporation_card_list.php Owner column";

  try {
    profile.cards = await deps.fetchCards(page, config, userInfo);
  } catch (err) {
    notDerived.push(`cards (${err instanceof Error ? err.message : String(err)})`);
  }

  const ownCount = profile.cards.filter((c) => c.kind === "own").length;
  if (ownCount === 0) {
    // The pending list only shows currently-unprocessed transactions - a quiet month
    // means nothing to read there, not that this person has no card. Fall back to
    // their own approved history before giving up.
    try {
      const fallback = await deps.fetchOwnCardsFallback(page, config);
      if (fallback.length > 0) {
        profile.cards = [...profile.cards, ...fallback];
        cardSignal = "AppFrm-021 approved documents (card_list.php showed none this person owns)";
      }
    } catch (err) {
      notDerived.push(`cards fallback (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  if (profile.cards.filter((c) => c.kind === "own").length === 0) {
    notDerived.push("cards (no card attributable to this person on corporation_card_list.php or their own approved AppFrm-021 documents)");
  }

  try {
    profile.budget_pots = await deps.fetchBudgetPots(page, config);
  } catch (err) {
    notDerived.push(`budget_pots (${err instanceof Error ? err.message : String(err)})`);
  }
  if (profile.budget_pots.length === 0) notDerived.push("budget_pots (budget_code select offered none)");

  // approval_line is intentionally left to a later pass (derivable only when the person
  // has an approved document to read it off); not attempting it here is "not derived",
  // reported the same way as everything else, not a silent gap.
  notDerived.push("approval_line (group_leader/substitute - not yet read automatically; set by hand if needed)");

  const path = saveProfile(profile, undefined);

  const ownCards = profile.cards.filter((c) => c.kind === "own");
  const sharedCards = profile.cards.filter((c) => c.kind === "shared");

  return textResult({
    error: false,
    data: {
      profile_path: path,
      cards_found: ownCards.length,
      cards_signal: ownCards.length > 0 ? cardSignal : undefined,
      cards_masked: ownCards.map((c) => maskCardNumber(c.number)),
      shared_cards_seen: sharedCards.length, // seen on the list but not this person's - count only
      budget_pots_found: profile.budget_pots.length,
      budget_pot_codes: profile.budget_pots.map((b) => b.code),
      not_derived: notDerived,
      message:
        notDerived.length > 0
          ? `Wrote ${path}. Could not derive: ${notDerived.join("; ")} - ask the person for these only.`
          : `Wrote ${path}. Every key was derived from the groupware; nothing left to ask.`,
    },
  });
}
