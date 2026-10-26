/**
 * Card ER (AppFrm-021, mker=Y) - the pure parts of the preview and submit paths.
 *
 * This tool never submits the mker=Y card ER, and saves it only with a one-time
 * per-transaction authorization (card-er-authorization.ts): a real save through the form's
 * own [Draft] flow submitted doc 302098 for approval on 2026-10-23 instead of saving a draft
 * (the server had already ignored mode1='draft' once before, filing doc 301323 for
 * approval on 2026-10-08). Without an authorization every request is served as a preview
 * that runs the form's own Check_Form_Request with the network cut, and these helpers
 * decide what the cut blocks and what the captured form held. The person presses the
 * form's own [Draft] or [Request] button themselves after reviewing the preview.
 */

const CARD_PREFIX = /^\s*\[\s*card\s*\]\s*/i;

/**
 * "[Card] <title>", whatever the caller sent. Idempotent: a subject that already carries
 * the prefix (once or more - the page adds it itself when pay_kind is 01) keeps exactly one.
 */
export function normalizeCardSubject(subject: string): string {
  let rest = String(subject ?? "");
  while (CARD_PREFIX.test(rest)) rest = rest.replace(CARD_PREFIX, "");
  rest = rest.trim();
  return rest ? `[Card] ${rest}` : "[Card]";
}

/**
 * Whether the preview's network cut must stop a request. Anything that could write is
 * stopped: every non-GET/HEAD request, and the budget check / document write / approval
 * endpoints whatever the method.
 */
export function isPreviewBlockedRequest(method: string, url: string): boolean {
  const m = String(method || "").toUpperCase();
  if (m !== "GET" && m !== "HEAD") return true;
  return /budget_check_er\.php|document_write\.php|doc_approve/i.test(url);
}

/** Fields of the captured form1 payload worth showing the person. Row fields keep every row. */
const SCALAR_FIELDS = ["subject", "budget_type", "budget_code", "pay_kind", "mode", "mode1", "p_reason"];
const ROW_FIELD = /^(item_[a-z_]+|account_code|account_str|venue|meeting_begin_date|meeting_end_date|participants|purpose|vender|seller|doc_attach_file)\[\]$/;

export interface CapturedFormSummary {
  [field: string]: string | string[] | null;
}

/**
 * Pick the key fields out of a captured FormData (as [name, value] pairs, files as
 * "file:<name>"). Row fields are arrays in DOM order; row 0 is the form's template row
 * when it is submitted at all.
 */
export function summarizeCapturedForm(entries: [string, string][]): CapturedFormSummary {
  const out: CapturedFormSummary = {};
  for (const f of SCALAR_FIELDS) {
    const hit = entries.find(([k]) => k === f);
    out[f] = hit ? hit[1] : null;
  }
  for (const [k, v] of entries) {
    if (!ROW_FIELD.test(k)) continue;
    const arr = (out[k] as string[] | undefined) ?? [];
    arr.push(v);
    out[k] = arr;
  }
  return out;
}

/**
 * Accounts the account picker (pr_account_sel.php Check_Item) treats as meetings: it
 * clears and hides item_name[1]/item_desc[1] and shows the venue/time/participant rows.
 * A row filed with item_name set is stored as a plain item and the document view drops
 * the Venue/Date/Participants/Purpose block (doc 301323, 2026-10-08).
 */
export const MEETING_ACCOUNT_CODES = new Set([
  "420420", "410307", "410310", "420450", "420451", "412104", "420421", "412106", "420422", "412107",
]);

export function isMeetingAccount(code: string | null | undefined): boolean {
  return MEETING_ACCOUNT_CODES.has(String(code ?? ""));
}

/**
 * Overtime Meals (412103): the form's own Check_Form validation refuses a row with this
 * account code unless the hidden #overtime_info block (overtime_start_day, ov_member,
 * ov_purpose) is filled - "Please insert Overtime info". Precedent doc 297084 shows
 * Date/Time, Attendees (login name) and Purpose carried over from the overtime application.
 */
export const OVERTIME_ACCOUNT_CODES = new Set(["412103"]);

export function isOvertimeAccount(code: string | null | undefined): boolean {
  return OVERTIME_ACCOUNT_CODES.has(String(code ?? ""));
}

/**
 * Overseas IT subscriptions carry no Korean VAT: the form's own VAT auto-split (total/11)
 * must be zeroed. Same vendor list as the rules/public/AppFrm-021.json conditional on
 * item_amount_vat[] (memory feedback_overseas_it_vat_zero; precedent 300654).
 */
const OVERSEAS_IT_SUBSCRIPTION = /runpod|google cloud|gemini|chatgpt|openai|claude|anthropic|foxit/i;

export function isOverseasItSubscription(itemName: string | null | undefined): boolean {
  return OVERSEAS_IT_SUBSCRIPTION.test(String(itemName ?? ""));
}

/**
 * Lines of the budget_check_er popup that mean it must not be filed. "not enough budget"
 * is the live wording on that page; the rest are the same refusal phrased otherwise.
 */
const BUDGET_REFUSAL = /not enough budget|insufficient budget|budget (?:is )?exceeded|exceeds? (?:the )?budget/i;

export function budgetPopupRefusals(bodyText: string): string[] {
  return String(bodyText ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => BUDGET_REFUSAL.test(l));
}
