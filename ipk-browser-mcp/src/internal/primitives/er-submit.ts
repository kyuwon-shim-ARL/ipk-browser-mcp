import type { Page } from "playwright";

/**
 * 2-stage submit primitive for IPK groupware ER forms (AppFrm-021 and similar).
 *
 * The R&D Expense Request form's [Draft] / [Request] anchor has the handler:
 *   `document.all('mode1').value='draft'; Check_Form_Request('insert')`
 *
 * Check_Form_Request runs validation and then shows a jQuery-confirm modal:
 *
 *   "Notice! Evidence Check!"
 *     - Card receipt or Tax invoice (카드 영수증 또는 세금계산서)
 *     - Transaction statement(signed) (거래명세서-서명필수)
 *     [Next] [Cancel]
 *
 * The Next button's handler retargets the form to a popup `budget_frame` and
 * submits to `./budget_check_er.php`. That popup shows the budget impact
 * summary and exposes a `[Request]` link calling `submit_form()`, which
 * re-targets the parent form back to `./document_write.php` and submits.
 *
 * On successful save, the parent navigates to:
 *   document_view.php?doc_id={id}&approve_type=AppFrm-021&type=drafts
 *
 * This primitive bypasses the Evidence Check modal (which we cannot interact
 * with via Playwright dialog API since it's HTML, not native) and orchestrates
 * the whole flow programmatically.
 *
 * Requires `Page` (not FrameLike) because it uses:
 *   - `page.once("popup", ...)` to capture the budget_frame popup
 *   - `page.waitForLoadState(...)` to wait for the save navigation
 *   - `page.url()` to extract the final doc_id
 *
 * Discovered: 2026-04-07 session probe (Google Cloud / RunPod ER drafts).
 */

export interface SubmitERResult {
  success: boolean;
  docId: string | null;
  finalUrl: string;
  budgetCheckBody?: string;
  error?: string;
}

export interface SubmitERMode {
  /** "draft" saves as draft, "request" submits for approval. Default "draft". */
  mode?: "draft" | "request";
  /** Wait for budget_check popup (ms). Default 8000. */
  popupTimeoutMs?: number;
  /** Wait after submit_form() in popup (ms). Default 5000. */
  saveTimeoutMs?: number;
}

/**
 * Submit an ER form (AppFrm-021) via the 2-stage budget_check_er flow.
 * The form should already be filled (subject, item rows, account code,
 * attachments) before calling this.
 */
export async function submitERWithBudgetCheck(
  page: Page,
  opts: SubmitERMode = {}
): Promise<SubmitERResult> {
  const mode = opts.mode ?? "draft";
  const popupTimeout = opts.popupTimeoutMs ?? 8000;
  const saveTimeout = opts.saveTimeoutMs ?? 5000;

  // Set up popup capture and call submit_form() in the budget_check popup
  const popupHolder: { url: string | null; body: string | null } = {
    url: null,
    body: null,
  };

  const popupPromise = new Promise<void>((resolve) => {
    page.once("popup", async (pop) => {
      try {
        await pop.waitForLoadState("networkidle", { timeout: popupTimeout });
        await pop.waitForTimeout(1500);
        popupHolder.url = pop.url();
        popupHolder.body = (await pop.evaluate(
          "document.body.innerText.slice(0, 2000)"
        )) as string;
        // submit_form() in popup retargets parent and submits → save
        await pop.evaluate("submit_form()").catch(() => {});
        await pop.waitForTimeout(saveTimeout);
      } catch {
        // popup may close mid-evaluation; the parent navigation is what matters
      } finally {
        resolve();
      }
    });
    // Safety timeout
    setTimeout(resolve, popupTimeout + saveTimeout + 5000);
  });

  // Trigger the 2-stage submit, replicating the modal Next handler
  // (sets mode1, opens budget_frame, posts to budget_check_er.php)
  try {
    await page.evaluate(
      ({ mode1Val }) => {
        const w = window as any;
        const doc = document as any;
        if (doc.all && doc.all("mode1")) doc.all("mode1").value = mode1Val;
        const form = (doc as any).form1 as HTMLFormElement;
        if (!form) throw new Error("form1 not found");
        (form as any).mode.value = "insert";
        w.open(
          "",
          "budget_frame",
          "width=940,height=400,top=100,left=100,resizable=0,scrollbars=1"
        );
        (form as any).target = "budget_frame";
        (form as any).action = "./budget_check_er.php";
        form.submit();
      },
      { mode1Val: mode === "draft" ? "draft" : "" }
    );
  } catch (err) {
    return {
      success: false,
      docId: null,
      finalUrl: page.url(),
      error: `submit trigger failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  await popupPromise;
  // Wait for parent navigation to document_view.php
  try {
    await page.waitForLoadState("networkidle", { timeout: 15000 });
  } catch {
    // navigation may have already settled
  }

  const finalUrl = page.url();
  const m = finalUrl.match(/[?&]doc_id=(\d+)/);
  const docId = m ? m[1] : null;

  return {
    success: docId !== null,
    docId,
    finalUrl,
    budgetCheckBody: popupHolder.body ?? undefined,
  };
}
