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
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { FORM_REGISTRY } from "../form-registry.js";

// ─── Template-driven generic form filler ───────────────────────────────────

type WidgetType = "text" | "select" | "date" | "checkbox" | "radio" | "textarea" | "file_upload" | "account_lookup" | "rich_text";

interface PostAction {
  /** Action type */
  action: "click_button" | "wait_selector" | "iframe_switch" | "assert_value";
  /** CSS selector target */
  target?: string;
  /** Expected or input value */
  value?: string;
}

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
  /** Explicit widget type for genericFillForm dispatch (overrides type-based dispatch) */
  widget_type?: WidgetType;
  /** Declarative post-fill actions executed after this field is set */
  post_actions?: PostAction[];
  /** For file_upload: which userData key holds file path(s) (default: same as fieldKey) */
  file_paths_key?: string;
  /** For account_lookup: row index in account_str[], account_code[], etc. (default: 1) */
  account_row_idx?: number;
  /** For account_lookup: approve_type to pass to pr_account_sel.php (default: form's appFrmCode) */
  account_approve_type?: string;
  [key: string]: any;
}

/** Hook definition for pre/post fill or evaluate actions */
interface FillHook {
  trigger: "pre_fill" | "post_fill" | "evaluate";
  /** JavaScript function body to execute via frame.evaluate(). Receives `userData` as argument. */
  fn: (frame: any, page: any, userData: Record<string, any>) => Promise<void>;
}

/**
 * Execute declarative post-fill actions on a frame.
 */
async function executePostActions(frame: any, actions: PostAction[]): Promise<void> {
  for (const act of actions) {
    if (act.action === "wait_selector" && act.target) {
      await frame.waitForSelector(act.target, { timeout: 5000 }).catch(() => null);
    } else if (act.action === "click_button" && act.target) {
      await frame.locator(act.target).click().catch(() => null);
    } else if (act.action === "assert_value" && act.target && act.value) {
      // Soft assert — logs but doesn't throw
      const actual = await frame.evaluate(
        (args: { sel: string }) => {
          const el = document.querySelector(args.sel) as HTMLInputElement | null;
          return el ? el.value : null;
        },
        { sel: act.target }
      ).catch(() => null);
      if (actual !== act.value) {
        console.warn(`[genericFillForm] assert_value failed: ${act.target} expected "${act.value}" got "${actual}"`);
      }
    }
    // iframe_switch not implemented at field level
  }
}

/**
 * Generic form filler that iterates a template's field_schema and sets DOM values
 * based on dom_name. Skips fields where dom_name is null (derived/computed).
 *
 * @param frame  - The Playwright Frame for the form
 * @param fieldSchema - template.field_schema object
 * @param userData - Map of field keys → user-supplied values
 * @param hooks - Optional hooks for pre/post fill or complex evaluate logic
 * @param opts - Optional extended options for new widget types (file_upload, account_lookup)
 */
