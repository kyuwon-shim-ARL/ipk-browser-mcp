/**
 * card_expense_rd (AppFrm-021) has no draft state: a save through the form's own flow
 * (budget_check_er popup -> Request/Update) lands the document at the drafter's own
 * approval turn, not in limbo - the groupware itself routes it straight into the approval
 * chain. "Saved successfully" is only true when the document is still sitting at THAT
 * turn; if it has already moved to the next approver, draft_only=true silently became a
 * real submission and the person needs to repossess it.
 *
 * This module decides which of the two happened, from two independently-read signals
 * (never from confirmDraftResult's drafts/progress-folder heuristic, which was built for
 * forms that DO have a draft state and misreads a normal card_expense_rd save as
 * SUBMITTED_NOT_DRAFT):
 *   1. is doc_id present in document_list.php?type=appr ("waiting for my approval" -
 *      confirmed live, 2026-10-12: breadcrumb "Approval >", empty-state text
 *      "document not found.", count matches the account's own "Approval N" counter -
 *      see test/fixtures/card-er-location/waiting-list-empty.txt)?
 *   2. on document_view.php, is there an own pending action, no [Document Repossess]
 *      button, and is the first untimed step in the approval line the drafter's?
 *
 * Both signals true -> AT_DRAFTER_TURN (the save behaved like a draft). Either
 * definitively false -> DRAFT_WENT_TO_APPROVAL (repossess it). Either unreadable ->
 * DRAFT_NOT_CONFIRMED - never report success on an unread signal.
 *
 * NO LIVE POSITIVE FIXTURE EXISTS YET (plan v6.1): doc 301323, which this was meant to
 * capture positively, had already been approved past the drafter by the time this was
 * checked (2026-10-12) - see test/fixtures/card-er-location/document-view-301323-negative.txt.
 * The AT_DRAFTER_TURN branch below is tested against a SYNTHETIC fixture built from that
 * negative one's structure (own action present, no repossess button, first step untimed),
 * not a captured document_view.
 *
 * Only detectSubmittedOnDocumentView is wired into a live save path: the one-time authorized
 * [Draft] save in src/tools/ipk-submit.ts (saveCardExpenseRDDraft) checks the saved
 * document_view with it. The rest is kept as a utility for checking where an existing doc_id
 * sits in the approval chain from a captured document_view page.
 */

export type CardErLocationOutcome = "AT_DRAFTER_TURN" | "DRAFT_WENT_TO_APPROVAL" | "DRAFT_NOT_CONFIRMED";

export interface ApprovalLineSignal {
  /** An action is pending on the drafter's own row (the groupware's own button, whatever
   *  it's labeled - [Approve]/[Sign] - not present on someone else's row). */
  ownActionPending: boolean;
  /** [Document Repossess] is offered - a document only offers this once it has moved
   *  past the drafter, so its presence alone means NOT the drafter's turn. */
  repossessOffered: boolean;
  /** The first step in the approval line with no action timestamp is the drafter's own. */
  firstUntimedStepIsDrafter: boolean;
}

export interface CardErLocationInputs {
  /** doc_id found in document_list.php?type=appr - the account's own "waiting for my
   *  approval" list - or "unreadable" if the list couldn't be fetched/parsed. */
  inWaitingList: boolean | "unreadable";
  /** Approval-line read from document_view.php, or null if it couldn't be read/parsed. */
  approvalLine: ApprovalLineSignal | null;
}

export interface CardErLocationResult {
  outcome: CardErLocationOutcome;
  reason: string;
}

/**
 * Parses the same `[ Sign ]` / role / name / date layout seen on document_view.php's
 * approval line (document.body.innerText - tab-separated cells, same convention as
 * card-er.ts's budgetPopupRefusals operating on popup body text). See
 * test/fixtures/card-er-location/document-view-301323-negative.txt's "Raw extracted
 * text" section for the real layout this was built against.
 *
 * Returns null when the "Approval" block can't be found or the drafter's own name isn't
 * in it - never guesses a signal from a page it couldn't parse.
 */
export function readApprovalLineFromBodyText(bodyText: string, draftedByName: string): ApprovalLineSignal | null {
  const lines = bodyText.split(/\r?\n/);
  const approvalIdx = lines.findIndex((l) => l.trim() === "Approval" || /^Approval\t/.test(l.trim()));
  if (approvalIdx === -1) return null;

  const block: string[] = [];
  for (let i = approvalIdx + 1; i < lines.length && block.length < 6; i++) {
    const raw = lines[i];
    // A row of all-blank cells (nobody has signed yet) still has tabs and must be kept -
    // only a true blank separator line (no tabs at all) is skipped.
    if (raw.trim() === "" && !raw.includes("\t")) continue;
    if (/^(Cosigner|Takeover|Drafter|Cc)\b/.test(raw.trim())) break;
    block.push(raw);
  }
  if (block.length < 2) return null;

  const signRowIdx = block.findIndex((r) => /\[\s*(Sign|Approve)\s*\]/i.test(r));
  const namesRowIdx = block.findIndex((r, idx) => idx !== 0 && idx !== signRowIdx && r.includes(draftedByName));
  if (namesRowIdx === -1) return null;

  const namesRow = block[namesRowIdx].split("\t");
  const draftedCol = namesRow.findIndex((n) => n.trim() === draftedByName);
  if (draftedCol === -1) return null;

  const signRow = signRowIdx >= 0 ? block[signRowIdx].split("\t") : [];
  const ownActionPending = /\[\s*(Sign|Approve)\s*\]/i.test((signRow[draftedCol] || "").trim());

  const datesRow = namesRowIdx + 1 < block.length ? block[namesRowIdx + 1].split("\t") : [];
  const firstUntimedCol = datesRow.findIndex((d) => d.trim() === "");
  const firstUntimedStepIsDrafter = firstUntimedCol !== -1 && firstUntimedCol === draftedCol;

  const repossessOffered = /document\s*repossess|\brepossess\b/i.test(bodyText);

  return { ownActionPending, repossessOffered, firstUntimedStepIsDrafter };
}

