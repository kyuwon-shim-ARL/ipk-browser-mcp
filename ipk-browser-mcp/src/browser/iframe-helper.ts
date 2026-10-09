import { Page, Frame } from "playwright";
import { audit } from "../internal/audit.js";
import { Config, FORM_CODES, FormType } from "../types.js";

/**
 * Helper for iframe-based navigation in IPK groupware.
 * The groupware renders all content inside a "main_menu" iframe.
 */

/** Get the main content frame */
export function getMainFrame(page: Page): Frame | null {
  return page.frame("main_menu");
}

/** Retry interval for stale frame re-detection */
const FRAME_RETRY_MS = 500;

/**
 * Per-form ready selectors — each form has a distinct field that only appears
 * once the form JS has fully initialised.
 * expense is handled separately (two-step sequential wait).
 */
const FORM_READY_SELECTORS: Partial<Record<FormType, string>> = {
  leave: 'select[name="leave_kind[]"]',
  travel_request: 'input[name="subject"]',
  travel: 'input[name="subject"]',
  seminar: 'input[name="subject"]',
};
const FORM_READY_DEFAULT = 'input[name="subject"]';

function isFrameStale(frameUrl: string): boolean {
  // Only treat genuinely unloaded frames as stale.
  // Note: Playwright reports frame.url() as "<parent>/path" for <frame> elements
  // inside a <frameset> — that is a Playwright reporting quirk, not actual staleness.
  return !frameUrl || frameUrl === "about:blank";
}

/** Navigate to a form using full page navigation to bypass bot detection on frame.goto() */
export async function navigateToForm(
  page: Page,
  formType: FormType,
  config: Config
): Promise<Frame | null> {
  const formCode = FORM_CODES[formType];
  if (!formCode) return null;

  // Use origin to strip any /main.php path that IPK_BASE_URL may include.
  // Use page.goto() instead of frame.goto() — server returns frameset HTML for
  // nested-frame requests (bot detection), causing form fields to be absent.
  const origin = new URL(config.baseUrl).origin;
  const formUrl = `${origin}/Document/document_write.php?approve_type=${formCode}`;

  await page.goto(formUrl, { waitUntil: "domcontentloaded", timeout: config.navTimeoutMs });

  // After page.goto(), use the main frame (not main_menu child frame)
  const frame = page.mainFrame();

  // Wait for form-specific ready selector
  if (formType === "expense") {
    await frame.waitForSelector('input[name="subject"]', { timeout: 8000 });
    await frame.waitForSelector('select[name="account_code"]', { timeout: 8000 }).catch(() => null);
  } else {
    const readySelector = FORM_READY_SELECTORS[formType] ?? FORM_READY_DEFAULT;
    await frame.waitForSelector(readySelector, { timeout: 8000 }).catch(() => null);
  }

  return frame;
}

/** Navigate to an arbitrary URL within the main_menu iframe */
export async function navigateInFrame(
  page: Page,
  url: string,
  config: Config
): Promise<Frame | null> {
  const frame = getMainFrame(page);
  if (!frame) return null;

  // Extract origin to avoid baseUrl including /main.php path
  const origin = new URL(config.baseUrl).origin;

  // Ensure URL is within the groupware domain
  let fullUrl: string;
  if (url.startsWith("http")) {
    const parsed = new URL(url);
    if (parsed.hostname !== new URL(config.baseUrl).hostname) {
      throw new Error(`Navigation restricted to groupware domain (${new URL(config.baseUrl).hostname}). Rejected: ${parsed.hostname}`);
    }
    fullUrl = url;
  } else {
    fullUrl = `${origin}${url.startsWith("/") ? "" : "/"}${url}`;
  }

  await frame.goto(fullUrl, { waitUntil: "domcontentloaded", timeout: config.navTimeoutMs });

  return frame;
}

/**
 * Set a form field value via parameterized evaluate.
 * SECURITY: Never interpolates user data into JS strings.
 */
