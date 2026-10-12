/**
 * ipk_revise_attachments: adds files to a document returned for revision, via the
 * "Additional document" widget on document_view.php (plan v6 P3 item 3c).
 *
 * DOM (2026-10-12 live inspection, doc 301306 - still in revision at the time): up to 3
 * `input[name="trans_attach_file[]"]` slots; the form's own attach-trans handler sets
 * `mode='tran_file'` then calls `form1.submit()` - an IMMEDIATE write, no draft state
 * (same family of risk as card_expense_rd's save). The delete-trans/delete-file handlers
 * share that same mode/form1.submit() mechanism, so this tool never calls either - a
 * del_no left non-empty before our own write would risk a delete riding along with the
 * attach.
 *
 * [Revision Complete] opens a second popup endpoint - a separate, irreversible action
 * (closes the revision). This tool never calls it, period; see the structural "never
 * calls" test in test/tools/ipk-revise-attachments.test.ts (which names the literal
 * function/endpoint strings this comment deliberately avoids repeating).
 *
 * Safety: dry_run defaults true and only reads - the person's own returned opinions
 * (Opinion of approval / the returned-for-revision exchange), the files already added,
 * and what this call WOULD upload, with the P1 attachment review (attachment-review.ts)
 * run against the document's own resolved account so a revision can't re-introduce a
 * labeling/attestation problem. A real write additionally needs confirm_submit:true -
 * the same threshold NO_FINAL_SUBMIT uses elsewhere (org-policy.ts).
 */
import { z } from "zod";
import { SessionManager } from "../browser/session.js";
import { Config } from "../types.js";
import { textResult } from "../util.js";
import { navigateInFrame } from "../browser/iframe-helper.js";
import { validateAttachmentPath } from "../security/attachment-path.js";
import { attachRevisionFiles } from "../internal/primitives/attachment.js";
import { audit } from "../internal/audit.js";
import { ATTACHMENT_KINDS, reviewAttachments, type AttachmentInput, type AttestationException } from "../policy/attachment-review.js";
import {
  parseApprovalOpinions, parseAdditionalDocuments, parseAccountCode, parseEventDates, parseTotalAmount, parseOrganizer,
} from "../forms/document-view.js";

export const ipkReviseAttachmentsSchema = {
  doc_id: z.string().describe("The document to revise (e.g. '301306')."),
  attachments: z.array(z.object({
    path: z.string(),
    kind: z.enum(ATTACHMENT_KINDS),
    quotes: z.array(z.string()).optional().describe("Text the agent itself read from this file, quoted verbatim - required for program/fee_table/society_receipt attestation on accounts that need it."),
  })).min(1).max(3).describe("1-3 files to add (the Additional document widget has 3 slots). One file = one kind."),
  attestation_exception: z.array(z.object({
    kind: z.enum(ATTACHMENT_KINDS),
    date: z.string().optional(),
    reason: z.string(),
    person_confirmed: z.literal(true),
  })).optional(),
  dry_run: z.boolean().default(true).describe("Default true: reads the document's own opinions, existing Additional documents, and what this call would upload - never writes anything. Set false (with confirm_submit:true) to actually upload."),
  confirm_submit: z.boolean().default(false).describe("Must be true for dry_run:false to actually write - attach_file_trans() saves immediately, there is no draft to undo short of deleting the file by hand."),
};

export const ipkReviseAttachmentsDescription =
  "Add files to a card ER (AppFrm-021) returned for revision, via its Additional document widget. " +
  "Shows the document's own returned opinions and existing Additional documents. dry_run=true (default) never " +
  "writes anything. A real write needs dry_run=false AND confirm_submit=true. Never calls [Document Repossess] " +
  "or [Revision Complete] (doc_revision_pop.php) - those remain the person's own actions.";

async function readBodyText(frame: any): Promise<string> {
  try {
    return await frame.evaluate(() => (document.body ? document.body.innerText : ""));
  } catch {
    return "";
  }
}

