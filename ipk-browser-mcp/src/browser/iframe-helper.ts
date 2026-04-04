import { Page, Frame } from "playwright";
import { Config, FORM_CODES, FormType } from "../types.js";

/**
 * Helper for iframe-based navigation in IPK groupware.
 * The groupware renders all content inside a "main_menu" iframe.
 */

/** Get the main content frame */
export function getMainFrame(page: Page): Frame | null {
  return page.frame("main_menu");
}

/** Navigate within the main_menu iframe to a form */
export async function navigateToForm(
  page: Page,
  formType: FormType,
  config: Config
): Promise<Frame | null> {
  const formCode = FORM_CODES[formType];
  if (!formCode) return null;

  const url = `${config.baseUrl}/Document/document_write.php?approve_type=${formCode}`;
  const frame = getMainFrame(page);

  if (!frame) return null;

  await frame.goto(url, { timeout: config.navTimeoutMs });
  await frame.waitForLoadState("load");
  // Wait for form elements to be interactive (replaces blanket 1500ms timeout)
  await frame.waitForSelector("form input, form textarea, form select", { timeout: 5000 }).catch(() => null);

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

  // Ensure URL is within the groupware domain
  let fullUrl: string;
  if (url.startsWith("http")) {
    const parsed = new URL(url);
    const base = new URL(config.baseUrl);
    if (parsed.hostname !== base.hostname) {
      throw new Error(`Navigation restricted to groupware domain (${base.hostname}). Rejected: ${parsed.hostname}`);
    }
    fullUrl = url;
  } else {
    fullUrl = `${config.baseUrl}${url.startsWith("/") ? "" : "/"}${url}`;
  }

  await frame.goto(fullUrl, { timeout: config.navTimeoutMs });
  await frame.waitForLoadState("load");

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
  return frame.evaluate(
    (args: { sel: string; val: string }) => {
      const el = document.querySelector(args.sel) as HTMLInputElement | HTMLTextAreaElement | null;
      if (el) {
        el.value = args.val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      return false;
    },
    { sel: selector, val: value }
  );
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
  return frame.evaluate(
    (args: { sel: string; val: string }) => {
      const el = document.querySelector(args.sel) as HTMLSelectElement | null;
      if (el) {
        el.value = args.val;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
      return false;
    },
    { sel: selector, val: value }
  );
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
    return match ? match[1] : null;
  }

  // If still on document_write.php, submission likely failed
  if (frameUrl.includes("document_write.php")) {
    throw new Error("SUBMIT_FAILED: Form submission did not redirect. The form may have validation errors.");
  }

  return null;
}

/**
 * Set common reporter fields (name, date, destination) found in multiple form types.
 * DRY helper for travel_settlement, leave_return, seminar, overseas_travel.
 */
export async function setReporterInfo(
  frame: Frame,
  userInfo: { name: string },
  reportDate: string,
  destination?: string
): Promise<void> {
  // Try multiple selector patterns used across forms
  await setFieldValue(frame, '.validate[name="report_name"]', userInfo.name);
  await setFieldValue(frame, 'input[name="report_name"]', userInfo.name);
  await setFieldValue(frame, '.validate[name="report_date"]', reportDate);
  await setFieldValue(frame, 'input[name="report_date"]', reportDate);
  if (destination) {
    await setFieldValue(frame, '.validate[name="report_dest"]', destination);
    await setFieldValue(frame, 'input[name="report_dest"]', destination);
  }
}
