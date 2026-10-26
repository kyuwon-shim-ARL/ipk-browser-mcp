/**
 * ipk_card_er_fix_vat: corrects "Amount excl. VAT" on ONE existing card ER draft
 * (AppFrm-021, in the person's type=drafts list) for an overseas IT subscription - VAT 0,
 * excl. VAT = total. Drafts 302242-302244 (2026-10-26) were saved with VAT zeroed but
 * item_amount_ral1[] still carrying the form's 10/11 split; the create path is fixed
 * (ipk-submit.ts Step 2b-iii), these drafts must be edited in place.
 *
 * Edit page (document_write.php?...&type=drafts&doc_id=N, live read-only inspection
 * 2026-10-26 of 302242/302243/302244):
 *  - [ Save ]    = fn_Edit_Check('update', 'drafts'): mode1='drafts', then Check_Form_Request('update')
 *  - [ Request ] = mode1='request', then Check_Form_Request('update')  <- never used here
 *  Check_Form_Request shows the "Evidence Check" $.confirm, whose Next posts form1 to the
 *  budget_check_er popup - the same flow as the create page, so saveCardExpenseRDDraft
 *  runs it with mode1 'drafts' instead of 'draft' and the edit runner below.
 *  - body onload (Reset_Form -> process_money) recomputes item_amount[] = ral1 + vat, so the
 *    DOM total is already WRONG (247,394 for a 272,133 doc) when the page opens. The real
 *    total is the server-rendered value attribute, cross-checked against document_view.
 *  - existing attachments are server-side links (.attatch_file_link); nothing here touches
 *    del_file() or the file inputs. The attachment list is compared before/after.
 *
 * dry_run (default) reads and fills the values in the page, saves nothing, needs no
 * authorization. A save needs a one-time "doc:<doc_id>" entry in
 * ~/.config/ipk-browser-mcp/card-er-draft-authorizations.json (card-er-authorization.ts),
 * consumed before any click.
 */
import { z } from "zod";
import { SessionManager } from "../browser/session.js";
import { Config } from "../types.js";
import { textResult } from "../util.js";
import { navigateInFrame } from "../browser/iframe-helper.js";
import { audit } from "../internal/audit.js";
import { isOverseasItSubscription } from "../forms/card-er.js";
import { cardErAuthorizationPath, consumeCardErDocEditAuthorization, type CardErDocEditAuthorization } from "../forms/card-er-authorization.js";
import { detectSubmittedOnDocumentView } from "../browser/card-er-location.js";
import { listHasDoc } from "../browser/draft-guard.js";
import { parseCardErItemRows, parseFileAttachmentList, type CardErItemRow } from "../forms/document-view.js";
import { saveCardExpenseRDDraft, type CardErRun } from "./ipk-submit.js";

export const ipkCardErFixVatSchema = {
  doc_id: z.string().regex(/^\d+$/).describe("The card ER draft to correct (must be in the person's type=drafts list)."),
  dry_run: z.boolean().default(true).describe(
    "Default true: reads the draft, fills VAT 0 / excl. VAT = total in the Edit page and reports it - saves nothing. " +
    "false: needs a one-time { \"doc:<doc_id>\": { \"doc_id\": \"<doc_id>\", \"authorized_at\": \"<ISO>\", \"note\": \"...\" } } entry in " +
    "~/.config/ipk-browser-mcp/card-er-draft-authorizations.json, consumed before any click."
  ),
};

export const ipkCardErFixVatDescription =
  "Correct one existing card ER (AppFrm-021) DRAFT of an overseas IT subscription (RunPod/Claude/OpenAI/Google Cloud/...) " +
  "to VAT 0 and Amount excl. VAT = Total, through the Edit page's own [Save] (mode1='drafts'; never [Request]). " +
  "Refuses docs not in type=drafts, filed docs, multi-row docs and non-overseas items. Reads document_view back " +
  "after saving: DRAFT_UPDATED / SUBMITTED_NOT_DRAFT / DRAFT_NOT_CONFIRMED / VALUES_NOT_UPDATED.";

/** What the Edit page shows for row 1 (runs in the form frame). */
export interface EditRowState {
  rows: string;
  item_name: string;
  total_attr: string;
  total_value: string;
  vat: string;
  excl: string;
  subject: string;
  has_process_money: boolean;
  has_edit_check: boolean;
  mod_reasons: boolean;
}

