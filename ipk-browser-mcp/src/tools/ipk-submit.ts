import { z } from "zod";
import * as fs from "fs";
import { SessionManager } from "../browser/session.js";
import { textResult } from "../util.js";
import {
  navigateToForm,
  setFieldValue,
  setSelectValue,
  setRequiredField,
  setRequiredSelect,
  setFormMode,
  submitForm,
  executeAjaxCascade,
} from "../browser/iframe-helper.js";
import type { CascadeStep } from "../browser/iframe-helper.js";
import {
  Config,
  FormType,
  LEAVE_TYPES,
  LEAVE_NAMES,
  ATTACHMENT_REQUIRED_LEAVES,
  BUDGET_TRANSFER_CODES,
} from "../types.js";
import * as path from "path";

// ─── Template-driven generic form filler ───────────────────────────────────

/** Field schema entry from a template JSON */
interface TemplateFieldSchema {
  type: string;
  dom_name: string | null;
  dom_type?: string;
  required?: boolean;
  /** Explicit CSS selector override — used instead of auto-generating from dom_name */
  dom_selector?: string;
  /** Multiple fallback selectors — tried in order (for fields with variant DOM names) */
  dom_selectors?: string[];
  [key: string]: any;
}

/** Hook definition for pre/post fill or evaluate actions */
interface FillHook {
  trigger: "pre_fill" | "post_fill" | "evaluate";
  /** JavaScript function body to execute via frame.evaluate(). Receives `userData` as argument. */
  fn: (frame: any, page: any, userData: Record<string, any>) => Promise<void>;
}

/**
 * Generic form filler that iterates a template's field_schema and sets DOM values
 * based on dom_name. Skips fields where dom_name is null (derived/computed).
 *
 * @param frame  - The Playwright Frame for the form
 * @param fieldSchema - template.field_schema object
 * @param userData - Map of field keys → user-supplied values
 * @param hooks - Optional hooks for pre/post fill or complex evaluate logic
 */
async function genericFillForm(
  frame: any,
  fieldSchema: Record<string, TemplateFieldSchema>,
  userData: Record<string, any>,
  hooks?: FillHook[]
): Promise<void> {
  // Execute pre_fill hooks
  if (hooks) {
    for (const hook of hooks) {
      if (hook.trigger === "pre_fill") await hook.fn(frame, null, userData);
    }
  }

  for (const [fieldKey, schema] of Object.entries(fieldSchema)) {
    // Skip fields with no DOM mapping
    if (!schema.dom_name) continue;

    // Skip if no user data for this field
    const value = userData[fieldKey];
    if (value === undefined || value === null || value === "") continue;

    const strValue = String(value);
    const domName = schema.dom_name;
    const fieldType = schema.type;

    // Handle multi-selector fallback (dom_selectors) — try each in order
    if (schema.dom_selectors) {
      for (const sel of schema.dom_selectors) {
        if (fieldType === "select") {
          await setSelectValue(frame, sel, strValue);
        } else {
          await setFieldValue(frame, sel, strValue);
        }
      }
      continue;
    }

    // Build selector: explicit dom_selector override OR auto-generate from dom_name
    if (fieldType === "select") {
      const selector = schema.dom_selector || `select[name="${domName}"]`;
      if (schema.required) {
        await setRequiredSelect(frame, selector, strValue, (domName || fieldKey).replace(/\[\]/g, ""));
      } else {
        await setSelectValue(frame, selector, strValue);
      }
    } else if (fieldType === "radio") {
      // Radio buttons handled via hooks — skip in generic fill
      continue;
    } else if (fieldType === "array" || fieldType === "table") {
      // Complex types handled via hooks — skip in generic fill
      continue;
    } else if (fieldType === "hidden") {
      const selector = schema.dom_selector || `input[name="${domName}"]`;
      await setFieldValue(frame, selector, strValue);
    } else {
      // text, date, time, number, integer, textarea
      const selector = schema.dom_selector || `input[name="${domName}"], textarea[name="${domName}"]`;
      if (schema.required) {
        await setRequiredField(frame, selector, strValue, (domName || fieldKey).replace(/\[\]/g, ""));
      } else {
        await setFieldValue(frame, selector, strValue);
      }
    }
  }

  // Execute post_fill hooks
  if (hooks) {
    for (const hook of hooks) {
      if (hook.trigger === "post_fill") await hook.fn(frame, null, userData);
    }
  }

  // Execute evaluate hooks
  if (hooks) {
    for (const hook of hooks) {
      if (hook.trigger === "evaluate") await hook.fn(frame, null, userData);
    }
  }
}

// ─── End generic form filler ────────────────────────────────────────────────

/** Allowed directories for attachment file uploads. Prevents arbitrary file reads. */
const ALLOWED_ATTACHMENT_DIRS = [
  "/tmp",
  `${process.env.HOME}/Downloads`,
  `${process.env.HOME}/Documents`,
  `${process.env.HOME}/Desktop`,
];

/** Validate that an attachment path is safe to upload. */
function validateAttachmentPath(filePath: string): string | null {
  // Block path traversal before resolving
  if (filePath.includes("..")) {
    return "Attachment path contains path traversal (..)";
  }
  // Resolve symlinks to get the real filesystem path (security: prevents symlink-to-sensitive-file attacks)
  let resolved: string;
  try {
    resolved = fs.realpathSync(filePath);
  } catch {
    return `Attachment path does not exist or is not accessible: ${filePath}`;
  }
  // Block dotfiles and sensitive directories
  if (/\/\./.test(resolved)) {
    return "Attachment path points to a hidden file/directory";
  }
  // Block system directories
  if (resolved.startsWith("/etc") || resolved.startsWith("/proc") || resolved.startsWith("/sys")) {
    return "Attachment path points to a system directory";
  }
  // Must be in an allowed directory (checked against real path, not symlink path)
  const inAllowed = ALLOWED_ATTACHMENT_DIRS.some((dir) => resolved.startsWith(dir));
  if (!inAllowed) {
    return `Attachment must be in one of: ${ALLOWED_ATTACHMENT_DIRS.join(", ")}`;
  }
  return null;
}