/** Live glue: reads document.body.innerText from the form frame currently showing
 *  document_view.php and parses it. null on any read/parse failure - never a guess. */
export async function readApprovalLineFromDocumentView(frame: any, draftedByName: string): Promise<ApprovalLineSignal | null> {
  try {
    const bodyText: string = await frame.evaluate(() => (document.body ? document.body.innerText : ""));
    return readApprovalLineFromBodyText(bodyText, draftedByName);
  } catch {
    return null;
  }
}

/** Live glue: every doc_id linked from the current page (document_list.php?type=appr -
 *  the "waiting for my approval" list). "unreadable" on any read failure. */
export async function readWaitingListDocIds(frame: any): Promise<string[] | "unreadable"> {
  try {
    const ids = await frame.evaluate(() => {
      const out: string[] = [];
      const links = document.querySelectorAll("a[href*='doc_id=']") as NodeListOf<HTMLAnchorElement>;
      for (const link of links) {
        const m = (link.getAttribute("href") || "").match(/doc_id=([^&]+)/);
        if (m) out.push(m[1]);
      }
      return out;
    });
    return Array.isArray(ids) ? ids : "unreadable";
  } catch {
    return "unreadable";
  }
}

export function isDocIdInWaitingList(docIds: string[] | "unreadable", docId: string): boolean | "unreadable" {
  return docIds === "unreadable" ? "unreadable" : docIds.includes(docId);
}

/**
 * Markers on document_view.php that mean the document was FILED for approval, not saved
 * as a draft: the "Approval > Progress" breadcrumb (the person's own in-flight documents)
 * and the [ Document Repossess ] button. Doc 302098 (2026-10-23, test/fixtures/
 * card-er-location/document-view-302098-submitted.rawtext.txt) showed both after a
 * "draft" save, while readApprovalLineFromBodyText could not parse its approval line
 * (the label is printed one letter per line) and the outcome came back as an unread
 * DRAFT_NOT_CONFIRMED. Checked on the raw text before any approval-line parsing.
 */
export function detectSubmittedOnDocumentView(bodyText: string): string[] {
  const found: string[] = [];
  if (/Approval\s*>\s*Progress/.test(bodyText)) found.push("Approval > Progress");
  if (/Document\s+Repossess/i.test(bodyText)) found.push("Document Repossess");
  return found;
}

export function determineCardErLocation(inputs: CardErLocationInputs): CardErLocationResult {
  if (inputs.inWaitingList === "unreadable") {
    return { outcome: "DRAFT_NOT_CONFIRMED", reason: "Could not read the 'waiting for my approval' list (document_list.php?type=appr)." };
  }
  if (inputs.approvalLine === null) {
    return { outcome: "DRAFT_NOT_CONFIRMED", reason: "Could not read the document's approval line." };
  }
  const { ownActionPending, repossessOffered, firstUntimedStepIsDrafter } = inputs.approvalLine;
  if (inputs.inWaitingList && ownActionPending && !repossessOffered && firstUntimedStepIsDrafter) {
    return { outcome: "AT_DRAFTER_TURN", reason: "The document is at the drafter's own approval turn - the save behaved like a draft." };
  }
  const reasons: string[] = [];
  if (!inputs.inWaitingList) reasons.push("doc_id is not in the 'waiting for my approval' list");
  if (!ownActionPending) reasons.push("no pending action on the drafter's own row");
  if (repossessOffered) reasons.push("[Document Repossess] is offered (already past the drafter)");
  if (!firstUntimedStepIsDrafter) reasons.push("the first untimed step in the approval line is not the drafter's");
  return {
    outcome: "DRAFT_WENT_TO_APPROVAL",
    reason: `The document has moved past the drafter's turn: ${reasons.join("; ")}. Use [Document Repossess] to pull it back.`,
  };
}

/**
 * doc_id fallback when it isn't in the post-save URL (card-er.ts handlePopup's finalUrl
 * regex can come back empty): find it in the waiting list by exact subject match and
 * today's date. Returns null (never guesses) on 0 or >1 match.
 */
export function findDocIdBySubjectAndDate(
  waitingList: { docId: string; subject: string; date: string }[],
  subject: string,
  todayIso: string
): string | null {
  const matches = waitingList.filter((d) => d.subject === subject && d.date === todayIso);
  return matches.length === 1 ? matches[0].docId : null;
}