export async function setFieldValue(
  frame: Frame,
  selector: string,
  value: string
): Promise<boolean> {
  // Wait for the element to exist, not to be visible. Forms here hide fields that are
  // still part of the submitted payload - using_type[] on the leave form is display:none
  // but required - and Playwright's default "visible" state times out on those.
  await frame.waitForSelector(selector, { state: "attached", timeout: 5000 }).catch(() => null);

  // NOTE on readOnly: many fields this form expects to be filled are readOnly by design
  // (begin_date[]/end_date[] are datepicker-backed, item_amount[]/total_amt are recomputed
  // by the form's own JS). Writing those is how the form is meant to be driven, so readOnly
  // is deliberately not treated as a barrier here. `disabled` is different: the browser
  // omits disabled controls from the submitted payload, so writing one produces a value the
  // page shows but the server never receives.
  const outcome = await frame.evaluate(
    (args: { sel: string; val: string }) => {
      const el = document.querySelector(args.sel) as HTMLInputElement | HTMLTextAreaElement | null;
      if (!el) return "not_found" as const;
      if ((el as HTMLInputElement).disabled) return "disabled" as const;
      const hidden = el.getBoundingClientRect().width === 0 && el.getBoundingClientRect().height === 0;
      el.value = args.val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return hidden ? ("ok_hidden" as const) : ("ok" as const);
    },
    { sel: selector, val: value }
  );

  if (outcome === "disabled") {
    audit({ action: "refusal", field: selector, code: "FIELD_DISABLED", ok: false });
    throw new Error(
      `FIELD_DISABLED: '${selector}' is disabled; the browser would not submit a value ` +
        `written to it. Enable it through the form's own controls instead.`
    );
  }
  audit({ action: "field_write", field: selector, value, hidden: outcome === "ok_hidden", ok: outcome !== "not_found" });
  return outcome !== "not_found";
}

/**
 * Set a select element and dispatch change event via parameterized evaluate.
 * SECURITY: Never interpolates user data into JS strings.
 */
export async function setSelectValue(
  frame: Frame,
  selector: string,
  value: string
): Promise<boolean> {
  // See setFieldValue: wait for attachment, not visibility.
  const el = await frame.waitForSelector(selector, { state: "attached", timeout: 5000 }).catch(() => null);
  if (!el) return false;

  const outcome = await frame.evaluate(
    (args: { sel: string; val: string }) => {
      const el = document.querySelector(args.sel) as HTMLSelectElement | null;
      if (!el) return "not_found" as const;
      if (el.disabled) return "disabled" as const;
      // A <select> only accepts what it offers. Assigning anything else leaves the value
      // unchanged and the write silently does nothing - the form then rejects the whole
      // submission with a message about a field the caller never knew failed.
      const offered = Array.from(el.options).map((o) => o.value);
      if (args.val !== "" && !offered.includes(args.val)) {
        return { status: "no_option" as const, offered };
      }
      const hidden = el.getBoundingClientRect().width === 0 && el.getBoundingClientRect().height === 0;
      el.value = args.val;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      const label = el.options[el.selectedIndex]?.text?.trim() || "";
      return { status: hidden ? ("ok_hidden" as const) : ("ok" as const), label };
    },
    { sel: selector, val: value }
  );

  if (outcome === "disabled") {
    audit({ action: "refusal", field: selector, code: "FIELD_DISABLED", ok: false });
    throw new Error(
      `FIELD_DISABLED: '${selector}' is disabled; the browser would not submit a value ` +
        `written to it. Enable it through the form's own controls instead.`
    );
  }
  if (typeof outcome === "object" && outcome.status !== "no_option") {
    audit({
      action: "option_select",
      field: selector,
      value,
      label: outcome.label,
      fromOfferedOptions: true,
      hidden: outcome.status === "ok_hidden",
      ok: true,
    });
    return true;
  }
  if (typeof outcome === "object" && outcome.status === "no_option") {
    audit({ action: "refusal", field: selector, code: "INVALID_OPTION", fromOfferedOptions: false, ok: false });
    throw new Error(
      `INVALID_OPTION: '${value}' is not an option '${selector}' offers. ` +
        `Allowed: ${outcome.offered.filter(Boolean).join(", ") || "(none yet - the form may fill this from another field first)"}`
    );
  }
  audit({ action: "option_select", field: selector, value, fromOfferedOptions: true, ok: outcome !== "not_found" });
  return outcome !== "not_found";
}

/**
 * Set a required form field, throwing if the element is not found.
 * Use this for fields that MUST be filled (e.g. subject, dates).
 */
export async function setRequiredField(
  frame: Frame,
  selector: string,
  value: string,
  fieldName: string
): Promise<void> {
  const ok = await setFieldValue(frame, selector, value);
  if (!ok) {
    throw new Error(`FIELD_NOT_FOUND: Required field '${fieldName}' not found (selector: ${selector})`);
  }
}

