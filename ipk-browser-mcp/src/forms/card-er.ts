/**
 * Card ER (AppFrm-021, mker=Y) - the pure parts of the preview and submit paths.
 *
 * The mker=Y card ER has no draft: the server ignores mode1='draft' and files the
 * document for approval (doc 301323, 2026-10-08). So a "draft" request is served as a
 * preview that runs the form's own Check_Form_Request with the network cut, and these
 * helpers decide what the cut blocks and what the captured form held.
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