async function genericFillForm(
  frame: any,
  fieldSchema: Record<string, TemplateFieldSchema>,
  userData: Record<string, any>,
  hooks?: FillHook[],
  opts?: { page?: any; approveType?: string; baseUrl?: string; budgetType?: string; budgetCode?: string }
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

    // Resolve effective widget type: explicit widget_type overrides type
    const widgetType = schema.widget_type || fieldType;

    if (widgetType === "file_upload") {
      // Dispatch to attachFiles primitive
      const pathsKey = schema.file_paths_key || fieldKey;
      const rawPaths = userData[pathsKey] ?? value;
      const paths: string[] = Array.isArray(rawPaths) ? rawPaths : [String(rawPaths)];
      const validPaths = paths.filter(Boolean);
      if (validPaths.length > 0) {
        const { attachFiles } = await import("../internal/primitives/attachment.js");
        await attachFiles(frame, validPaths);
      }
      if (schema.post_actions) {
        await executePostActions(frame, schema.post_actions);
      }
      continue;
    }

    if (widgetType === "account_lookup") {
      // Dispatch to account primitive (needs page from opts)
      if (opts?.page && opts?.baseUrl && opts?.budgetCode) {
        const { fetchAccountCodes, setAccountCodeOnRow } = await import("../internal/primitives/account.js");
        const codes = await fetchAccountCodes(opts.page, {
          baseUrl: opts.baseUrl,
          budgetType: opts.budgetType || "02",
          budgetCode: opts.budgetCode,
          approveType: schema.account_approve_type || opts.approveType || "AppFrm-021",
        });
        const strVal = String(value);
        const match = codes.find((c) => c.code === strVal) ||
          codes.find((c) => c.label.toLowerCase().includes(strVal.toLowerCase()));
        if (match) {
          const rowIdx = schema.account_row_idx ?? 1;
          await setAccountCodeOnRow(frame, rowIdx, match);
        }
      }
      if (schema.post_actions) {
        await executePostActions(frame, schema.post_actions);
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

/**
 * Load field_schema from a form template JSON file.
 * Returns null if the template doesn't exist or lacks field_schema.
 */
function loadTemplateFieldSchema(formType: string): Record<string, TemplateFieldSchema> | null {
  const registry = FORM_REGISTRY[formType as keyof typeof FORM_REGISTRY];
  if (!registry) return null;

  const projectRoot = path.resolve(__dirname, "..", "..");
  const templatePath = path.join(projectRoot, "form_templates", registry.templateFile);

  try {
    const raw = fs.readFileSync(templatePath, "utf-8");
    const template = JSON.parse(raw);
    return template.field_schema || null;
  } catch {
    return null;
  }
}

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
    "travel_settlement", "leave_return", "card_expense", "card_expense_rd", "seminar", "overseas_travel",
  ]).describe("Form type to submit"),

  // card_expense_rd (AppFrm-021) — R&D ER constructed from a corporate card receipt.
  // Required: trseq + appr_no (from corporation_card_list.php Make ER link). Most other
  // fields are auto-filled by the form via the mker=Y URL pattern.
  trseq: z.string().optional().describe("Card receipt transaction sequence (e.g. '26040417102'). Required for card_expense_rd."),
  appr_no: z.string().optional().describe("Card approval number (e.g. '19984403' or 'i5773800' for overseas). Required for card_expense_rd."),
  item_name: z.string().optional().describe("Item name for card_expense_rd row (English). e.g. 'Google Cloud Gemini API service'."),
  seller_en: z.string().optional().describe("English vendor name for card_expense_rd row. e.g. 'Google Cloud Korea LLC'."),
  account_code_label: z.string().optional().describe("Substring/regex to auto-pick account code from Sel_account popup options (e.g. 'IT Software'). If account_code is also given, account_code wins."),
  attachment_paths: z.array(z.string()).optional().describe("Multiple attachment file paths for card_expense_rd. Each file is uploaded to a separate slot."),
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
  "For budget_transfer, use transfer_type='rnd' (AppFrm-039, default) or transfer_type='general' (AppFrm-053). " +
  "Required params per form_type: " +
  "leave: leave_type, start_date, end_date; " +
  "expense: budget_code, amount, reason; " +
  "working: budget_code, work_date, reason; " +
  "travel: title, destination, start_date, end_date; " +
  "travel_request: budget_code, title, destination, start_date, end_date; " +
  "budget_transfer: from_account, to_account, amount, reason; " +
  "card_expense: budget_code, amount, reason; " +
  "travel_settlement: budget_code, title, destination, start_date, end_date; " +
  "leave_return: leave_type, start_date, end_date; " +
  "seminar: title, date, location; " +
  "overseas_travel: budget_code, title, destination, start_date, end_date, purpose. " +
  "Error recovery: NOT_LOGGED_IN→call ipk_login first; FRAME_NOT_FOUND→call ipk_navigate first; " +
  "CONFIRMATION_REQUIRED→set draft_only=true for safe draft mode; SESSION_EXPIRING→re-login.";

/** Per-form navigation configuration for forms that need custom URL construction. */
interface FormNavConfig {
  /** If set, navigate to this URL directly (interpolated with params). */
  customUrl?: (params: Record<string, any>, config: Config) => string;
  /** Selector to wait for after navigation (default: "form input, form select"). */
  waitSelector?: string;
  /** Post-navigation wait in ms (default: 2000). */
  waitMs?: number;
  /** Pre-navigate validation (returns error message or null). */
  validate?: (params: Record<string, any>) => string | null;
}

/** Navigation overrides for forms that cannot use the standard navigateToForm path. */
const FORM_NAV_CONFIG: Partial<Record<string, FormNavConfig>> = {
  card_expense_rd: {
    validate: (params) =>
      !params.trseq || !params.appr_no
        ? "card_expense_rd requires trseq and appr_no (from corporation_card_list.php Make ER link)."
        : null,
    customUrl: (params, config) =>
      `${config.baseUrl}/Document/document_write.php?approve_type=AppFrm-021&mker=Y&trseq=${encodeURIComponent(params.trseq)}&appr_no=${encodeURIComponent(params.appr_no)}`,
    waitSelector: 'input[name="subject"]',
    waitMs: 2000,
  },
  budget_transfer: {
    customUrl: (params, config) => {
      const btCode = BUDGET_TRANSFER_CODES[params.transfer_type || "rnd"] || BUDGET_TRANSFER_CODES.rnd;
      return `${config.baseUrl}/Document/document_write.php?approve_type=${btCode}`;
    },
    waitSelector: "form input, form select",
    waitMs: 1500,
  },
};

/** Per-form submit handlers. Looked up by formType — no switch/if needed. */
type FormHandler = (
  page: any,
  frame: any,
  sessionManager: SessionManager,
  config: Config,
  params: Record<string, any>,
  mode: "draft" | "request"
) => Promise<any>;

const FORM_HANDLERS: Record<string, FormHandler> = {
  leave: submitLeave,
  expense: submitExpense,
  working: submitWorking,
  travel: submitTravel,
  travel_request: submitTravelRequest,
  card_expense: submitCardExpense,
  card_expense_rd: submitCardExpenseRD,
  travel_settlement: submitTravelSettlement,
  leave_return: submitLeaveReturn,
  seminar: submitSeminar,
  overseas_travel: submitOverseasTravel,
};

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
    // Validate and navigate using per-form config (or standard path)
    const navConfig = FORM_NAV_CONFIG[formType];
    let frame: any;

    if (navConfig) {
      // Validate required params for this form's nav
      if (navConfig.validate) {
        const validErr = navConfig.validate(params);
        if (validErr) {
          return textResult({ error: true, code: "MISSING_CARD_RECEIPT_REF", message: validErr });
        }
      }
      // Custom URL navigation
      const mainFrame = page.frame("main_menu");
      if (!mainFrame) {
        return textResult({ error: true, code: "FRAME_NOT_FOUND", message: "main_menu frame not found" });
      }
      const url = navConfig.customUrl!(params, config);
      await mainFrame.goto(url, { timeout: config.navTimeoutMs });
      await mainFrame.waitForLoadState("load");
      const waitSel = navConfig.waitSelector ?? "form input, form select";
      await mainFrame.waitForSelector(waitSel, { timeout: 5000 }).catch(() => null);
      sessionManager.touchActivity();
      await page.waitForTimeout(navConfig.waitMs ?? 2000);
      frame = mainFrame;
    } else {
      // Standard navigation
      frame = await navigateToForm(page, formType, config);
      if (!frame) {
        return textResult({ error: true, code: "NAVIGATION_FAILED", message: "Failed to navigate to form" });
      }
      sessionManager.touchActivity();
    }

    // Dispatch to per-form handler (or generic fallback)
    const handler = FORM_HANDLERS[formType];
    if (handler) {
      return await handler(page, frame, sessionManager, config, params, mode);
    }

    // Generic template-driven fallback for any unlisted form type
    const templateSchema = loadTemplateFieldSchema(formType);
    if (!templateSchema) {
      return textResult({ error: true, code: "UNKNOWN_FORM", message: `Unknown form type: ${formType}` });
    }
    return await submitGeneric(page, frame, sessionManager, config, params, mode, formType, templateSchema);

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
  const budgetType = params.budget_type || "01"; // General expense default
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
  const budgetType = params.budget_type || "02"; // IPK is R&D institute, "02" (R&D) is correct default
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
  const budgetType = params.budget_type || "02"; // IPK is R&D institute, "02" (R&D) is correct default
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

/** R&D Card Expense from Card Receipt (AppFrm-021, mker=Y mode)
 *
 * This form is opened from the IPK corporation_card_list.php page via a "Make ER"
 * link with `?approve_type=AppFrm-021&mker=Y&trseq={trseq}&appr_no={appr_no}`.
 * The system pre-fills budget_type, budget_code, payment, card number, invoice
 * date, item amounts (excl/VAT/total), and vendor (Korean) from the card receipt.
 *
 * The user must provide:
 *  - subject (English title)
 *  - item_name + seller_en (English vendor) for the row
 *  - p_reason (Notes / purpose)
 *  - account_code (or account_code_label for auto-pick from Sel_account popup)
 *  - At least 1 attachment_path (or attachment_paths array for multi-file)
 *
 * Submit flow uses the 2-stage budget_check_er popup orchestration via the
 * er-submit-helper module.
 *
 * Discovered: 2026-04-07 session probe (Google Cloud + RunPod ER drafts).
 */
async function submitCardExpenseRD(
  page: any,
  frame: any,
  _sessionManager: SessionManager,
  config: Config,
  params: Record<string, any>,
  mode: "draft" | "request"
) {
  // Helpers (lazy import to keep top of file lean)
  const accountHelper = await import("../internal/primitives/account.js");
  const attachmentHelper = await import("../internal/primitives/attachment.js");

  // Subject naming convention (kept short — form auto-prefixes "[Card]"):
  // Just "{Vendor} ({service}) usage fee" — no lab tag, no date, no amount.
  // Card receipt date and KRW amount are already shown in the form body.
  const subject = params.subject || params.title || "Card receipt";
  const itemName = params.item_name || "Card receipt item";
  const sellerEn = params.seller_en || params.item_vendor || "";
  const pReason = params.p_reason || params.reason || "";

  // Read prefilled values to confirm form loaded correctly
  const prefilled = await frame.evaluate(() => {
    const get = (n: string, idx = 0) => {
      const els = document.querySelectorAll(`[name="${n}"]`) as NodeListOf<HTMLInputElement>;
      return els[idx] ? els[idx].value : null;
    };
    return {
      budget_type: get("budget_type"),
      budget_code: get("budget_code"),
      amount: get("item_amount[]", 1),
      vender_kor: get("vender[]", 1),
    };
  });
  if (!prefilled.budget_code) {
    return textResult({
      error: true,
      code: "FORM_NOT_LOADED",
      message: "AppFrm-021 mker form did not prefill. Check trseq/appr_no values.",
    });
  }

  // Step 1: Fill user-discretion fields
  await frame.evaluate(
    (args: { subject: string; itemName: string; sellerEn: string; pReason: string }) => {
      const subjectEl = document.querySelector('input[name="subject"]') as HTMLInputElement | null;
      if (subjectEl) subjectEl.value = args.subject;
      const items = document.querySelectorAll('input[name="item_name[]"]') as NodeListOf<HTMLInputElement>;
      const qtys = document.querySelectorAll('input[name="item_qty[]"]') as NodeListOf<HTMLInputElement>;
      const sellers = document.querySelectorAll('input[name="seller[]"]') as NodeListOf<HTMLInputElement>;
      const itemDescs = document.querySelectorAll('input[name="item_desc[]"]') as NodeListOf<HTMLInputElement>;
      if (items[1]) items[1].value = args.itemName;
      if (qtys[1] && !qtys[1].value) qtys[1].value = "1";
      if (sellers[1]) sellers[1].value = args.sellerEn;
      if (itemDescs[1]) itemDescs[1].value = args.itemName;
      const pr = document.querySelectorAll('textarea[name="p_reason"]') as NodeListOf<HTMLTextAreaElement>;
      pr.forEach((t) => { t.value = args.pReason; });
    },
    { subject, itemName, sellerEn, pReason }
  );

  // Step 2: Resolve account code (explicit code wins, then label match, then default 410318)
  let accountSet = false;
  if (params.item_account_code) {
    // Explicit code provided — fetch full list to find matching seq, then inject
    const codes = await accountHelper.fetchAccountCodes(page as any, {
      baseUrl: config.baseUrl,
      budgetType: prefilled.budget_type || "02",
      budgetCode: prefilled.budget_code,
      approveType: "AppFrm-021",
    });
    const match = codes.find((c) => c.code === params.item_account_code);
    if (match) {
      // Inject directly into the iframe-frame's document
      await frame.evaluate(
        (args: { rowIdx: number; account: { seq: string; code: string; label: string } }) => {
          const acStr = document.getElementsByName("account_str[]") as NodeListOf<HTMLInputElement>;
          const acCode = document.getElementsByName("account_code[]") as NodeListOf<HTMLInputElement>;
          const acSeq = document.getElementsByName("account_seq[]") as NodeListOf<HTMLInputElement>;
          const msSeq = document.getElementsByName("milestone_seq[]") as NodeListOf<HTMLInputElement>;
          const msChk = document.getElementsByName("milestone_check") as NodeListOf<HTMLInputElement>;
          if (acStr[args.rowIdx]) acStr[args.rowIdx].value = `[${args.account.code}] ${args.account.label}`;
          if (acCode[args.rowIdx]) acCode[args.rowIdx].value = args.account.code;
          if (acSeq[args.rowIdx]) acSeq[args.rowIdx].value = args.account.seq;
          if (msSeq[args.rowIdx]) msSeq[args.rowIdx].value = "";
          if (msChk[args.rowIdx]) msChk[args.rowIdx].value = "-";
        },
        { rowIdx: 1, account: match }
      );
      accountSet = true;
    }
  }
  if (!accountSet && params.account_code_label) {
    const codes = await accountHelper.fetchAccountCodes(page as any, {
      baseUrl: config.baseUrl,
      budgetType: prefilled.budget_type || "02",
      budgetCode: prefilled.budget_code,
      approveType: "AppFrm-021",
    });
    const labelLower = String(params.account_code_label).toLowerCase();
    const match = codes.find((c) => c.label.toLowerCase().includes(labelLower));
    if (match) {
      await frame.evaluate(
        (args: { rowIdx: number; account: { seq: string; code: string; label: string } }) => {
          const acStr = document.getElementsByName("account_str[]") as NodeListOf<HTMLInputElement>;
          const acCode = document.getElementsByName("account_code[]") as NodeListOf<HTMLInputElement>;
          const acSeq = document.getElementsByName("account_seq[]") as NodeListOf<HTMLInputElement>;
          const msSeq = document.getElementsByName("milestone_seq[]") as NodeListOf<HTMLInputElement>;
          const msChk = document.getElementsByName("milestone_check") as NodeListOf<HTMLInputElement>;
          if (acStr[args.rowIdx]) acStr[args.rowIdx].value = `[${args.account.code}] ${args.account.label}`;
          if (acCode[args.rowIdx]) acCode[args.rowIdx].value = args.account.code;
          if (acSeq[args.rowIdx]) acSeq[args.rowIdx].value = args.account.seq;
          if (msSeq[args.rowIdx]) msSeq[args.rowIdx].value = "";
          if (msChk[args.rowIdx]) msChk[args.rowIdx].value = "-";
        },
        { rowIdx: 1, account: match }
      );
      accountSet = true;
    }
  }
  if (!accountSet) {
    return textResult({
      error: true,
      code: "ACCOUNT_CODE_REQUIRED",
      message: "card_expense_rd: provide item_account_code (e.g. '410318') or account_code_label (e.g. 'IT Software'). Use ipk_inspect_form or ./pr_account_sel.php to list valid codes for the budget.",
    });
  }

  // Step 3: Attach file(s)
  const filePaths: string[] = Array.isArray(params.attachment_paths)
    ? params.attachment_paths
    : params.attachment_path
      ? [params.attachment_path]
      : [];
  if (filePaths.length === 0) {
    return textResult({
      error: true,
      code: "ATTACHMENT_REQUIRED",
      message: "card_expense_rd requires at least one attachment_path or attachment_paths[]. The form alerts 'Please attach at least one file.' on submit.",
    });
  }
  // Set file_attach_cnt = N then upload N files into doc_attach_file[]
  const attachResult = await attachmentHelper.attachFiles(frame, filePaths);
  await page.waitForTimeout(500);

  // Step 4: 2-stage submit (Evidence Check modal bypass + budget_check_er popup orchestration)
  // We replicate the logic of er-submit-helper.submitERWithBudgetCheck but operate on the
  // iframe (frame) since the form lives inside main_menu.
  const popupHolder: { docId: string | null; finalUrl: string } = {
    docId: null,
    finalUrl: "",
  };
  const popupPromise = new Promise<void>((resolve) => {
    page.once("popup", async (pop: any) => {
      try {
        await pop.waitForLoadState("networkidle", { timeout: 15000 });
        await pop.waitForTimeout(1500);
        await pop.evaluate("submit_form()").catch(() => {});
        await pop.waitForTimeout(4000);
      } catch {
        // ignore
      } finally {
        resolve();
      }
    });
    setTimeout(resolve, 25000);
  });

  try {
    await frame.evaluate((mode1Val: string) => {
      const w = window as any;
      const doc = document as any;
      if (doc.all && doc.all("mode1")) doc.all("mode1").value = mode1Val;
      const form = doc.form1 as HTMLFormElement;
      if (!form) throw new Error("form1 not found");
      (form as any).mode.value = "insert";
      w.open("", "budget_frame", "width=940,height=400,top=100,left=100,resizable=0,scrollbars=1");
      (form as any).target = "budget_frame";
      (form as any).action = "./budget_check_er.php";
      form.submit();
    }, mode === "draft" ? "draft" : "");
  } catch (err) {
    return textResult({
      error: true,
      code: "SUBMIT_FAILED",
      message: `card_expense_rd submit trigger failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  await popupPromise;
  await page.waitForTimeout(2000);
  try {
    await page.waitForLoadState("networkidle", { timeout: 10000 });
  } catch {
    // navigation may have already settled
  }

  // After submit, frame URL should be document_view.php?doc_id=...
  popupHolder.finalUrl = (frame.url && typeof frame.url === "function") ? frame.url() : page.url();
  const m = popupHolder.finalUrl.match(/[?&]doc_id=(\d+)/);
  popupHolder.docId = m ? m[1] : null;

  // Mark _sessionManager as intentionally unused for tsc strictness
  void _sessionManager;

  return textResult({
    error: false,
    data: {
      success: popupHolder.docId !== null,
      docId: popupHolder.docId,
      mode,
      formType: "card_expense_rd",
      subject,
      finalUrl: popupHolder.finalUrl,
      attached: attachResult.attached,
      skipped_attachments: attachResult.skipped,
      message: popupHolder.docId
        ? `R&D card ER ${mode === "draft" ? "draft saved" : "submitted"} (doc_id: ${popupHolder.docId}, ${attachResult.attached}/${filePaths.length} files attached)`
        : `R&D card ER ${mode} attempted but doc_id not found in URL — check Drafts manually`,
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
    const budgetType = params.budget_type || "02"; // IPK is R&D institute, "02" (R&D) is correct default

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
    await setSelectValue(frame, 'select[name="budget_type"]', "01"); // General expense default
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

/** Generic template-driven form handler for any form with a field_schema template */
async function submitGeneric(
  page: any,
  frame: any,
  sessionManager: SessionManager,
  config: Config,
  params: Record<string, any>,
  mode: "draft" | "request",
  formType: string,
  templateSchema: Record<string, TemplateFieldSchema>
) {
  // Build userData from params, mapping template field keys to user-supplied values
  const userData: Record<string, any> = {};
  for (const fieldKey of Object.keys(templateSchema)) {
    if (params[fieldKey] !== undefined) {
      userData[fieldKey] = params[fieldKey];
    }
  }

  // Auto-set subject if template has it and user provided title
  if (templateSchema.subject && !userData.subject && params.title) {
    userData.subject = params.title;
  }

  // Handle AJAX cascade if template defines ajax_cascade_sequence
  // (cascade fields need to be set sequentially, not via genericFillForm)
  // For now, rely on genericFillForm which handles simple fields

  await genericFillForm(frame, templateSchema, userData);

  // Handle attachment if provided
  if (params.attachment_path) {
    const validationError = validateAttachmentPath(params.attachment_path);
    if (validationError) {
      return textResult({ error: true, code: "INVALID_ATTACHMENT", message: validationError });
    }
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
      formType,
      message: docId
        ? `${formType} ${mode === "draft" ? "draft saved" : "submitted"} (doc_id: ${docId})`
        : `${formType} ${mode} completed`,
      note: "Filled via generic template handler. Verify form completeness via screenshot.",
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