/**
 * Set a required select element, throwing if not found.
 */
export async function setRequiredSelect(
  frame: Frame,
  selector: string,
  value: string,
  fieldName: string
): Promise<void> {
  const ok = await setSelectValue(frame, selector, value);
  if (!ok) {
    throw new Error(`FIELD_NOT_FOUND: Required select '${fieldName}' not found (selector: ${selector})`);
  }
}

export interface CascadeStep {
  field: string;           // select element name
  value: string;          // value to set
  waitSelector?: string;  // CSS selector to wait for after AJAX (e.g., "select[name='city'] option:nth-child(2)")
  timeoutMs?: number;     // max wait time, default 3000
  condition?: string;     // optional: only execute if this select has a value set
}

/**
 * Execute a sequence of AJAX-dependent select cascades.
 * Each step: set select value → dispatch change → wait for dependent options to load → verify.
 * Uses selector-based waits instead of fixed timeouts for reliability.
 */
export async function executeAjaxCascade(
  page: Page,
  frame: Frame,
  steps: CascadeStep[]
): Promise<{ completed: number; total: number; errors: string[] }> {
  const errors: string[] = [];
  let completed = 0;

  for (const step of steps) {
    // Check condition: skip if condition field has no value
    if (step.condition) {
      const conditionMet = await frame.evaluate(
        (sel: string) => {
          const el = document.querySelector(`select[name="${sel}"]`) as HTMLSelectElement | null;
          return el ? el.value !== "" && el.value !== "0" : false;
        },
        step.condition
      );
      if (!conditionMet) {
        continue; // Skip this step
      }
    }

    const selector = `select[name="${step.field}"]`;

    // Set the select value
    const ok = await setSelectValue(frame, selector, step.value);
    if (!ok) {
      errors.push(`SELECTOR_NOT_FOUND: select[name="${step.field}"]`);
      continue;
    }

    // Wait for AJAX response using waitSelector or fallback to timeout
    const timeout = step.timeoutMs || 3000;

    if (step.waitSelector) {
      try {
        await frame.waitForSelector(step.waitSelector, { timeout });
      } catch {
        // Retry once
        await page.waitForTimeout(500);
        try {
          await frame.waitForSelector(step.waitSelector, { timeout: timeout / 2 });
        } catch {
          errors.push(`CASCADE_TIMEOUT: ${step.field} → waited for "${step.waitSelector}" (${timeout}ms)`);
          continue;
        }
      }
    } else {
      // Fallback: wait for any new option to appear in the next select
      await page.waitForTimeout(Math.min(timeout, 2000));
    }

    completed++;
  }

  return { completed, total: steps.length, errors };
}

/**
 * Set mode (draft/request) using document.all (legacy IE API used by groupware).
 * SECURITY: Parameterized - only allows 'draft' or 'request'.
 */
export async function setFormMode(
  frame: Frame,
  mode: "draft" | "request"
): Promise<void> {
  await frame.evaluate(
    (m: string) => {
      const el = (document as any).all("mode1");
      if (el) el.value = m;
    },
    mode
  );
  audit({ action: "submit", mode, ok: true });
}

/**
 * Submit form via Check_Form_Request or form1.submit.
 * SECURITY: No user data in JS.
 */
