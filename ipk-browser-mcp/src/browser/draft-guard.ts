/**
 * Post-condition for "draft" saves: a result may only call itself a draft once the
 * document is actually in the Drafts list.
 *
 * Why: on 2026-10-08 a card ER (doc 301323) asked for as a draft was filed for approval,
 * and the tool said "draft saved" because a doc_id appeared in the URL - which was
 * type=progress. A doc_id proves a document exists, not where it went.
 *
 * Parsing (listHasDoc / classifyDocLocation / applyDraftGuard) is pure; locateDocument
 * is the only part that navigates.
 */
import { audit } from "../internal/audit.js";
import { textResult } from "../util.js";

export type DocLocation = "drafts" | "progress" | "neither";

/** Whether a document list page links to docId (href or onclick, quoted or not). */
export function listHasDoc(html: string, docId: string): boolean {
  if (!/^\d+$/.test(String(docId))) return false;
  return new RegExp(`doc_id=['"]?${docId}(?!\\d)`).test(html);
}

export function classifyDocLocation(inDrafts: boolean, inProgress: boolean): DocLocation {
  if (inDrafts) return "drafts";
  if (inProgress) return "progress";
  return "neither";
}

/** The result payload a handler's draft result becomes once its location is known. */
export function applyDraftGuard(
  payload: Record<string, any>,
  docId: string,
  location: DocLocation,
  reason?: string
): Record<string, any> {
  const data = payload.data ?? {};
  if (location === "drafts") {
    return {
      ...payload,
      data: { ...data, draft_confirmed: true, message: `${data.message ?? "Draft saved"} - confirmed in Drafts` },
    };
  }
  if (location === "progress") {
    return {
      error: true,
      code: "SUBMITTED_NOT_DRAFT",
      message:
        `Document ${docId} was SUBMITTED for approval, not saved as a draft. Repossess it from the ` +
        `document view ([ Document Repossess ]) before an approver acts.`,
      docId,
      data: { ...data, draft_confirmed: false },
    };
  }
  return {
    error: true,
    code: "DRAFT_NOT_CONFIRMED",
    message:
      `Document ${docId} was not found in Drafts or In Progress (first page of each)` +
      `${reason ? ` - ${reason}` : ""}. It may or may not have been saved, or it may have been ` +
      `submitted - check the document lists before retrying.`,
    docId,
    data: { ...data, draft_confirmed: false },
  };
}

/** Look for docId on the first page of the Drafts list, then In Progress. */
export async function locateDocument(
  page: any,
  baseUrl: string,
  docId: string,
  timeoutMs = 30000
): Promise<{ location: DocLocation; reason?: string }> {
  const origin = new URL(baseUrl).origin;
  const listHtml = async (type: string): Promise<string> => {
    await page.goto(`${origin}/Document/document_list.php?type=${type}`, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForTimeout(1000);
    return String(await page.content());
  };
  try {
    const inDrafts = listHasDoc(await listHtml("drafts"), docId);
    const inProgress = inDrafts ? false : listHasDoc(await listHtml("progress"), docId);
    return { location: classifyDocLocation(inDrafts, inProgress) };
  } catch (err) {
    return { location: "neither", reason: `the lists could not be read: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    // Leave the frameset loaded, as ipk_fetch_approvals does, for tools that expect main_menu.
    await page.goto(origin, { waitUntil: "domcontentloaded", timeout: timeoutMs }).catch(() => null);
  }
}

/**
 * Run the post-condition on a handler's MCP result. Only a draft request whose result
 * carries a docId is checked; everything else passes through untouched.
 */
export async function confirmDraftResult(
  page: any,
  baseUrl: string,
  mode: "draft" | "request",
  result: any,
  timeoutMs?: number
): Promise<any> {
  if (mode !== "draft") return result;
  let payload: Record<string, any>;
  try {
    payload = JSON.parse(result?.content?.[0]?.text ?? "");
  } catch {
    return result;
  }
  const docId = payload?.data?.docId;
  if (payload.error || !docId) return result;

  const { location, reason } = await locateDocument(page, baseUrl, String(docId), timeoutMs);
  if (location !== "drafts") {
    audit({ action: "refusal", code: location === "progress" ? "SUBMITTED_NOT_DRAFT" : "DRAFT_NOT_CONFIRMED", docId: String(docId), mode, ok: false });
  }
  return textResult(applyDraftGuard(payload, String(docId), location, reason));
}