export async function handleIpkReviseAttachments(
  sessionManager: SessionManager,
  config: Config,
  params: Record<string, any>
) {
  if (!sessionManager.isLoggedIn()) {
    return textResult({
      error: true,
      code: "NOT_LOGGED_IN",
      message: sessionManager.getLoginState() === "expired"
        ? "Browser session expired after 30 minutes idle. Call ipk_login again."
        : "Call ipk_login first",
    });
  }

  const docId = String(params.doc_id || "");
  if (!docId) return textResult({ error: true, code: "DOC_ID_REQUIRED", message: "doc_id is required." });

  const attachments: AttachmentInput[] = Array.isArray(params.attachments) ? params.attachments : [];
  if (attachments.length === 0) {
    return textResult({ error: true, code: "ATTACHMENTS_REQUIRED", message: "Provide 1-3 {path, kind} attachments." });
  }
  if (attachments.length > 3) {
    return textResult({ error: true, code: "TOO_MANY_FILES", message: "At most 3 files per revision call (the Additional document widget has 3 slots)." });
  }
  for (const a of attachments) {
    const err = validateAttachmentPath(a.path);
    if (err) return textResult({ error: true, code: "INVALID_ATTACHMENT", message: `${a.path}: ${err}` });
  }

  const page = sessionManager.getPage()!;
  const frame = await navigateInFrame(
    page, `/Document/document_view.php?doc_id=${docId}&approve_type=AppFrm-021&pop_view=y`, config
  ).catch(() => null);
  if (!frame) {
    return textResult({ error: true, code: "NAVIGATION_FAILED", message: "Could not open the document (main_menu frame not found)." });
  }

  const bodyText = await readBodyText(frame);
  const opinions = parseApprovalOpinions(bodyText);
  const existingAdditionalDocuments = parseAdditionalDocuments(bodyText);
  const accountCode = parseAccountCode(bodyText);
  const eventDates = parseEventDates(bodyText);
  const totalAmount = parseTotalAmount(bodyText);
  const organizer = parseOrganizer(bodyText);

  // accountCode is reported for context but NOT passed to reviewAttachments here: a
  // revision call adds only the files that were found missing, not every kind the
  // account requires (the rest are already on the document from the original submission,
  // unlabeled). Passing accountCode would make reviewAttachments block on "still missing
  // card_slip/society_receipt/..." even when those were never meant to be touched by this
  // call. The per-kind attestation checks (program/fee_table/society_receipt quotes)
  // still run unconditionally - see attachment-review.ts's per-attachment loop.
  const review = reviewAttachments({
    attachments,
    eventStart: eventDates?.start,
    eventEnd: eventDates?.end,
    totalAmount: totalAmount ?? undefined,
    issuerName: organizer ?? undefined,
    exceptions: params.attestation_exception as AttestationException[] | undefined,
  });
  if (review.blocks.length > 0) {
    return textResult({
      error: true,
      code: "ATTACHMENT_REVIEW_BLOCKED",
      message: review.blocks.join("\n"),
      blocks: review.blocks,
      warnings: review.warnings,
    });
  }

  if (params.dry_run !== false) {
    return textResult({
      error: false,
      data: {
        dry_run: true,
        doc_id: docId,
        opinions,
        existing_additional_documents: existingAdditionalDocuments,
        account_code: accountCode,
        would_upload: attachments.map((a) => ({ path: a.path, kind: a.kind })),
        warnings: review.warnings,
        flagged: review.flagged,
        message: `dry_run: would add ${attachments.length} file(s) to doc ${docId}'s Additional document slots. Nothing uploaded.`,
      },
    });
  }

  if (params.confirm_submit !== true) {
    return textResult({
      error: true,
      code: "REVISE_CONFIRM_REQUIRED",
      message: "A real upload needs confirm_submit:true - attach_file_trans() saves immediately, with no draft to undo. Review the dry_run output first.",
    });
  }

  // The delete-trans/delete-file handlers (see module doc comment) share this mode/
  // form1.submit() mechanism; a del_no the page itself left non-empty would ride along
  // with our own write, so refuse rather than risk it.
  const delNo: string = await frame.evaluate(() => {
    const el = document.querySelector('input[name="del_no"]') as HTMLInputElement | null;
    return el ? el.value : "";
  }).catch(() => "");
  if (delNo) {
    return textResult({
      error: true,
      code: "DEL_NO_NOT_EMPTY",
      message: `del_no is unexpectedly '${delNo}' before upload - refusing to risk a delete alongside the attach. Reload the document and retry.`,
    });
  }

  // attachRevisionFiles (src/internal/primitives/attachment.ts) is the one audited place
  // allowed to call setInputFiles on trans_attach_file[] - it re-validates every path too.
  const uploadResult = await attachRevisionFiles(frame, attachments.map((a) => a.path));
  const attached = uploadResult.attached;
  const skipped = uploadResult.skipped;

  // The form's own attach-trans handler - mode='tran_file' then form1.submit(). This
  // function never triggers the revision-close popup or either delete handler (see
  // module doc comment and the structural test).
  await frame.evaluate(() => {
    const w = window as any;
    if (typeof w.attach_file_trans === "function") {
      w.attach_file_trans();
      return;
    }
    const modeEl = document.querySelector('input[name="mode"]') as HTMLInputElement | null;
    if (modeEl) modeEl.value = "tran_file";
    const form = (document as any).form1;
    if (form && typeof form.submit === "function") form.submit();
  }).catch(() => undefined);

  await page.waitForTimeout(1500).catch(() => undefined);
  const afterText = await readBodyText(frame);
  const afterDocs = parseAdditionalDocuments(afterText);

  audit({
    action: "upload",
    docId,
    field: "trans_attach_file[]",
    value: JSON.stringify(attachments.map((a) => ({ path: a.path, kind: a.kind }))),
    validated: true,
    ok: attached === attachments.length,
  });

  return textResult({
    error: false,
    data: {
      doc_id: docId,
      attached,
      skipped,
      existing_additional_documents_before: existingAdditionalDocuments,
      existing_additional_documents_after: afterDocs,
      message: `${attached}/${attachments.length} file(s) added to doc ${docId}'s Additional document slots.`,
    },
  });
}