export async function submitForm(
  page: Page,
  frame: Frame,
  method: "check_form_request" | "form_submit" = "check_form_request"
): Promise<string | null> {
  // The form reports validation failures through alert(), which Playwright dismisses
  // automatically - so without this the caller only learns that "something" was wrong and
  // has to go look at the form by hand. Capture the text and put it in the error instead.
  const dialogs: string[] = [];
  const onDialog = (d: import("playwright").Dialog) => {
    dialogs.push(d.message().replace(/\s+/g, " ").trim());
    d.accept().catch(() => {});
  };
  page.on("dialog", onDialog);
  try {
  // Execute the submission
  if (method === "check_form_request") {
    await Promise.all([
      page.waitForNavigation({ timeout: 15000, waitUntil: "load" }).catch(() => null),
      frame.evaluate(() => {
        (window as any).Check_Form_Request("insert");
      }),
    ]);
  } else {
    await Promise.all([
      page.waitForNavigation({ timeout: 20000, waitUntil: "load" }).catch(() => null),
      frame.evaluate(() => {
        (document as any).form1.submit();
      }),
    ]);
  }

  // Wait for redirect to document_view.php
  try {
    await frame.waitForURL('**/document_view.php**', { timeout: 10000 });
  } catch {
    // Fallback: wait for slow redirects
    await page.waitForTimeout(3000);
  }

  // Extract doc_id from URL
  const frameUrl = frame.url();
  if (frameUrl.includes("document_view.php") && frameUrl.includes("doc_id=")) {
    const match = frameUrl.match(/doc_id=([^&]+)/);
    const docId = match ? match[1] : null;
    // Joins this run's field writes to the document they produced, which is what makes a
    // later reconciliation possible: what we wrote vs what the submitted document holds.
    audit({ action: "submit", docId, ok: true });
    return docId;
  }

  // If still on document_write.php, submission likely failed
  if (frameUrl.includes("document_write.php")) {
    throw new Error(
      dialogs.length
        ? `SUBMIT_REJECTED: the form refused the submission - ${dialogs.join(" / ")}`
        : "SUBMIT_FAILED: Form submission did not redirect and the form gave no message."
    );
  }

  // Neither a document view nor the form we started from: the submission went somewhere
  // we cannot verify. Reporting success here would claim a document exists without a
  // document id to show for it.
  throw new Error(
    `SUBMIT_UNVERIFIED: after submitting, the page is at ${frameUrl || "(unknown)"} and no ` +
      `document id came back. The document may or may not have been created - check the ` +
      `drafts list before retrying.` +
      (dialogs.length ? ` The form said: ${dialogs.join(" / ")}` : "")
  );
  } finally {
    page.off("dialog", onDialog);
  }
}

/**
 * Read the live form's own field values, by DOM name - what field-rules.ts checks must
 * see, since checking the MCP call's params would check names the server never typed
 * into the form (form_type, draft_only, confirm_submit, ...) and miss names it did
 * (item_desc[], account_str[], ...) - see ipk-submit.ts checkFieldRulesAgainstForm.
 *
 * Repeating-row names (`name[]`) collect every row's value into an array, in DOM order,
 * so a template/unused row shows up as an empty string rather than being silently merged
 * into the real one; field-rules.ts drops empty entries before checking them. A hidden
 * input is included only when its name is in `knownNames` (the rulebook's own field
 * list) - an unlisted hidden field is plumbing (a CSRF token, a row counter), not
 * something any rulebook was ever going to have an opinion on.
 */
export async function serializeFormFields(
  frame: Frame,
  knownNames: string[]
): Promise<Record<string, string | string[]>> {
  return frame.evaluate((known: string[]) => {
    const knownSet = new Set(known);
    const out: Record<string, string | string[]> = {};
    const els = document.querySelectorAll("input[name], select[name], textarea[name]");
    els.forEach((raw) => {
      const el = raw as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
      if ((el as HTMLInputElement).disabled) return;
      const name = el.name;
      if (!name) return;
      const type = (el as HTMLInputElement).type;
      if (type === "hidden" && !knownSet.has(name)) return;
      if ((type === "checkbox" || type === "radio") && !(el as HTMLInputElement).checked) return;
      const value = el.value;
      if (name.endsWith("[]")) {
        (out[name] as string[] | undefined) ??= [];
        (out[name] as string[]).push(value);
      } else {
        out[name] = value;
      }
    });
    return out;
  }, knownNames);
}

/**
 * Save a domestic travel report (travel_report_write.php) as a draft. Confirmed live
 * (2026-10-09): the page's only save control is `[ Draft ]` -> `Check_Form('D')` - no
 * final-submit button was present. Unlike submitForm's Check_Form_Request/form1.submit
 * paths, this doesn't create a new document (it writes onto the already-approved
 * AppFrm-023 request) and does not redirect to document_view.php, so there is no new
 * doc_id to extract here - the caller confirms persistence by re-reading the fields
 * (see src/forms/travel-report.ts's doc comment and src/tools/ipk-submit.ts
 * submitTravel's domestic branch).
 */
export async function submitTravelReportDraft(page: Page, frame: Frame): Promise<{ dialogs: string[] }> {
  const dialogs: string[] = [];
  const onDialog = (d: import("playwright").Dialog) => {
    dialogs.push(d.message().replace(/\s+/g, " ").trim());
    d.accept().catch(() => {});
  };
  page.on("dialog", onDialog);
  try {
    await frame.evaluate(() => {
      (window as any).Check_Form("D");
    });
    await page.waitForTimeout(1500);
  } finally {
    page.off("dialog", onDialog);
  }
  return { dialogs };
}