export function readEditRowState(): EditRowState {
  const w = window as any;
  const at = (n: string) => document.getElementsByName(n)[1] as HTMLInputElement | undefined;
  const cnt = document.getElementsByName("er_row_cnt")[0] as HTMLSelectElement | undefined;
  const subj = document.querySelector('input[name="subject"]') as HTMLInputElement | null;
  return {
    rows: cnt ? String(cnt.value) : "",
    item_name: at("item_name[]")?.value ?? "",
    total_attr: at("item_amount[]")?.getAttribute("value") ?? "",
    total_value: at("item_amount[]")?.value ?? "",
    vat: at("item_amount_vat[]")?.value ?? "",
    excl: at("item_amount_ral1[]")?.value ?? "",
    subject: subj ? subj.value : "",
    has_process_money: typeof w.process_money === "function",
    has_edit_check: typeof w.fn_Edit_Check === "function",
    mod_reasons: document.getElementsByName("MOD_REASONS").length > 0,
  };
}

/** Row 1: VAT 0, excl. VAT = the server-rendered total, then the page's own process_money(). */
export function applyOverseasVatZero(total: string): { total_value: string; total_amt: string; vat: string; excl: string } {
  const at = (n: string) => document.getElementsByName(n)[1] as HTMLInputElement | undefined;
  const vat = at("item_amount_vat[]");
  const excl = at("item_amount_ral1[]");
  if (vat) vat.value = "0";
  if (excl) excl.value = total;
  (window as any).process_money();
  const amt = document.getElementById("total_amt") as HTMLInputElement | null;
  return { total_value: at("item_amount[]")?.value ?? "", total_amt: amt ? amt.value : "", vat: vat?.value ?? "", excl: excl?.value ?? "" };
}

/** Runs in the form frame after installCardErStubs: the Edit page's own [ Save ] handler. */
export function runEditSaveFlow(): CardErRun {
  const w = window as any;
  const st = w.__ipkCardEr;
  try {
    if (typeof w.fn_Edit_Check !== "function") throw new Error("fn_Edit_Check is not defined on this page");
    w.fn_Edit_Check("update", "drafts");
  } catch (err) {
    st.pageError = err instanceof Error ? err.message : String(err);
  }
  return JSON.parse(JSON.stringify(st));
}

/** The [ Edit ] link on document_view for this doc, if any. */
export function readEditHref(): string[] {
  return Array.from(document.querySelectorAll("a"))
    .map((a) => a.getAttribute("href") || "")
    .filter((h) => h.includes("document_write.php"));
}

function readBodyText(): string {
  return document.body ? document.body.innerText : "";
}

const refuse = (code: string, message: string, extra: Record<string, unknown> = {}) =>
  textResult({ error: true, code, message, ...extra });