export const ipkSubmitFormSchema = {
  form_type: z.enum([
    "leave", "expense", "working", "travel", "travel_request", "budget_transfer",
    // Wave 2 form types
    "travel_settlement", "leave_return", "card_expense", "seminar", "overseas_travel",
  ]).describe("Form type to submit"),
  draft_only: z.boolean().default(true).describe("Save as draft (true) or submit for approval (false). Defaults to true for safety."),
  confirm_submit: z.boolean().default(false).describe("Must be true to actually submit for approval. Ignored when draft_only=true."),

  // Leave fields
  leave_type: z.string().optional().describe("Leave type: annual, compensatory, sick, paternity, etc."),
  start_date: z.string().optional().describe("Start date (YYYY-MM-DD)"),
  end_date: z.string().optional().describe("End date (YYYY-MM-DD)"),
  start_time: z.string().optional().describe("Start hour for hourly leave (e.g. '14')"),
  end_time: z.string().optional().describe("End hour for hourly leave (e.g. '17')"),
  purpose: z.string().optional().describe("Purpose/reason"),
  destination: z.string().optional().describe("Destination"),
  substitute_name: z.string().optional().describe("Substitute person name"),

  // Expense fields
  amount: z.number().optional().describe("Total amount in KRW"),
  participants: z.string().optional().describe("Participants for meal expense"),
  venue: z.string().optional().describe("Venue for expense"),
  budget_code: z.string().optional().describe("Budget code (required for expense/working/travel_request forms). Use the active fiscal year code, e.g. NN2612-0001."),
  attachment_path: z.string().optional().describe("Path to attachment file"),

  // Working fields
  work_date: z.string().optional().describe("Work date (YYYY-MM-DD)"),
  work_place: z.string().optional().describe("Work place"),
  reason: z.string().optional().describe("Reason for work/travel"),
  details: z.string().optional().describe("Details"),
  budget_type: z.string().optional().describe("Budget type: 01=General, 02=R&D"),

  // Travel fields
  title: z.string().optional().describe("Travel title"),
  organization: z.string().optional().describe("Organization/institution"),
  attendees: z.string().optional().describe("Attendees"),
  schedule: z.string().optional().describe("Schedule details"),

  // Budget transfer fields
  from_budget_code: z.string().optional().describe("Source budget code to transfer FROM"),
  to_budget_code: z.string().optional().describe("Destination budget code to transfer TO"),
  transfer_amount: z.number().optional().describe("Amount to transfer in KRW"),
  transfer_type: z.enum(["rnd", "general"]).default("rnd").describe("Budget transfer type: rnd (R&D, AppFrm-039) or general (AppFrm-053)"),

  // Card expense fields (AppFrm-020)
  item_date: z.string().optional().describe("Date of purchase (YYYY-MM-DD)"),
  item_account_code: z.string().optional().describe("Account code: 420421=Team activities, 420420=External meeting, 420374=Commission, 420375=Registration"),
  item_description: z.string().optional().describe("Expense description (e.g. 'Team activities')"),
  item_vendor: z.string().optional().describe("Vendor/store name"),
  item_control_no: z.string().optional().describe("Card receipt control number"),
  purpose_minutes: z.string().optional().describe("Meeting purpose and minutes"),

  // Travel settlement fields (AppFrm-054)
  province: z.string().optional().describe("Province select value for AJAX cascade"),
  city: z.string().optional().describe("City select value for AJAX cascade"),
  transport_mode: z.string().optional().describe("Transport mode: 'Other Public Transporation', 'Own Vehicle - Gasoline', 'Own Vehicle - Diesel'"),
  budget_control_no: z.string().optional().describe("Budget control number (BC-XXXX-XXXX)"),
  purpose_category: z.string().optional().describe("Purpose category for travel settlement"),
  daily_expense: z.number().optional().describe("Daily expense amount in KRW"),
  transport_fee: z.number().optional().describe("Transport fee in KRW"),
  accommodation: z.number().optional().describe("Accommodation fee in KRW"),
  food_expense: z.number().optional().describe("Food expense in KRW"),
  approved_doc_ref: z.string().optional().describe("Document number of the approved travel request"),
  oil_price: z.number().optional().describe("Oil price per liter (own vehicle)"),
  distance_km: z.number().optional().describe("Distance in km (own vehicle)"),
  toll_fee: z.number().optional().describe("Toll fee in KRW (own vehicle)"),

  // Leave return fields (AppFrm-028)
  original_leave_doc: z.string().optional().describe("Document number of original leave (e.g. ARL-260121-02)"),
  return_days: z.number().optional().describe("Number of days to return"),
  return_hours: z.number().optional().describe("Number of hours to return"),
  description: z.string().optional().describe("Reason for leave return"),

  // Seminar fields (AppFrm-043)
  disclosure_purpose: z.string().optional().describe("Why the material is being disclosed"),
  disclosure_date: z.string().optional().describe("Date of seminar/event (YYYY-MM-DD)"),
  material_description: z.string().optional().describe("Material filename and size"),
  conference_or_journal: z.string().optional().describe("Name of conference or journal"),
  patent_filed: z.enum(["Y", "N", ""]).optional().describe("Q1: Patent filed?"),
  patent_planned: z.enum(["Y", "N", ""]).optional().describe("Q2: Patent planned within a year?"),
  material_published: z.enum(["Y", "N", ""]).optional().describe("Q3: Material published?"),
  collaborator_approval: z.enum(["Y", ""]).optional().describe("Q4: Collaborator approval obtained?"),
  contains_confidential: z.enum(["N", ""]).optional().describe("Q5: Contains IPK confidential info?"),

  // Overseas travel fields (AppFrm-026)
  country: z.string().optional().describe("Destination country and city"),
  conference_name: z.string().optional().describe("Conference or organization name"),
  travel_start: z.string().optional().describe("Departure date (YYYY-MM-DD)"),
  travel_end: z.string().optional().describe("Return date (YYYY-MM-DD)"),
  payment_date: z.string().optional().describe("Settlement payment date (YYYY-MM-DD)"),
  schedule_rows: z.array(z.object({
    from: z.string(), to: z.string(), schedule: z.string(), transportation: z.string(),
  })).optional().describe("Daily itinerary rows"),
  daily_expense_budget: z.number().optional().describe("Daily allowance budget (KRW)"),
  daily_expense_cash: z.number().optional().describe("Daily allowance cash amount (KRW)"),
  food_expense_budget: z.number().optional().describe("Food expense budget (KRW)"),
  food_expense_cash: z.number().optional().describe("Food expense cash amount (KRW)"),
  transport_fee_budget: z.number().optional().describe("Transport fee budget (KRW)"),
  transport_fee_corp_card: z.number().optional().describe("Transport fee paid by corp card (KRW)"),
  accommodation_budget: z.number().optional().describe("Accommodation budget (KRW)"),
  accommodation_corp_card: z.number().optional().describe("Accommodation paid by corp card (KRW)"),
  settle_amount: z.number().optional().describe("Total settlement amount (KRW)"),
  reimbursement: z.number().optional().describe("Amount to reimburse traveler (KRW)"),
  corp_card_no: z.string().optional().describe("Corporate card number (XXXX-XXXX-XXXX-XXXX)"),
};

export const ipkSubmitFormDescription =
  "Submit a form in IPK groupware. All 11 form types are fully implemented: " +
  "leave (휴가/AppFrm-073), expense (경비/AppFrm-020), working (휴일근무/AppFrm-027), travel (출장보고/AppFrm-076), travel_request (출장신청/AppFrm-023), budget_transfer (예산전용/AppFrm-039), " +
  "card_expense (카드경비/AppFrm-020), travel_settlement (출장정산/AppFrm-054), leave_return (대체휴일반납/AppFrm-028), seminar (세미나공시/AppFrm-043), overseas_travel (해외출장/AppFrm-026). " +
  "By default saves as draft (draft_only=true). To actually submit for approval, set draft_only=false AND confirm_submit=true. " +
  "For budget_transfer, use transfer_type='rnd' (AppFrm-039, default) or transfer_type='general' (AppFrm-053).";

