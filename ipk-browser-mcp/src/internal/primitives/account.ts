import type { Page } from "playwright";
import type { FrameLike } from "../../types.js";

/**
 * Account-code primitive for IPK groupware ER forms.
 *
 * The R&D ER form (AppFrm-021) requires an account code per item row, normally
 * picked via a `Sel_account('{rowIdx}')` popup that opens `pr_account_sel.php`.
 * The popup displays valid account codes for the current (budget_type, budget_code)
 * combination and, on click, calls `Check_Item(seq, code, label)` which writes
 * `account_str[]`, `account_code[]`, `account_seq[]` on the parent form.
 *
 * This primitive bypasses the popup by:
 *   1. Fetching the account-code list directly from `pr_account_sel.php` in a
 *      separate tab of the same browser context (reuses session cookies).
 *   2. Replicating `Check_Item`'s field assignments via direct JS injection
 *      into the target FrameLike (Frame-safe, no Page-only APIs).
 *
 * `fetchAccountCodes` needs a Page (for `page.context().newPage()`); the
 * injection function `setAccountCodeOnRow` takes a FrameLike so it can
 * target either a top-level Page or an iframe Frame interchangeably.
 *
 * Discovered: 2026-04-07 session probe (Google Cloud / RunPod ER drafts).
 */

export interface AccountCode {
  seq: string; // internal DB sequence id, e.g. "110"
  code: string; // 6-digit account code, e.g. "410318"
  label: string; // human label, e.g. "IT Software (IT Subscription)"
}

export interface FetchAccountOpts {
  baseUrl: string;
  budgetType: string; // "01"=General, "02"=R&D
  budgetCode: string; // e.g. "NN2606-0001"
  approveType: string; // e.g. "AppFrm-021"
  rowFlag?: string; // sel_item parameter, defaults to "1"
}

/**
 * Fetch the list of valid account codes for a given budget.
 * Opens pr_account_sel.php in a new tab from the existing browser context
 * (reusing session cookies) and parses the option rows.
 *
 * Requires a Page (not FrameLike) because it creates a new page via
 * `page.context().newPage()` — Page-only surface.
 */
export async function fetchAccountCodes(
  page: Page,
  opts: FetchAccountOpts
): Promise<AccountCode[]> {
  const flag = opts.rowFlag ?? "1";
  const url =
    `${opts.baseUrl}/Document/pr_account_sel.php` +
    `?budget_type=${encodeURIComponent(opts.budgetType)}` +
    `&budget_code=${encodeURIComponent(opts.budgetCode)}` +
    `&sel_item=${encodeURIComponent(flag)}` +
    `&approve_type=${encodeURIComponent(opts.approveType)}`;

  const ctx = page.context();
  const probe = await ctx.newPage();
  try {
    await probe.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    return await probe.evaluate(() => {
      const result: { seq: string; code: string; label: string }[] = [];
      const links = Array.from(document.querySelectorAll("a"));
      for (const a of links) {
        const oc = a.getAttribute("onclick") || "";
        // Parse Check_Item('seq','code','label')
        const m = oc.match(
          /Check_Item\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*\)/
        );
        if (m) {
          result.push({ seq: m[1], code: m[2], label: m[3] });
        }
      }
      return result;
    });
  } finally {
    await probe.close();
  }
}

/**
 * Set an account code on a specific item row of the ER form, replicating
 * Check_Item()'s field assignments. The target form must already be loaded.
 *
 * rowIdx is the index in `getElementsByName('account_str[]')` — typically 1
 * for the first visible row (index 0 is the hidden template row).
 *
 * Accepts FrameLike so it works on both top-level Page and iframe Frame.
 */
export async function setAccountCodeOnRow(
  ctx: FrameLike,
  rowIdx: number,
  account: AccountCode
): Promise<void> {
  await ctx.evaluate(
    ({ rowIdx, account }) => {
      const acStr = document.getElementsByName(
        "account_str[]"
      ) as NodeListOf<HTMLInputElement>;
      const acCode = document.getElementsByName(
        "account_code[]"
      ) as NodeListOf<HTMLInputElement>;
      const acSeq = document.getElementsByName(
        "account_seq[]"
      ) as NodeListOf<HTMLInputElement>;
      const msSeq = document.getElementsByName(
        "milestone_seq[]"
      ) as NodeListOf<HTMLInputElement>;
      const msChk = document.getElementsByName(
        "milestone_check"
      ) as NodeListOf<HTMLInputElement>;

      if (acStr[rowIdx]) acStr[rowIdx].value = `[${account.code}] ${account.label}`;
      if (acCode[rowIdx]) acCode[rowIdx].value = account.code;
      if (acSeq[rowIdx]) acSeq[rowIdx].value = account.seq;
      if (msSeq[rowIdx]) msSeq[rowIdx].value = "";
      if (msChk[rowIdx]) msChk[rowIdx].value = "-";
    },
    { rowIdx, account }
  );
}

/**
 * Convenience: fetch + auto-pick the best matching account code.
 * Matching is performed by case-insensitive substring on label.
 * Returns null if no codes match.
 */
export async function pickAccountCode(
  page: Page,
  opts: FetchAccountOpts,
  labelMatch: string | RegExp
): Promise<AccountCode | null> {
  const codes = await fetchAccountCodes(page, opts);
  const matcher =
    typeof labelMatch === "string"
      ? (s: string) => s.toLowerCase().includes(labelMatch.toLowerCase())
      : (s: string) => labelMatch.test(s);
  return codes.find((c) => matcher(c.label)) ?? null;
}