export async function handleIpkCardErFixVat(sessionManager: SessionManager, config: Config, params: Record<string, any>) {
  if (!sessionManager.isLoggedIn()) {
    return refuse("NOT_LOGGED_IN", sessionManager.getLoginState() === "expired"
      ? "Browser session expired after 30 minutes idle. Call ipk_login again."
      : "Call ipk_login first");
  }
  const docId = String(params.doc_id ?? "");
  if (!/^\d+$/.test(docId)) return refuse("DOC_ID_REQUIRED", "doc_id must be a numeric document id.");

  const page = sessionManager.getPage()!;
  const viewPath = `/Document/document_view.php?doc_id=${docId}&approve_type=AppFrm-021&type=drafts`;
  const listPath = "/Document/document_list.php?type=drafts";

  // 1. In the person's Drafts, not filed.
  const inDrafts = async (): Promise<boolean | null> => {
    try {
      const f = await navigateInFrame(page, listPath, config);
      return f ? listHasDoc(String(await f.content()), docId) : null;
    } catch {
      return null;
    }
  };
  if ((await inDrafts()) !== true) {
    return refuse("NOT_IN_DRAFTS", `doc ${docId} is not in document_list.php?type=drafts (or the list could not be read). Only drafts are edited. Nothing was changed.`);
  }
  const frame: any = await navigateInFrame(page, viewPath, config).catch(() => null);
  if (!frame) return refuse("NAVIGATION_FAILED", "Could not open the document (main_menu frame not found). Nothing was changed.");
  const viewText = String((await frame.evaluate(readBodyText).catch(() => "")) ?? "");
  const markers = detectSubmittedOnDocumentView(viewText);
  if (markers.length > 0) {
    return refuse("NOT_A_DRAFT", `doc ${docId}'s document_view shows ${markers.join(" and ")} - it is filed, not a draft. Nothing was changed.`, { submitted_markers: markers });
  }
  const rows = parseCardErItemRows(viewText);
  if (rows.length !== 1) {
    return refuse("ROWS_UNSUPPORTED", `doc ${docId} has ${rows.length} readable item row(s); only single-row card ERs are corrected. Nothing was changed.`, { rows });
  }
  const before = rows[0];
  if (!isOverseasItSubscription(before.item_name)) {
    return refuse("NOT_OVERSEAS_IT_SUBSCRIPTION", `"${before.item_name}" is not an overseas IT subscription; its VAT split is not changed here. Nothing was changed.`, { before });
  }
  if (before.vat === 0 && before.excl === before.total) {
    return textResult({ error: false, data: { doc_id: docId, outcome: "NOTHING_TO_FIX", before, message: `doc ${docId} already has VAT 0 and excl. VAT = total (${before.total}). Nothing was changed.` } });
  }
  const attachmentsBefore = parseFileAttachmentList(viewText);

  // 2. Its own Edit page.
  const hrefs: string[] = await frame.evaluate(readEditHref).catch(() => []);
  const origin = new URL(config.baseUrl).origin;
  const editUrl = hrefs
    .map((h) => { try { return new URL(h, `${origin}/Document/document_view.php`).toString(); } catch { return ""; } })
    .find((u) => new RegExp(`[?&]doc_id=${docId}(?!\\d)`).test(u) && /[?&]type=drafts(?:&|$)/.test(u) && /[?&]approve_type=AppFrm-021(?:&|$)/.test(u));
  if (!editUrl) return refuse("EDIT_LINK_NOT_FOUND", `doc ${docId}'s document_view has no [Edit] link to document_write.php with type=drafts. Nothing was changed.`, { hrefs });
  await navigateInFrame(page, editUrl, config);
  const state: EditRowState = await frame.evaluate(readEditRowState);
  const total = String(before.total);
  const problems: string[] = [];
  if (state.rows !== "1") problems.push(`er_row_cnt is '${state.rows}', not '1'`);
  if (state.item_name.trim() !== before.item_name) problems.push(`row 1 item_name '${state.item_name}' differs from document_view '${before.item_name}'`);
  if (state.total_attr !== total) problems.push(`row 1 server total '${state.total_attr}' differs from document_view total ${total}`);
  if (!state.has_process_money || !state.has_edit_check) problems.push("process_money/fn_Edit_Check missing");
  if (state.mod_reasons) problems.push("the page asks for a modification reason (MOD_REASONS)");
  if (problems.length > 0) {
    await navigateInFrame(page, viewPath, config).catch(() => null);
    return refuse("EDIT_PAGE_UNEXPECTED", `The Edit page is not the one this was built against: ${problems.join("; ")}. Nothing was changed.`, { state });
  }
  const expected = { excl: before.total, vat: 0, total: before.total };

  if (params.dry_run !== false) {
    const filled = await frame.evaluate(applyOverseasVatZero, total);
    await navigateInFrame(page, viewPath, config).catch(() => null);
    return textResult({
      error: false,
      data: {
        dry_run: true,
        doc_id: docId,
        before,
        edit_page_on_load: { excl: state.excl, vat: state.vat, total: state.total_value },
        would_set: expected,
        filled_in_page: filled,
        attachments: attachmentsBefore,
        message:
          `dry_run: doc ${docId} would be saved through the Edit page's own [ Save ] (mode1='drafts') with excl. VAT ${total}, VAT 0, total ${total}. ` +
          `Nothing was saved; the page was left without saving. A save needs a "doc:${docId}" entry in ${cardErAuthorizationPath()}.`,
      },
    });
  }

  // 3. One-time authorization, consumed before anything is changed or clicked.
  let auth: CardErDocEditAuthorization | null = null;
  try {
    auth = consumeCardErDocEditAuthorization(docId);
  } catch (err) {
    return refuse("CARD_ER_EDIT_REFUSED", `The authorization for doc ${docId} could not be consumed (${err instanceof Error ? err.message : String(err)}). Nothing was clicked.`);
  }
  if (!auth) {
    await navigateInFrame(page, viewPath, config).catch(() => null);
    return refuse(
      "CARD_ER_EDIT_REFUSED",
      `Saving doc ${docId} needs a one-time authorization: ${cardErAuthorizationPath()} has no ` +
      `"doc:${docId}": { "doc_id": "${docId}", "authorized_at": "<ISO>", "note": "..." } entry. A person adds it; the tool consumes it ` +
      "before clicking, so each entry allows one save attempt. Nothing was saved."
    );
  }
  audit({ action: "draft_save", code: "AUTHORIZATION_CONSUMED", field: "card_er_fix_vat", docId, mode: "draft", value: JSON.stringify({ key: `doc:${docId}`, ...auth }), ok: true });

  const filled = await frame.evaluate(applyOverseasVatZero, total);
  if (filled.total_value !== total || filled.total_amt !== total || filled.vat !== "0" || filled.excl !== total) {
    return refuse("VALUE_SET_FAILED", `After setting VAT 0 / excl. VAT ${total}, the page shows ${JSON.stringify(filled)}. Nothing was clicked. The authorization was consumed.`, { filled });
  }

  return await saveCardExpenseRDDraft(
    page, frame, config,
    { subject: state.subject, effectiveBudgetCode: null, attachResult: { attached: 0, skipped: [] }, fileCount: 0 },
    {
      mode1: "drafts",
      runner: runEditSaveFlow,
      finish: async () => {
        const afterFrame: any = await navigateInFrame(page, viewPath, config).catch(() => null);
        const afterText = afterFrame ? String((await afterFrame.evaluate(readBodyText).catch(() => "")) ?? "") : "";
        const base = { doc_id: docId, document_view: `${origin}${viewPath}`, before, expected };
        const filedMarkers = detectSubmittedOnDocumentView(afterText);
        if (filedMarkers.length > 0) {
          audit({ action: "refusal", code: "SUBMITTED_NOT_DRAFT", docId, mode: "draft", ok: false });
          return refuse("SUBMITTED_NOT_DRAFT",
            `doc ${docId} was FILED FOR APPROVAL by the save: document_view shows ${filedMarkers.join(" and ")}. ` +
            "The tool did not retry and did not repossess it - the person decides.", { ...base, submitted_markers: filedMarkers });
        }
        if (!afterText.trim()) {
          return refuse("DRAFT_NOT_CONFIRMED", `submit_form() ran for doc ${docId} but its document_view could not be read. Check it before retrying.`, base);
        }
        const after: CardErItemRow | undefined = parseCardErItemRows(afterText)[0];
        const attachmentsAfter = parseFileAttachmentList(afterText);
        const stillDraft = await inDrafts();
        const details = { ...base, after: after ?? null, attachments_before: attachmentsBefore, attachments_after: attachmentsAfter, in_drafts: stillDraft };
        if (stillDraft !== true) {
          audit({ action: "draft_save", docId, mode: "draft", ok: false, code: "DRAFT_NOT_CONFIRMED" });
          return refuse("DRAFT_NOT_CONFIRMED", `submit_form() ran; document_view shows no filed marker, but doc ${docId} is not in type=drafts. Check it before retrying.`, details);
        }
        if (!after || after.excl !== expected.excl || after.vat !== expected.vat || after.total !== expected.total) {
          audit({ action: "draft_save", docId, mode: "draft", ok: false, code: "VALUES_NOT_UPDATED" });
          return refuse("VALUES_NOT_UPDATED", `doc ${docId} is still a draft, but document_view shows ${JSON.stringify(after ?? null)}, not ${JSON.stringify(expected)}.`, details);
        }
        const lost = attachmentsBefore.filter((f) => !attachmentsAfter.includes(f));
        if (lost.length > 0) {
          audit({ action: "draft_save", docId, mode: "draft", ok: false, code: "ATTACHMENTS_LOST" });
          return refuse("ATTACHMENTS_LOST", `doc ${docId} was updated and is still a draft, but these attachments are gone: ${lost.join(", ")}.`, details);
        }
        audit({ action: "draft_save", docId, mode: "draft", confirmed: true, ok: true, code: "DRAFT_UPDATED" });
        return textResult({
          error: false,
          data: {
            ...details,
            success: true,
            outcome: "DRAFT_UPDATED",
            message: `doc ${docId} is still a draft (type=drafts, no filed marker) and now shows excl. VAT ${after.excl}, VAT ${after.vat}, total ${after.total}.`,
          },
        });
      },
    }
  );
}