export async function handleIpkSubmitForm(
  sessionManager: SessionManager,
  config: Config,
  params: Record<string, any>
) {
  if (!sessionManager.isLoggedIn()) {
    return textResult({ error: true, code: "NOT_LOGGED_IN", message: "Call ipk_login first" });
  }

  const page = sessionManager.getPage()!;
  const formType = params.form_type as FormType;

  // Safety check: require explicit confirmation for actual submission
  if (!params.draft_only && !params.confirm_submit) {
    return textResult({
      error: true,
      code: "CONFIRMATION_REQUIRED",
      message: "To submit for approval, set both draft_only=false AND confirm_submit=true",
    });
  }

  // Validate attachment path if provided
  if (params.attachment_path) {
    const attachErr = validateAttachmentPath(params.attachment_path);
    if (attachErr) {
      return textResult({ error: true, code: "INVALID_ATTACHMENT", message: attachErr });
    }
  }

  const mode = params.draft_only !== false ? "draft" : "request";

  // Session expiry guard: warn if <5 min remaining before starting form fill
  const remainingMs = sessionManager.getSessionRemainingMs();
  if (remainingMs < 5 * 60 * 1000) {
    return textResult({
      error: true,
      code: "SESSION_EXPIRING",
      message: `Session expires in ${Math.floor(remainingMs / 1000)}s. Call ipk_login to refresh before submitting forms.`,
    });
  }

  try {
    // budget_transfer has two variants (rnd/general), so navigate directly instead of using navigateToForm
    if (formType === "budget_transfer") {
      const btCode = BUDGET_TRANSFER_CODES[params.transfer_type || "rnd"] || BUDGET_TRANSFER_CODES.rnd;
      const btUrl = `${config.baseUrl}/Document/document_write.php?approve_type=${btCode}`;
      const mainFrame = page.frame("main_menu");
      if (!mainFrame) {
        return textResult({ error: true, code: "FRAME_NOT_FOUND", message: "main_menu frame not found" });
      }
      await mainFrame.goto(btUrl, { timeout: config.navTimeoutMs });
      await mainFrame.waitForLoadState("load");
      await mainFrame.waitForSelector("form input, form select", { timeout: 5000 }).catch(() => null);
      sessionManager.touchActivity();
      await page.waitForTimeout(1500);
      return await submitBudgetTransfer(page, mainFrame, sessionManager, config, params, mode);
    }

    const frame = await navigateToForm(page, formType, config);
    if (!frame) {
      return textResult({ error: true, code: "NAVIGATION_FAILED", message: "Failed to navigate to form" });
    }
    sessionManager.touchActivity();

    switch (formType) {
      case "leave":
        return await submitLeave(page, frame, sessionManager, config, params, mode);
      case "expense":
        return await submitExpense(page, frame, sessionManager, config, params, mode);
      case "working":
        return await submitWorking(page, frame, sessionManager, config, params, mode);
      case "travel":
        return await submitTravel(page, frame, sessionManager, config, params, mode);
      case "travel_request":
        return await submitTravelRequest(page, frame, sessionManager, config, params, mode);
      case "card_expense":
        return await submitCardExpense(page, frame, sessionManager, config, params, mode);
      case "travel_settlement":
        return await submitTravelSettlement(page, frame, sessionManager, config, params, mode);
      case "leave_return":
        return await submitLeaveReturn(page, frame, sessionManager, config, params, mode);
      case "seminar":
        return await submitSeminar(page, frame, sessionManager, config, params, mode);
      case "overseas_travel":
        return await submitOverseasTravel(page, frame, sessionManager, config, params, mode);
      default:
        return textResult({ error: true, code: "UNKNOWN_FORM", message: `Unknown form type: ${formType}` });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return textResult({ error: true, code: "SUBMIT_ERROR", message: msg });
  }
}

async function submitLeave(
  page: any,
  frame: any,
  sessionManager: SessionManager,
  config: Config,
  params: Record<string, any>,
  mode: "draft" | "request"
) {
  const userInfo = sessionManager.getUserInfo()!;
  const leaveType = params.leave_type || "annual";
  const leaveCode = LEAVE_TYPES[leaveType] || "01";
  const startDate = params.start_date || tomorrow();
  const endDate = params.end_date || startDate;
  const purpose = params.purpose || "personal";
  const destination = params.destination || "Seoul";
  const substituteName = params.substitute_name || process.env.IPK_SUBSTITUTE_NAME || "N/A";

  const isHourly = params.start_time && params.end_time;
  const usingType = isHourly ? "04" : "01";
  const leaveName = LEAVE_NAMES[leaveType] || "Annual leave";

  let subject: string;
  if (isHourly) {
    subject = `${leaveName}, ${startDate} ${params.start_time}:00~${params.end_time}:00, ${destination}, ${userInfo.name}`;
  } else {
    subject = `${leaveName}, ${startDate}~${endDate}, ${destination}, ${userInfo.name}`;
  }

  // Warnings
  const warnings: string[] = [];
  if (leaveCode in ATTACHMENT_REQUIRED_LEAVES) {
    warnings.push(`${leaveName} requires attachment (${ATTACHMENT_REQUIRED_LEAVES[leaveCode]}). Add it manually after draft save.`);
  }
  if (substituteName === "N/A") {
    warnings.push("Substitute person not configured. Set IPK_SUBSTITUTE_NAME env var or pass substitute_name parameter.");
  }

  // Use genericFillForm for standard fields
  const fieldSchema: Record<string, TemplateFieldSchema> = {
    leave_kind: { type: "select", dom_name: "leave_kind[]", required: true },
    using_type: { type: "select", dom_name: "using_type[]", required: true },
    begin_date: { type: "date", dom_name: "begin_date[]", required: true },
    end_date: { type: "date", dom_name: "end_date[]", required: true },
    purpose: { type: "text", dom_name: "purpose", required: false },
    destination: { type: "text", dom_name: "destination", required: false },
    emergency_address: { type: "text", dom_name: "emergency_address", required: false },
    emergency_telephone: { type: "text", dom_name: "emergency_telephone", required: false },
  };

  await genericFillForm(frame, fieldSchema, {
    leave_kind: leaveCode,
    using_type: usingType,
    begin_date: startDate,
    end_date: endDate,
    purpose,
    destination,
    emergency_address: process.env.IPK_EMERGENCY_ADDRESS || "Seoul",
    emergency_telephone: process.env.IPK_EMERGENCY_TELEPHONE || "N/A",
  });

  // Hourly leave: set time dropdowns via evaluate (not in generic schema — custom DOM manipulation)
  if (isHourly) {
    await frame.evaluate(
      (st: string) => {
        const startEl = document.querySelector('select[name="start_time[]"]') as HTMLSelectElement;
        if (startEl && st) {
          const opt = document.createElement("option");
          opt.value = st;
          opt.textContent = st;
          startEl.textContent = "";
          startEl.appendChild(opt);
          startEl.value = st;
          startEl.dispatchEvent(new Event("change", { bubbles: true }));
        }
      },
      params.start_time
    );
    await page.waitForTimeout(500);

    await frame.evaluate(
      (et: string) => {
        const endEl = document.querySelector('select[name="end_time[]"]') as HTMLSelectElement;
        if (endEl && et) {
          const opt = document.createElement("option");
          opt.value = et;
          opt.textContent = et;
          endEl.textContent = "";
          endEl.appendChild(opt);
          endEl.value = et;
          endEl.dispatchEvent(new Event("change", { bubbles: true }));
        }
      },
      params.end_time
    );
    await page.waitForTimeout(500);
  }

  // Set subject last to avoid being overwritten by change events
  await setRequiredField(frame, 'input[name="subject"]', subject, "subject");

  // Handle substitute selection via popup
  try {
    const [popup] = await Promise.all([
      page.waitForEvent("popup", { timeout: 10000 }),
      frame.evaluate(() => {
        (window as any).fnWinOpen("./user_select.php?sel_type=radio");
      }),
    ]);

    await popup.waitForLoadState("load");
    await popup.waitForSelector("tr", { timeout: 5000 }).catch(() => null);
    await popup.waitForTimeout(1000);

    // Select substitute by name - PARAMETERIZED
    const selected = await popup.evaluate(
      (name: string) => {
        const rows = document.querySelectorAll("tr");
        for (const row of rows) {
          const cells = row.querySelectorAll("td");
          if (cells.length >= 4) {
            const userName = cells[3]?.textContent?.trim() || "";
            if (userName === name) {
              const radio = row.querySelector('input[type="radio"]') as HTMLInputElement;
              if (radio) {
                radio.click();
                return { found: true, name: userName };
              }
            }
          }
        }
        return { found: false };
      },
      substituteName
    );

    if (selected.found) {
      await popup.click('a:has-text("[Ok]")');
      await page.waitForTimeout(1000);
    } else {
      await popup.click('a:has-text("[Close]")');
      // Fallback: directly set substitute fields
      await setFallbackSubstitute(frame, substituteName);
    }
  } catch {
    // Fallback: directly set substitute fields
    await setFallbackSubstitute(frame, substituteName);
  }

  // Handle attachment if provided
  if (params.attachment_path) {
    const fileInput = frame.locator('input[name="doc_attach_file[]"]').first();
    await fileInput.setInputFiles(params.attachment_path);
    await page.waitForTimeout(1000);
  }

  await page.waitForTimeout(1000);

  // Set mode and submit
  await setFormMode(frame, mode);
  const docId = await submitForm(page, frame, "check_form_request");

  return textResult({
    error: false,
    data: {
      success: true,
      docId,
      mode,
      formType: "leave",
      subject,
      message: docId
        ? `Leave ${mode === "draft" ? "draft saved" : "submitted"} (doc_id: ${docId})`
        : `Leave ${mode === "draft" ? "draft" : "request"} completed (doc_id could not be extracted)`,
      warning: warnings.length > 0 ? warnings.join(" | ") : undefined,
    },
  });
}

async function submitExpense(
  page: any,
  frame: any,
  sessionManager: SessionManager,
  config: Config,
  params: Record<string, any>,
  mode: "draft" | "request"
) {
  if (params.amount !== undefined && (typeof params.amount !== 'number' || params.amount <= 0 || !Number.isFinite(params.amount))) {
    return textResult({
      error: true,
      code: "INVALID_AMOUNT",
      message: "Amount must be a positive number",
    });
  }

  const date = params.start_date || params.work_date || todayStr();
  const amount = params.amount || 15000;
  const amountNoVat = Math.floor(amount / 1.1);
  const vat = amount - amountNoVat;
  const itemName = params.reason || params.purpose || "overtime meal";
  const subject = params.title || `[Card] ${itemName}`;
  const budgetType = params.budget_type || "02";
  const budgetCode = params.budget_code;
  if (!budgetCode) {
    return textResult({ error: true, code: "MISSING_BUDGET_CODE", message: "budget_code is required. Provide the active fiscal year budget code (e.g. NN2612-0001)." });
  }
  const participants = params.participants || "";
  const purpose = params.purpose || "overtime work";
  const pReason = params.reason || `${itemName} - receipt attached`;

  // Step 1: Set subject and budget_type first (triggers cascade)
  const cascadeSchema: Record<string, TemplateFieldSchema> = {
    subject: { type: "text", dom_name: "subject", required: true },
    budget_type: { type: "select", dom_name: "budget_type", required: true },
  };
  await genericFillForm(frame, cascadeSchema, { subject, budget_type: budgetType });
  await page.waitForTimeout(1000);

  // Step 2: Set remaining fields after cascade settles
  const fieldSchema: Record<string, TemplateFieldSchema> = {
    budget_code: { type: "select", dom_name: "budget_code", required: true },
    pay_kind: { type: "select", dom_name: "pay_kind", required: true },
    p_reason: { type: "textarea", dom_name: "p_reason", required: true },
    invoice: { type: "date", dom_name: "invoice[]", required: true },
    item_desc: { type: "text", dom_name: "item_desc[]", required: true },
    item_qty: { type: "text", dom_name: "item_qty[]", required: false },
    item_amount: { type: "text", dom_name: "item_amount[]", required: false },
    item_amount_vat: { type: "text", dom_name: "item_amount_vat[]", required: false },
    ov_member: { type: "text", dom_name: "ov_member", required: false },
    ov_purpose: { type: "text", dom_name: "ov_purpose", required: false },
  };

  await genericFillForm(frame, fieldSchema, {
    budget_code: budgetCode,
    pay_kind: "04",
    p_reason: pReason,
    invoice: date,
    item_desc: itemName,
    item_qty: "1",
    item_amount: String(amountNoVat),
    item_amount_vat: String(vat),
    ov_member: participants,
    ov_purpose: purpose,
  });

  // Set totals via evaluate (uses getElementsByName — not in generic schema)
  await frame.evaluate(
    (args: { total: string; ral: string }) => {
      const totalEl = document.getElementsByName("total_amt")[0] as HTMLInputElement;
      if (totalEl) totalEl.value = args.total;
      const ralEl = document.querySelector('input[name="item_amount_ral[]"]') as HTMLInputElement;
      if (ralEl) ralEl.value = args.ral;
    },
    { total: String(amount), ral: String(amount) }
  );

  // Handle attachment if provided
  if (params.attachment_path) {
    const fileInput = frame.locator('input[name="doc_attach_file[]"]').first();
    await fileInput.setInputFiles(params.attachment_path);
    await page.waitForTimeout(1000);
  }

  await page.waitForTimeout(1000);

  await setFormMode(frame, mode);
  const docId = await submitForm(page, frame, "check_form_request");

  return textResult({
    error: false,
    data: {
      success: true,
      docId,
      mode,
      formType: "expense",
      subject,
      message: docId
        ? `Expense ${mode === "draft" ? "draft saved" : "submitted"} (doc_id: ${docId})`
        : `Expense ${mode} completed`,
      warning: !params.attachment_path
        ? "No attachment provided. Expense forms typically require a receipt."
        : undefined,
    },
  });
}

async function submitWorking(
  page: any,
  frame: any,
  sessionManager: SessionManager,
  config: Config,
  params: Record<string, any>,
  mode: "draft" | "request"
) {
  const userInfo = sessionManager.getUserInfo()!;
  const workDate = params.work_date || params.start_date || nextSaturday();
  const reason = params.reason || "experiment";
  const workPlace = params.work_place || "IPK";
  const details = params.details || reason;
  const budgetType = params.budget_type || "02";
  const budgetCode = params.budget_code;
  if (!budgetCode) {
    return textResult({ error: true, code: "MISSING_BUDGET_CODE", message: "budget_code is required. Provide the active fiscal year budget code (e.g. NN2612-0001)." });
  }

  const subject = `Application for Working on ${workDate}, ${userInfo.name}`;

  // Use genericFillForm — budget_type must be set first with a wait for cascade
  const fieldSchema: Record<string, TemplateFieldSchema> = {
    subject: { type: "text", dom_name: "subject", required: true },
    budget_type: { type: "select", dom_name: "budget_type", required: true },
  };

  // Step 1: Set subject and budget_type first (triggers cascade)
  await genericFillForm(frame, fieldSchema, { subject, budget_type: budgetType });
  await page.waitForTimeout(1000);

  // Step 2: Set remaining fields after cascade settles
  const remainingSchema: Record<string, TemplateFieldSchema> = {
    budget_code: { type: "select", dom_name: "budget_code", required: true },
    desired_date: { type: "date", dom_name: "desired_date", required: true },
    wroking_place: { type: "text", dom_name: "wroking_place", required: true }, // Note: typo is in the original groupware
    sub_subject: { type: "text", dom_name: "sub_subject", required: true },
    contents1: { type: "textarea", dom_name: "contents1", required: false },
  };

  await genericFillForm(frame, remainingSchema, {
    budget_code: budgetCode,
    desired_date: workDate,
    wroking_place: workPlace,
    sub_subject: reason,
    contents1: details,
  });

  await page.waitForTimeout(1000);

  await setFormMode(frame, mode);
  const docId = await submitForm(page, frame, "check_form_request");

  return textResult({
    error: false,
    data: {
      success: true,
      docId,
      mode,
      formType: "working",
      subject,
      message: docId
        ? `Working request ${mode === "draft" ? "draft saved" : "submitted"} (doc_id: ${docId})`
        : `Working request ${mode} completed`,
    },
  });
}

async function submitTravel(
  page: any,
  frame: any,
  sessionManager: SessionManager,
  config: Config,
  params: Record<string, any>,
  mode: "draft" | "request"
) {
  const userInfo = sessionManager.getUserInfo()!;
  const title = params.title || "Business Travel";
  const destination = params.destination || "";
  const startDate = params.start_date || todayStr();
  const endDate = params.end_date || startDate;
  const purpose = params.purpose || "Business travel";
  const schedule = params.schedule || `${startDate} ~ ${endDate}`;
  const organization = params.organization || destination;
  const attendees = params.attendees || userInfo.name;

  const reportDate = todayStr();
  const reportPost = process.env.IPK_USER_POSITION || "Researcher";
  const reportLeader = process.env.IPK_GROUP_LEADER || "";
  const userDept = userInfo.dept || process.env.IPK_USER_DEPT || "";

  const travelSchema: Record<string, TemplateFieldSchema> = {
    subject:          { type: "text", dom_name: "subject", required: true },
    report_date:      { type: "date", dom_name: "report_date", required: true, dom_selector: '.validate[name="report_date"]' },
    report_name:      { type: "text", dom_name: "report_name", required: true, dom_selector: '.validate[name="report_name"]' },
    report_post:      { type: "text", dom_name: "report_post", dom_selector: '.validate[name="report_post"]' },
    report_group:     { type: "text", dom_name: "report_group", dom_selector: '.validate[name="report_group"]' },
    report_leader:    { type: "text", dom_name: "report_leader", dom_selector: '.validate[name="report_leader"]' },
    start_day:        { type: "date", dom_name: "start_day", required: true, dom_selector: '.validate[name="start_day"]' },
    end_day:          { type: "date", dom_name: "end_day", required: true, dom_selector: '.validate[name="end_day"]' },
    report_dest:      { type: "text", dom_name: "report_dest", required: true, dom_selector: '.validate[name="report_dest"]' },
    purpose_field:    { type: "text", dom_name: "purpose_field", required: true, dom_selector: '.validate[name="purpose_field"]' },
    date_field:       { type: "text", dom_name: "date_field", dom_selector: '.validate[name="date_field"]' },
    org_field:        { type: "text", dom_name: "org_field", dom_selector: '.validate[name="org_field"]' },
    person_field:     { type: "text", dom_name: "person_field", dom_selector: '.validate[name="person_field"]' },
    discuss_field:    { type: "text", dom_name: "discuss_field", dom_selector: '.validate[name="discuss_field"]' },
    agenda_field:     { type: "text", dom_name: "agenda_field", dom_selector: '.validate[name="agenda_field"]' },
    result_field:     { type: "text", dom_name: "result_field", dom_selector: '.validate[name="result_field"]' },
    other_field:      { type: "text", dom_name: "other_field", dom_selector: '.validate[name="other_field"]' },
    conclusion_field: { type: "text", dom_name: "conclusion_field", dom_selector: '.validate[name="conclusion_field"]' },
  };

  await genericFillForm(frame, travelSchema, {
    subject: title,
    report_date: reportDate,
    report_name: userInfo.name,
    report_post: reportPost,
    report_group: userDept,
    report_leader: reportLeader,
    start_day: startDate,
    end_day: endDate,
    report_dest: destination,
    purpose_field: purpose,
    date_field: schedule,
    org_field: organization,
    person_field: attendees,
    discuss_field: params.details || purpose,
    agenda_field: params.schedule || purpose,
    result_field: params.reason || `Expected outcomes: ${purpose}`,
    other_field: "N/A",
    conclusion_field: params.destination ? `${purpose} at ${destination}` : `Travel for ${purpose}`,
  });

  // Handle attachment if provided
  if (params.attachment_path) {
    const fileInput = frame.locator('input[name="doc_attach_file[]"]').first();
    await fileInput.setInputFiles(params.attachment_path);
    await page.waitForTimeout(1000);
  }

  await page.waitForTimeout(1000);

  await setFormMode(frame, mode);
  // Travel form uses form1.submit() instead of Check_Form_Request
  const docId = await submitForm(page, frame, "form_submit");

  return textResult({
    error: false,
    data: {
      success: true,
      docId,
      mode,
      formType: "travel",
      subject: title,
      message: docId
        ? `Travel ${mode === "draft" ? "draft saved" : "submitted"} (doc_id: ${docId})`
        : `Travel ${mode} completed`,
    },
  });
}

async function submitTravelRequest(
  page: any,
  frame: any,
  sessionManager: SessionManager,
  config: Config,
  params: Record<string, any>,
  mode: "draft" | "request"
) {
  const userInfo = sessionManager.getUserInfo()!;
  const title = params.title || "Business Travel Request";
  const destination = params.destination || "";
  const startDate = params.start_date || todayStr();
  const endDate = params.end_date || startDate;
  const purpose = params.purpose || "Business travel";
  const budgetType = params.budget_type || "02";
  const budgetCode = params.budget_code;
  if (!budgetCode) {
    return textResult({ error: true, code: "MISSING_BUDGET_CODE", message: "budget_code is required. Provide the active fiscal year budget code (e.g. NN2612-0001)." });
  }

  const subject = `[Request] ${title}`;

  // Step 1: Set subject and budget_type (triggers cascade)
  const cascadeSchema: Record<string, TemplateFieldSchema> = {
    subject:     { type: "text", dom_name: "subject", required: true },
    budget_type: { type: "select", dom_name: "budget_type", required: true },
  };
  await genericFillForm(frame, cascadeSchema, { subject, budget_type: budgetType });
  await page.waitForTimeout(1000);

  // Step 2: Set budget_code and travel-specific fields after cascade settles
  const fieldSchema: Record<string, TemplateFieldSchema> = {
    budget_code:   { type: "select", dom_name: "budget_code", required: true },
    start_day:     { type: "date", dom_name: "start_day", required: true, dom_selector: '.validate[name="start_day"]' },
    end_day:       { type: "date", dom_name: "end_day", required: true, dom_selector: '.validate[name="end_day"]' },
    report_dest:   { type: "text", dom_name: "report_dest", required: true, dom_selector: '.validate[name="report_dest"]' },
    purpose_field: { type: "text", dom_name: "purpose_field", required: true, dom_selector: '.validate[name="purpose_field"]' },
    org_field:     { type: "text", dom_name: "org_field", dom_selectors: ['.validate[name="org_field"]', 'input[name="organization"]'] },
    person_field:  { type: "text", dom_name: "person_field", dom_selectors: ['.validate[name="person_field"]', 'input[name="attendees"]'] },
    date_field:    { type: "text", dom_name: "date_field", dom_selector: '.validate[name="date_field"]' },
    discuss_field: { type: "text", dom_name: "discuss_field", dom_selectors: ['textarea[name="contents1"]', '.validate[name="discuss_field"]'] },
  };

  await genericFillForm(frame, fieldSchema, {
    budget_code: budgetCode,
    start_day: startDate,
    end_day: endDate,
    report_dest: destination,
    purpose_field: purpose,
    org_field: params.organization || "",
    person_field: params.attendees || "",
    date_field: params.schedule || "",
    discuss_field: params.details || "",
  });

  // Handle attachment if provided
  if (params.attachment_path) {
    const fileInput = frame.locator('input[name="doc_attach_file[]"]').first();
    await fileInput.setInputFiles(params.attachment_path);
    await page.waitForTimeout(1000);
  }

  await page.waitForTimeout(1000);

  await setFormMode(frame, mode);
  const docId = await submitForm(page, frame, "check_form_request");

  return textResult({
    error: false,
    data: {
      success: true,
      docId,
      mode,
      formType: "travel_request",
      subject,
      message: docId
        ? `Travel request ${mode === "draft" ? "draft saved" : "submitted"} (doc_id: ${docId})`
        : `Travel request ${mode} completed`,
    },
  });
}

async function submitBudgetTransfer(
  page: any,
  frame: any,
  sessionManager: SessionManager,
  config: Config,
  params: Record<string, any>,
  mode: "draft" | "request"
) {
  const userInfo = sessionManager.getUserInfo()!;
  const transferType = params.transfer_type || "rnd";
  const fromBudget = params.from_budget_code || "";
  const toBudget = params.to_budget_code || "";
  const amount = params.transfer_amount || params.amount || 0;
  const reason = params.reason || params.purpose || "Budget reallocation";
  const title = params.title || `Budget Transfer: ${fromBudget} -> ${toBudget}`;

  if (amount !== undefined && amount !== 0 && (typeof amount !== "number" || amount <= 0 || !Number.isFinite(amount))) {
    return textResult({
      error: true,
      code: "INVALID_AMOUNT",
      message: "Transfer amount must be a positive number",
    });
  }

  const subject = `[Budget Transfer] ${title}`;
  const budgetTypeValue = transferType === "rnd" ? "02" : "01";

  // Step 1: Set subject and budget_type (triggers cascade)
  const cascadeSchema: Record<string, TemplateFieldSchema> = {
    subject:     { type: "text", dom_name: "subject", required: true },
    budget_type: { type: "select", dom_name: "budget_type" },
  };
  await genericFillForm(frame, cascadeSchema, { subject, budget_type: budgetTypeValue });
  await page.waitForTimeout(1000);

  // Step 2: Set remaining fields with multi-selector fallbacks
  const fieldSchema: Record<string, TemplateFieldSchema> = {
    from_budget: {
      type: "text", dom_name: null,
      dom_selectors: [
        'select[name="budget_code"]', 'select[name="from_budget_code"]', 'select[name="budget_code_from"]',
        'input[name="from_budget"]', 'input[name="budget_code_from"]',
      ],
    },
    to_budget: {
      type: "text", dom_name: null,
      dom_selectors: [
        'select[name="to_budget_code"]', 'select[name="budget_code_to"]',
        'input[name="to_budget"]', 'input[name="budget_code_to"]',
      ],
    },
    amount: {
      type: "text", dom_name: null,
      dom_selectors: [
        'input[name="amount"]', 'input[name="transfer_amount"]',
        'input[name="item_amount[]"]', 'input[name="total_amt"]',
      ],
    },
    reason: {
      type: "text", dom_name: null,
      dom_selectors: [
        'textarea[name="reason"]', 'textarea[name="p_reason"]',
        'textarea[name="contents1"]', 'input[name="sub_subject"]',
      ],
    },
  };

  await genericFillForm(frame, fieldSchema, {
    from_budget: fromBudget || undefined,
    to_budget: toBudget || undefined,
    amount: amount || undefined,
    reason,
  });

  // Handle attachment if provided
  if (params.attachment_path) {
    const fileInput = frame.locator('input[name="doc_attach_file[]"]').first();
    await fileInput.setInputFiles(params.attachment_path);
    await page.waitForTimeout(1000);
  }

  await page.waitForTimeout(1000);

  await setFormMode(frame, mode);
  const docId = await submitForm(page, frame, "check_form_request");

  return textResult({
    error: false,
    data: {
      success: true,
      docId,
      mode,
      formType: "budget_transfer",
      subject,
      transferType,
      message: docId
        ? `Budget transfer ${mode === "draft" ? "draft saved" : "submitted"} (doc_id: ${docId})`
        : `Budget transfer ${mode} completed`,
      note: "Field selectors are best-effort. After first use, verify the form was filled correctly via screenshot tool and report any missing fields.",
    },
  });
}

/** Card Expense (AppFrm-020) — same form as expense but with card-specific fields */
async function submitCardExpense(
  page: any,
  frame: any,
  sessionManager: SessionManager,
  config: Config,
  params: Record<string, any>,
  mode: "draft" | "request"
) {
  if (params.amount !== undefined && (typeof params.amount !== 'number' || params.amount <= 0 || !Number.isFinite(params.amount))) {
    return textResult({ error: true, code: "INVALID_AMOUNT", message: "Amount must be a positive number" });
  }

  const date = params.item_date || params.start_date || todayStr();
  const amount = params.amount || 0;
  const amountNoVat = Math.floor(amount / 1.1);
  const vat = amount - amountNoVat;
  const itemDesc = params.item_description || "Team activities";
  const accountCode = params.item_account_code || "420421";
  const vendor = params.item_vendor || "";
  const controlNo = params.item_control_no || "";
  const subject = params.title || `[Card] ${itemDesc}`;
  const budgetCode = params.budget_code;
  if (!budgetCode) {
    return textResult({ error: true, code: "MISSING_BUDGET_CODE", message: "budget_code is required. Provide the active fiscal year budget code (e.g. NN2612-0001)." });
  }
  const participants = params.participants || "";
  const venue = params.venue || "";
  const purposeMinutes = params.purpose_minutes || params.purpose || "";
  const pReason = params.reason || `${itemDesc} - receipt attached`;

  // Step 1: Set subject and budget_type first (triggers cascade)
  const cascadeSchema: Record<string, TemplateFieldSchema> = {
    subject: { type: "text", dom_name: "subject", required: true },
    budget_type: { type: "select", dom_name: "budget_type", required: true },
  };
  await genericFillForm(frame, cascadeSchema, { subject, budget_type: "02" });
  await page.waitForTimeout(1000);

  // Step 2: Set fields after cascade settles
  const fieldSchema: Record<string, TemplateFieldSchema> = {
    budget_code: { type: "select", dom_name: "budget_code", required: true },
    pay_kind: { type: "select", dom_name: "pay_kind", required: true },
    card_no: { type: "text", dom_name: "card_no", required: false },
    p_reason: { type: "textarea", dom_name: "p_reason", required: true },
    invoice: { type: "date", dom_name: "invoice[]", required: true },
    item_desc: { type: "text", dom_name: "item_desc[]", required: true },
    item_qty: { type: "text", dom_name: "item_qty[]", required: false },
    item_amount: { type: "text", dom_name: "item_amount[]", required: false },
    item_amount_vat: { type: "text", dom_name: "item_amount_vat[]", required: false },
    item_account_code: { type: "select", dom_name: "item_account_code[]", required: false },
    item_vendor: { type: "text", dom_name: "item_vendor[]", required: false },
    item_control_no: { type: "text", dom_name: "item_control_no[]", required: false },
    ov_member: { type: "text", dom_name: "ov_member", required: false },
    ov_purpose: { type: "text", dom_name: "ov_purpose", required: false },
    ov_place: { type: "text", dom_name: "ov_place", required: false },
  };

  const cardNo = params.corp_card_no || process.env.IPK_CORP_CARD_NO || "";

  await genericFillForm(frame, fieldSchema, {
    budget_code: budgetCode,
    pay_kind: "04", // 04 = Corp Card
    card_no: cardNo,
    p_reason: pReason,
    invoice: date,
    item_desc: itemDesc,
    item_qty: "1",
    item_amount: String(amountNoVat),
    item_amount_vat: String(vat),
    item_account_code: accountCode,
    item_vendor: vendor,
    item_control_no: controlNo,
    ov_member: participants,
    ov_purpose: purposeMinutes,
    ov_place: venue,
  });

  // Set totals via evaluate (uses getElementsByName — not in generic schema)
  await frame.evaluate(
    (args: { total: string; ral: string }) => {
      const totalEl = document.getElementsByName("total_amt")[0] as HTMLInputElement;
      if (totalEl) totalEl.value = args.total;
      const ralEl = document.querySelector('input[name="item_amount_ral[]"]') as HTMLInputElement;
      if (ralEl) ralEl.value = args.ral;
    },
    { total: String(amount), ral: String(amount) }
  );

  // Handle attachment
  if (params.attachment_path) {
    const fileInput = frame.locator('input[name="doc_attach_file[]"]').first();
    await fileInput.setInputFiles(params.attachment_path);
    await page.waitForTimeout(1000);
  }

  await page.waitForTimeout(1000);
  await setFormMode(frame, mode);
  const docId = await submitForm(page, frame, "check_form_request");

  return textResult({
    error: false,
    data: {
      success: true, docId, mode, formType: "card_expense", subject,
      message: docId
        ? `Card expense ${mode === "draft" ? "draft saved" : "submitted"} (doc_id: ${docId})`
        : `Card expense ${mode} completed`,
      warning: !params.attachment_path ? "No attachment provided. Card expense forms require a receipt." : undefined,
    },
  });
}

/** Travel Settlement (AppFrm-054) — domestic travel expense settlement
 *
 * Key mechanism: sel_travel hidden field links to the approved travel request (AppFrm-023).
 * Setting sel_travel + dispatching 'change' may auto-populate parent-doc fields
 * (start_date, end_date, province, city, transport_mode, purpose_category, purpose, destination).
 * If auto-populate doesn't work, we fall back to manual cascade + field setting.
 */
async function submitTravelSettlement(
  page: any,
  frame: any,
  sessionManager: SessionManager,
  config: Config,
  params: Record<string, any>,
  mode: "draft" | "request"
) {
  const purpose = params.purpose || "Business travel";
  const subject = params.title || `[Settlement] ${purpose}`;
  const approvedDocRef = params.approved_doc_ref || params.sel_travel || "";

  // Step 1: Set sel_travel hidden field to link the approved travel request
  let autoPopulated = false;
  if (approvedDocRef) {
    await frame.evaluate(
      (docRef: string) => {
        const selTravel = document.querySelector('input[name="sel_travel"]') as HTMLInputElement | null;
        if (selTravel) {
          selTravel.value = docRef;
          selTravel.dispatchEvent(new Event("change", { bubbles: true }));
        }
      },
      approvedDocRef
    );
    // Wait to see if groupware JS auto-populates fields
    await page.waitForTimeout(2000);

    // Check if auto-populate worked by verifying at least one parent-doc field is filled
    autoPopulated = await frame.evaluate(() => {
      const startDate = document.querySelector('input[name="start_date"]') as HTMLInputElement | null;
      const province = document.querySelector('select[name="province"]') as HTMLSelectElement | null;
      return !!(
        (startDate && startDate.value && startDate.value !== "") ||
        (province && province.value && province.value !== "" && province.value !== "0")
      );
    });
  }

  // Step 2: If auto-populate didn't work, manually set parent-doc fields + run cascade
  if (!autoPopulated) {
    const startDate = params.start_date || todayStr();
    const endDate = params.end_date || startDate;

    // Set date and text fields via genericFillForm
    const manualSchema: Record<string, TemplateFieldSchema> = {
      start_date:       { type: "date", dom_name: "start_date" },
      end_date:         { type: "date", dom_name: "end_date" },
      purpose_category: { type: "select", dom_name: "purpose_category" },
      purpose:          { type: "textarea", dom_name: "purpose" },
      destination:      { type: "text", dom_name: "destination" },
    };

    await genericFillForm(frame, manualSchema, {
      start_date: startDate,
      end_date: endDate,
      purpose_category: params.purpose_category || "",
      purpose: params.purpose || "",
      destination: params.destination || "",
    });

    // Run AJAX cascade: province -> city -> transport_mode -> budget_type -> budget_code -> item_no
    const province = params.province || "";
    const city = params.city || "";
    const transportMode = params.transport_mode || "Other Public Transporation";
    const budgetType = params.budget_type || "02"; // R&D default

    if (province) {
      const cascadeSteps: CascadeStep[] = [
        {
          field: "province",
          value: province,
          waitSelector: "select[name='city'] option:nth-child(2)",
          timeoutMs: 3000,
        },
        {
          field: "city",
          value: city,
          waitSelector: "select[name='transport_mode'] option:nth-child(2)",
          timeoutMs: 3000,
        },
        {
          field: "transport_mode",
          value: transportMode,
          timeoutMs: 1500,
        },
        {
          field: "budget_type",
          value: budgetType,
          waitSelector: "select[name='budget_code'] option:nth-child(2)",
          timeoutMs: 3000,
        },
      ];

      // Add budget_code step if provided
      if (params.budget_code) {
        cascadeSteps.push({
          field: "budget_code",
          value: params.budget_code,
          waitSelector: "select[name='item_no'] option:nth-child(2)",
          timeoutMs: 3000,
          condition: "budget_type",
        });
      }
      // Add item_no step if provided
      if (params.item_no) {
        cascadeSteps.push({
          field: "item_no",
          value: params.item_no,
          timeoutMs: 1500,
          condition: "budget_code",
        });
      }

      await executeAjaxCascade(page, frame, cascadeSteps);
    }
  }

  // Step 3: Set subject, budget control, and expense amounts via genericFillForm
  const startDate = params.start_date || todayStr();
  const endDate = params.end_date || startDate;
  const nights = Math.max(0, Math.round((new Date(endDate).getTime() - new Date(startDate).getTime()) / 86400000));
  const dailyExpense = params.daily_expense || (nights === 0 ? 20000 : 30000 * nights);
  const transportFee = params.transport_fee || 0;
  const accommodationFee = params.accommodation || 0;
  const foodExpense = params.food_expense || 0;

  const postSchema: Record<string, TemplateFieldSchema> = {
    subject:                 { type: "text", dom_name: "subject", required: true },
    budget_control_no:       { type: "hidden", dom_name: "budget_control_no" },
    daily_fee_total:         { type: "text", dom_name: "daily_fee_total" },
    ocar_pay:                { type: "text", dom_name: "ocar_pay" },
    accommodation_fee_total: { type: "text", dom_name: "accommodation_fee_total" },
    food_fee_total:          { type: "text", dom_name: "food_fee_total" },
  };

  await genericFillForm(frame, postSchema, {
    subject,
    budget_control_no: params.budget_control_no || "",
    daily_fee_total: String(dailyExpense),
    ocar_pay: transportFee ? String(transportFee) : "",
    accommodation_fee_total: accommodationFee ? String(accommodationFee) : "",
    food_fee_total: foodExpense ? String(foodExpense) : "",
  });

  // Step 6: Handle attachment
  if (params.attachment_path) {
    const fileInput = frame.locator('input[name="doc_attach_file[]"]').first();
    await fileInput.setInputFiles(params.attachment_path);
    await page.waitForTimeout(1000);
  }

  await page.waitForTimeout(1000);
  await setFormMode(frame, mode);
  const docId = await submitForm(page, frame, "check_form_request");

  const warnings: string[] = [];
  if (!approvedDocRef) {
    warnings.push("No approved_doc_ref (sel_travel) provided — parent document fields may be incomplete.");
  }
  if (!autoPopulated && approvedDocRef) {
    warnings.push("sel_travel auto-populate did not work — used manual cascade fallback.");
  }
  if (params.transport_mode?.includes("Own Vehicle") && !params.attachment_path) {
    warnings.push("Own vehicle travel requires 거리.pdf (Naver Maps screenshot) attachment.");
  }
  if (params.toll_fee && params.toll_fee > 0 && !params.attachment_path) {
    warnings.push("Toll fee claimed requires 하이패스 영수증 attachment.");
  }

  return textResult({
    error: false,
    data: {
      success: true, docId, mode, formType: "travel_settlement", subject,
      autoPopulated,
      message: docId
        ? `Travel settlement ${mode === "draft" ? "draft saved" : "submitted"} (doc_id: ${docId})`
        : `Travel settlement ${mode} completed`,
      warning: warnings.length > 0 ? warnings.join(" | ") : undefined,
    },
  });
}

/** Leave Return (AppFrm-028) — return unused leave days/hours */
async function submitLeaveReturn(
  page: any,
  frame: any,
  sessionManager: SessionManager,
  config: Config,
  params: Record<string, any>,
  mode: "draft" | "request"
) {
  const originalDoc = params.original_leave_doc || "";
  if (!originalDoc) {
    return textResult({ error: true, code: "MISSING_FIELD", message: "original_leave_doc is required (e.g. ARL-260121-02)" });
  }

  const periodStart = params.start_date || params.period_start || todayStr();
  const periodEnd = params.end_date || params.period_end || periodStart;
  const returnDays = params.return_days ?? 1;
  const returnHours = params.return_hours ?? 0;
  const description = params.description || params.reason || "Leave return";
  const leaveType = params.leave_type || "annual";
  const leaveCode = LEAVE_TYPES[leaveType] || "01";

  // Build return label and subject
  let returnLabel = "";
  if (returnDays > 0 && returnHours > 0) {
    returnLabel = `${returnDays}day(s)/${returnHours}hour(s)`;
  } else if (returnDays > 0) {
    returnLabel = `${returnDays}day(s)`;
  } else {
    returnLabel = `${returnHours}hour(s)`;
  }
  const subject = params.title || `Leave return ${returnLabel} ${originalDoc}`;

  // Use genericFillForm with AppFrm-028 field schema
  const fieldSchema: Record<string, TemplateFieldSchema> = {
    subject: { type: "text", dom_name: "subject", required: true },
    original_leave_doc: { type: "text", dom_name: "original_leave_doc", required: true },
    leave_type: { type: "select", dom_name: "leave_kind[]", required: false },
    period_start: { type: "date", dom_name: "begin_date", required: true },
    period_end: { type: "date", dom_name: "end_date", required: true },
    return_days: { type: "integer", dom_name: "return_days", required: false },
    return_hours: { type: "integer", dom_name: "return_hours", required: false },
    description: { type: "textarea", dom_name: "description", required: false },
  };

  const userData: Record<string, any> = {
    subject,
    original_leave_doc: originalDoc,
    leave_type: leaveCode,
    period_start: periodStart,
    period_end: periodEnd,
    return_days: String(returnDays),
    return_hours: String(returnHours),
    description,
  };

  // Post-fill hook: mirror description to contents1
  const hooks: FillHook[] = [
    {
      trigger: "post_fill",
      fn: async (f: any) => {
        await setFieldValue(f, 'textarea[name="contents1"]', description);
      },
    },
  ];

  await genericFillForm(frame, fieldSchema, userData, hooks);

  await page.waitForTimeout(1000);
  await setFormMode(frame, mode);
  const docId = await submitForm(page, frame, "check_form_request");

  return textResult({
    error: false,
    data: {
      success: true, docId, mode, formType: "leave_return", subject,
      message: docId
        ? `Leave return ${mode === "draft" ? "draft saved" : "submitted"} (doc_id: ${docId})`
        : `Leave return ${mode} completed`,
    },
  });
}

/** Seminar/Event Public Disclosure (AppFrm-043) */
async function submitSeminar(
  page: any,
  frame: any,
  sessionManager: SessionManager,
  config: Config,
  params: Record<string, any>,
  mode: "draft" | "request"
) {
  const userInfo = sessionManager.getUserInfo()!;
  const subject = params.title || params.subject || "";
  if (!subject) {
    return textResult({ error: true, code: "MISSING_FIELD", message: "title is required (title of the seminar/event/publication)" });
  }

  const requester = params.attendees || userInfo.name;
  const disclosurePurpose = params.disclosure_purpose || params.purpose || "";
  const disclosureDate = params.disclosure_date || params.start_date || todayStr();
  const materialDesc = params.material_description || "";
  const conferenceOrJournal = params.conference_or_journal || params.organization || "";

  // Use genericFillForm with AppFrm-043 field schema
  const fieldSchema: Record<string, TemplateFieldSchema> = {
    subject: { type: "text", dom_name: "subject", required: true },
    requester: { type: "text", dom_name: "requester", required: false },
    disclosure_purpose: { type: "textarea", dom_name: "disclosure_purpose", required: false },
    disclosure_date: { type: "date", dom_name: "disclosure_date", required: false },
    material_description: { type: "text", dom_name: "material_description", required: false },
    conference_or_journal: { type: "text", dom_name: "conference_or_journal", required: false },
  };

  const userData: Record<string, any> = {
    subject,
    requester,
    disclosure_purpose: disclosurePurpose,
    disclosure_date: disclosureDate,
    material_description: materialDesc,
    conference_or_journal: conferenceOrJournal,
  };

  // Post-fill hooks: mirror to .validate fields, set radios, check predatory checkbox
  const hooks: FillHook[] = [
    {
      trigger: "post_fill",
      fn: async (f: any) => {
        // Mirror fields to .validate selectors
        await setFieldValue(f, '.validate[name="requester"]', requester);
        await setFieldValue(f, '.validate[name="purpose_field"]', disclosurePurpose);
        await setFieldValue(f, '.validate[name="disclosure_date"]', disclosureDate);
        await setFieldValue(f, '.validate[name="material_description"]', materialDesc);
        await setFieldValue(f, '.validate[name="conference_or_journal"]', conferenceOrJournal);
      },
    },
    {
      trigger: "evaluate",
      fn: async (f: any) => {
        // Radio Q&A fields (Q1-Q5) via parameterized evaluate
        const radioValues: Record<string, string> = {
          patent_filed: params.patent_filed || "",
          patent_planned: params.patent_planned || "",
          material_published: params.material_published || "N",
          collaborator_approval: params.collaborator_approval || "Y",
          contains_confidential: params.contains_confidential || "N",
        };

        await f.evaluate(
          (rv: Record<string, string>) => {
            const radioMap: [string, string][] = [
              ["patent_filed", "Q1"],
              ["patent_planned", "Q2"],
              ["material_published", "Q3"],
              ["collaborator_approval", "Q4"],
              ["contains_confidential", "Q5"],
            ];
            for (const [paramKey, qName] of radioMap) {
              const val = rv[paramKey];
              if (!val) continue;
              const selectors = [
                `input[name="${qName}"][value="${val}"]`,
                `input[name="radio_${qName}"][value="${val}"]`,
                `input[name="chk_${qName}"][value="${val}"]`,
              ];
              for (const sel of selectors) {
                const el = document.querySelector(sel) as HTMLInputElement;
                if (el) { el.checked = true; el.dispatchEvent(new Event("change", { bubbles: true })); break; }
              }
            }
          },
          radioValues
        );

        // Predatory check checkbox (mandatory acknowledgment — always check)
        await f.evaluate(() => {
          const chk = document.querySelector('input[name="chk410306"]') as HTMLInputElement
            || document.querySelector('input[type="checkbox"][name*="chk"]') as HTMLInputElement;
          if (chk && !chk.checked) {
            chk.checked = true;
            chk.dispatchEvent(new Event("change", { bubbles: true }));
          }
        });
      },
    },
  ];

  await genericFillForm(frame, fieldSchema, userData, hooks);

  // Handle attachment
  if (params.attachment_path) {
    const fileInput = frame.locator('input[name="doc_attach_file[]"]').first();
    await fileInput.setInputFiles(params.attachment_path);
    await page.waitForTimeout(1000);
  }

  await page.waitForTimeout(1000);
  await setFormMode(frame, mode);
  const docId = await submitForm(page, frame, "check_form_request");

  return textResult({
    error: false,
    data: {
      success: true, docId, mode, formType: "seminar", subject,
      message: docId
        ? `Seminar disclosure ${mode === "draft" ? "draft saved" : "submitted"} (doc_id: ${docId})`
        : `Seminar disclosure ${mode} completed`,
      warning: !params.attachment_path
        ? "No attachment provided. Seminar disclosure forms typically require presentation materials."
        : undefined,
    },
  });
}

/** Overseas Travel Settlement (AppFrm-026) */
async function submitOverseasTravel(
  page: any,
  frame: any,
  sessionManager: SessionManager,
  config: Config,
  params: Record<string, any>,
  mode: "draft" | "request"
) {
  const userInfo = sessionManager.getUserInfo()!;
  const conferenceName = params.conference_name || params.organization || "";
  const subject = params.title || `[Settlement] ${conferenceName || "Overseas Business Travel"}`;
  const country = params.country || "";
  const purpose = params.purpose || `Attend ${conferenceName}`;
  const travelStart = params.travel_start || params.start_date || todayStr();
  const travelEnd = params.travel_end || params.end_date || travelStart;
  const paymentDate = params.payment_date || todayStr();
  const budgetControlNo = params.budget_control_no || "";
  const corpCardNo = params.corp_card_no || process.env.IPK_CORP_CARD_NO || "";

  // Use genericFillForm for standard text/date fields
  const payrollId = process.env.IPK_PAYROLL_ID || "";
  const travelerStr = payrollId ? `${userInfo.name}(${payrollId})` : userInfo.name;

  const fieldSchema: Record<string, TemplateFieldSchema> = {
    subject: { type: "text", dom_name: "subject", required: true },
    traveler: { type: "text", dom_name: "traveler", required: false },
    budget_control_no: { type: "text", dom_name: "budget_control_no", required: false },
    country: { type: "text", dom_name: "country", required: true },
    conference_name: { type: "text", dom_name: "conference_name", required: false },
    purpose: { type: "textarea", dom_name: "purpose", required: true },
    travel_start: { type: "date", dom_name: "travel_start", required: true },
    travel_end: { type: "date", dom_name: "travel_end", required: true },
    payment_date: { type: "date", dom_name: "payment_date", required: false },
    corp_card_no: { type: "text", dom_name: "corp_card_no", required: false },
    // Expense fields
    transport_fee_total: { type: "number", dom_name: "transport_fee_total", required: false },
    transport_fee_card: { type: "number", dom_name: "transport_fee_card", required: false },
    daily_expense_total: { type: "number", dom_name: "daily_expense_total", required: false },
    daily_expense_cash: { type: "number", dom_name: "daily_expense_cash", required: false },
    accommodation_total: { type: "number", dom_name: "accommodation_total", required: false },
    accommodation_card: { type: "number", dom_name: "accommodation_card", required: false },
    food_expense_total: { type: "number", dom_name: "food_expense_total", required: false },
    food_expense_cash: { type: "number", dom_name: "food_expense_cash", required: false },
    settle_amount: { type: "number", dom_name: "settle_amount", required: false },
    reimbursement: { type: "number", dom_name: "reimbursement", required: false },
    business_materials: { type: "text", dom_name: "business_materials", required: false },
  };

  const userData: Record<string, any> = {
    subject,
    traveler: travelerStr,
    budget_control_no: budgetControlNo,
    country,
    conference_name: conferenceName,
    purpose,
    travel_start: travelStart,
    travel_end: travelEnd,
    payment_date: paymentDate,
    corp_card_no: corpCardNo,
    transport_fee_total: params.transport_fee_budget,
    transport_fee_card: params.transport_fee_corp_card,
    daily_expense_total: params.daily_expense_budget,
    daily_expense_cash: params.daily_expense_cash,
    accommodation_total: params.accommodation_budget,
    accommodation_card: params.accommodation_corp_card,
    food_expense_total: params.food_expense_budget,
    food_expense_cash: params.food_expense_cash,
    settle_amount: params.settle_amount,
    reimbursement: params.reimbursement,
    business_materials: params.material_description,
  };

  // Post-fill hooks: mirror to .validate fields, set radios, schedule rows, budget cascade
  const hooks: FillHook[] = [
    {
      trigger: "post_fill",
      fn: async (f: any) => {
        // Mirror fields to .validate selectors
        await setFieldValue(f, '.validate[name="traveler"]', travelerStr);
        if (budgetControlNo) await setFieldValue(f, '.validate[name="budget_control_no"]', budgetControlNo);
        await setFieldValue(f, '.validate[name="conference_name"]', conferenceName);
        await setFieldValue(f, '.validate[name="purpose_field"]', purpose);
        if (corpCardNo) await setFieldValue(f, '.validate[name="corp_card_no"]', corpCardNo);

        // Mirror expense fields to .validate
        const expenseFields: [string, number | undefined][] = [
          ["transport_fee_total", params.transport_fee_budget],
          ["transport_fee_card", params.transport_fee_corp_card],
          ["daily_expense_total", params.daily_expense_budget],
          ["daily_expense_cash", params.daily_expense_cash],
          ["accommodation_total", params.accommodation_budget],
          ["accommodation_card", params.accommodation_corp_card],
          ["food_expense_total", params.food_expense_budget],
          ["food_expense_cash", params.food_expense_cash],
          ["settle_amount", params.settle_amount],
          ["reimbursement", params.reimbursement],
        ];
        for (const [fieldName, value] of expenseFields) {
          if (value !== undefined && value !== null) {
            await setFieldValue(f, `.validate[name="${fieldName}"]`, String(value));
          }
        }
        if (params.material_description) {
          await setFieldValue(f, '.validate[name="business_materials"]', params.material_description);
        }
      },
    },
    {
      trigger: "evaluate",
      fn: async (f: any) => {
        // Travel with invitation (default: No), Car rent (default: No)
        await f.evaluate(() => {
          const radioSelectors = [
            ['input[name="travel_with_invitation"][value="No"]', 'input[name="invitation"][value="No"]'],
            ['input[name="car_rent"][value="No"]', 'input[name="rent_car"][value="No"]'],
          ];
          for (const selectors of radioSelectors) {
            for (const sel of selectors) {
              const el = document.querySelector(sel) as HTMLInputElement;
              if (el) { el.checked = true; el.dispatchEvent(new Event("change", { bubbles: true })); break; }
            }
          }
        });

        // Schedule rows (daily itinerary)
        if (params.schedule_rows && Array.isArray(params.schedule_rows)) {
          await f.evaluate(
            (rows: { from: string; to: string; schedule: string; transportation: string }[]) => {
              for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                const fromEl = document.querySelector(`input[name="schedule_from[${i}]"]`) as HTMLInputElement;
                const toEl = document.querySelector(`input[name="schedule_to[${i}]"]`) as HTMLInputElement;
                const schedEl = document.querySelector(`input[name="schedule_desc[${i}]"]`) as HTMLInputElement
                  || document.querySelector(`textarea[name="schedule_desc[${i}]"]`) as HTMLTextAreaElement;
                const transEl = document.querySelector(`input[name="schedule_transport[${i}]"]`) as HTMLInputElement;
                if (fromEl) fromEl.value = row.from;
                if (toEl) toEl.value = row.to;
                if (schedEl) schedEl.value = row.schedule;
                if (transEl) transEl.value = row.transportation;
              }
            },
            params.schedule_rows
          );
        }
      },
    },
  ];

  await genericFillForm(frame, fieldSchema, userData, hooks);

  // Budget account code (needs cascade wait — kept outside generic fill)
  if (params.budget_code) {
    await setSelectValue(frame, 'select[name="budget_type"]', "02"); // R&D
    await page.waitForTimeout(2000);
    await setSelectValue(frame, 'select[name="budget_code"]', params.budget_code);
    await page.waitForTimeout(1500);
  }

  // Handle attachment
  if (params.attachment_path) {
    const fileInput = frame.locator('input[name="doc_attach_file[]"]').first();
    await fileInput.setInputFiles(params.attachment_path);
    await page.waitForTimeout(1000);
  }

  await page.waitForTimeout(1000);
  await setFormMode(frame, mode);
  const docId = await submitForm(page, frame, "check_form_request");

  return textResult({
    error: false,
    data: {
      success: true, docId, mode, formType: "overseas_travel", subject,
      message: docId
        ? `Overseas travel settlement ${mode === "draft" ? "draft saved" : "submitted"} (doc_id: ${docId})`
        : `Overseas travel settlement ${mode} completed`,
    },
  });
}

