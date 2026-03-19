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
  await frame.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);

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
  await frame.waitForLoadState("networkidle");

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
  try {
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

    // Try to wait for redirect to document_view.php
    try {
      await frame.waitForURL('**/document_view.php**', { timeout: 10000 });
    } catch {
      // Fallback: wait a bit for slow redirects
      await page.waitForTimeout(3000);
    }

    // Extract doc_id from URL
    const frameUrl = frame.url();
    if (frameUrl.includes("document_view.php") && frameUrl.includes("doc_id=")) {
      const match = frameUrl.match(/doc_id=([^&]+)/);
      return match ? match[1] : null;
    }

    return null;
  } catch {
    // Try to wait for redirect to document_view.php
    try {
      await frame.waitForURL('**/document_view.php**', { timeout: 10000 });
    } catch {
      // Fallback: wait a bit for slow redirects
      await page.waitForTimeout(3000);
    }
    const frameUrl = frame.url();
    if (frameUrl.includes("doc_id=")) {
      const match = frameUrl.match(/doc_id=([^&]+)/);
      return match ? match[1] : null;
    }
    return null;
  }
}