/** Set substitute fields directly (fallback when popup fails) */
async function setFallbackSubstitute(frame: any, name: string): Promise<void> {
  // Use parameterized evaluate to set readonly fields
  await frame.evaluate(
    (args: { name: string; payroll: string; position: string; contact: string }) => {
      const fields: [string, string][] = [
        ["substitute_name", args.name],
        ["substitute_payroll", args.payroll],
        ["substitute_position", args.position],
        ["substitute_contact", args.contact],
      ];
      for (const [fieldName, value] of fields) {
        const el = document.querySelector(`input[name="${fieldName}"]`) as HTMLInputElement;
        if (el) {
          el.readOnly = false;
          el.value = value;
        }
      }
    },
    {
      name,
      payroll: process.env.IPK_SUBSTITUTE_PAYROLL || "N/A",
      position: process.env.IPK_SUBSTITUTE_POSITION || "Researcher",
      contact: process.env.IPK_SUBSTITUTE_CONTACT || "N/A",
    }
  );
}

function todayStr(): string {
  return new Date().toISOString().split("T")[0];
}

function tomorrow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().split("T")[0];
}

function nextSaturday(): string {
  const d = new Date();
  const daysUntilSat = (6 - d.getDay()) % 7 || 7;
  d.setDate(d.getDate() + daysUntilSat);
  return d.toISOString().split("T")[0];
}

