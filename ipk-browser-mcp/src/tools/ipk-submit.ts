import { z } from "zod";
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
} from "../browser/iframe-helper.js";
import {
  Config,
  FormType,
  LEAVE_TYPES,
  LEAVE_NAMES,
  ATTACHMENT_REQUIRED_LEAVES,
  BUDGET_TRANSFER_CODES,
} from "../types.js";
import * as path from "path";

/** Allowed directories for attachment file uploads. Prevents arbitrary file reads. */
const ALLOWED_ATTACHMENT_DIRS = [
  "/tmp",
  `${process.env.HOME}/Downloads`,
  `${process.env.HOME}/Documents`,
  `${process.env.HOME}/Desktop`,
];

/** Validate that an attachment path is safe to upload. */
function validateAttachmentPath(filePath: string): string | null {
  const resolved = path.resolve(filePath);
  // Block path traversal
  if (resolved !== filePath && filePath.includes("..")) {
    return "Attachment path contains path traversal (..)";
  }
  // Block dotfiles and sensitive directories
  if (/\/\./.test(resolved)) {
    return "Attachment path points to a hidden file/directory";
  }
  // Block system directories
  if (resolved.startsWith("/etc") || resolved.startsWith("/proc") || resolved.startsWith("/sys")) {
    return "Attachment path points to a system directory";
  }
  // Must be in an allowed directory
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
      await mainFrame.waitForLoadState("networkidle");
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

  // Set all form fields via parameterized evaluate (required fields throw on miss)
  await setRequiredSelect(frame, 'select[name="leave_kind[]"]', leaveCode, "leave_kind");
  await setRequiredSelect(frame, 'select[name="using_type[]"]', usingType, "using_type");
  await setRequiredField(frame, 'input[name="begin_date[]"]', startDate, "begin_date");
  await setRequiredField(frame, 'input[name="end_date[]"]', endDate, "end_date");

  if (isHourly) {
    // Set start_time dropdown
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

    // Set end_time dropdown after start_time change has settled
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

  await setFieldValue(frame, 'input[name="purpose"]', purpose);
  await setFieldValue(frame, 'input[name="destination"]', destination);
  await setFieldValue(frame, 'input[name="emergency_address"]', process.env.IPK_EMERGENCY_ADDRESS || "Seoul");
  await setFieldValue(frame, 'input[name="emergency_telephone"]', process.env.IPK_EMERGENCY_TELEPHONE || "N/A");

  // Set subject last to avoid being overwritten by change events
  await setFieldValue(frame, 'input[name="subject"]', subject);

  // Handle substitute selection via popup
  try {
    const [popup] = await Promise.all([
      page.waitForEvent("popup", { timeout: 10000 }),
      frame.evaluate(() => {
        (window as any).fnWinOpen("./user_select.php?sel_type=radio");
      }),
    ]);

    await popup.waitForLoadState("networkidle");
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

  // Step 1: Set subject and budget_type (required)
  await setRequiredField(frame, 'input[name="subject"]', subject, "subject");
  await setRequiredSelect(frame, 'select[name="budget_type"]', budgetType, "budget_type");
  await page.waitForTimeout(1000);

  // Step 2: Set remaining fields (required)
  await setRequiredSelect(frame, 'select[name="budget_code"]', budgetCode, "budget_code");
  await setRequiredSelect(frame, 'select[name="pay_kind"]', "04", "pay_kind");
  await setRequiredField(frame, 'textarea[name="p_reason"]', pReason, "p_reason");
  await setRequiredField(frame, 'input[name="invoice[]"]', date, "invoice");
  await setRequiredField(frame, 'input[name="item_desc[]"]', itemName, "item_desc");
  await setFieldValue(frame, 'input[name="item_qty[]"]', "1");
  await setFieldValue(frame, 'input[name="item_amount[]"]', String(amountNoVat));
  await setFieldValue(frame, 'input[name="item_amount_vat[]"]', String(vat));
  await setFieldValue(frame, 'input[name="ov_member"]', participants);
  await setFieldValue(frame, 'input[name="ov_purpose"]', purpose);

  // Set totals
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

  // Step 1: Set subject and budget_type (required)
  await setRequiredField(frame, 'input[name="subject"]', subject, "subject");
  await setRequiredSelect(frame, 'select[name="budget_type"]', budgetType, "budget_type");
  await page.waitForTimeout(1000);

  // Step 2: Set remaining fields (required)
  await setRequiredSelect(frame, 'select[name="budget_code"]', budgetCode, "budget_code");
  await setRequiredField(frame, 'input[name="desired_date"]', workDate, "desired_date");
  await setRequiredField(frame, 'input[name="wroking_place"]', workPlace, "wroking_place"); // Note: typo is in the original groupware
  await setRequiredField(frame, 'input[name="sub_subject"]', reason, "sub_subject");
  await setFieldValue(frame, 'textarea[name="contents1"]', details);

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

  await setRequiredField(frame, 'input[name="subject"]', title, "subject");
  await setRequiredField(frame, '.validate[name="report_date"]', reportDate, "report_date");
  await setRequiredField(frame, '.validate[name="report_name"]', userInfo.name, "report_name");
  await setFieldValue(frame, '.validate[name="report_post"]', reportPost);
  await setFieldValue(frame, '.validate[name="report_group"]', userDept);
  await setFieldValue(frame, '.validate[name="report_leader"]', reportLeader);
  await setRequiredField(frame, '.validate[name="start_day"]', startDate, "start_day");
  await setRequiredField(frame, '.validate[name="end_day"]', endDate, "end_day");
  await setRequiredField(frame, '.validate[name="report_dest"]', destination, "report_dest");
  await setRequiredField(frame, '.validate[name="purpose_field"]', purpose, "purpose_field");
  await setFieldValue(frame, '.validate[name="date_field"]', schedule);
  await setFieldValue(frame, '.validate[name="org_field"]', organization);
  await setFieldValue(frame, '.validate[name="person_field"]', attendees);
  await setFieldValue(frame, '.validate[name="discuss_field"]', params.details || purpose);
  await setFieldValue(frame, '.validate[name="agenda_field"]', params.schedule || purpose);
  await setFieldValue(frame, '.validate[name="result_field"]', params.reason || `Expected outcomes: ${purpose}`);
  await setFieldValue(frame, '.validate[name="other_field"]', "N/A");
  await setFieldValue(frame, '.validate[name="conclusion_field"]', params.destination ? `${purpose} at ${destination}` : `Travel for ${purpose}`);

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

  // Set common fields (required)
  await setRequiredField(frame, 'input[name="subject"]', subject, "subject");

  // Try budget fields (may exist on travel request forms)
  await setSelectValue(frame, 'select[name="budget_type"]', budgetType);
  await page.waitForTimeout(1000);
  await setSelectValue(frame, 'select[name="budget_code"]', budgetCode);

  // Travel-specific fields - try various selectors that might exist
  await setFieldValue(frame, 'input[name="start_day"]', startDate);
  await setFieldValue(frame, 'input[name="end_day"]', endDate);
  await setFieldValue(frame, '.validate[name="start_day"]', startDate);
  await setFieldValue(frame, '.validate[name="end_day"]', endDate);
  await setFieldValue(frame, 'input[name="destination"]', destination);
  await setFieldValue(frame, 'textarea[name="destination"]', destination);
  await setFieldValue(frame, '.validate[name="report_dest"]', destination);
  await setFieldValue(frame, 'input[name="purpose"]', purpose);
  await setFieldValue(frame, 'textarea[name="purpose"]', purpose);
  await setFieldValue(frame, '.validate[name="purpose_field"]', purpose);

  // Organization and attendees
  if (params.organization) {
    await setFieldValue(frame, '.validate[name="org_field"]', params.organization);
    await setFieldValue(frame, 'input[name="organization"]', params.organization);
  }
  if (params.attendees) {
    await setFieldValue(frame, '.validate[name="person_field"]', params.attendees);
    await setFieldValue(frame, 'input[name="attendees"]', params.attendees);
  }
  if (params.schedule) {
    await setFieldValue(frame, '.validate[name="date_field"]', params.schedule);
  }
  if (params.details) {
    await setFieldValue(frame, 'textarea[name="contents1"]', params.details);
    await setFieldValue(frame, '.validate[name="discuss_field"]', params.details);
  }

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

  // Set subject (required)
  await setRequiredField(frame, 'input[name="subject"]', subject, "subject");

  // Try budget type selection
  if (transferType === "rnd") {
    await setSelectValue(frame, 'select[name="budget_type"]', "02");
  } else {
    await setSelectValue(frame, 'select[name="budget_type"]', "01");
  }
  await page.waitForTimeout(1000);

  // Source budget code - try various common selectors
  if (fromBudget) {
    await setSelectValue(frame, 'select[name="budget_code"]', fromBudget);
    await setSelectValue(frame, 'select[name="from_budget_code"]', fromBudget);
    await setSelectValue(frame, 'select[name="budget_code_from"]', fromBudget);
    await setFieldValue(frame, 'input[name="from_budget"]', fromBudget);
    await setFieldValue(frame, 'input[name="budget_code_from"]', fromBudget);
  }

  // Destination budget code - try various common selectors
  if (toBudget) {
    await setSelectValue(frame, 'select[name="to_budget_code"]', toBudget);
    await setSelectValue(frame, 'select[name="budget_code_to"]', toBudget);
    await setFieldValue(frame, 'input[name="to_budget"]', toBudget);
    await setFieldValue(frame, 'input[name="budget_code_to"]', toBudget);
  }

  // Amount
  if (amount) {
    await setFieldValue(frame, 'input[name="amount"]', String(amount));
    await setFieldValue(frame, 'input[name="transfer_amount"]', String(amount));
    await setFieldValue(frame, 'input[name="item_amount[]"]', String(amount));
    await setFieldValue(frame, 'input[name="total_amt"]', String(amount));
  }

  // Reason/purpose
  await setFieldValue(frame, 'textarea[name="reason"]', reason);
  await setFieldValue(frame, 'textarea[name="p_reason"]', reason);
  await setFieldValue(frame, 'textarea[name="contents1"]', reason);
  await setFieldValue(frame, 'input[name="sub_subject"]', reason);

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

  // Step 1: Set subject and budget_type
  await setRequiredField(frame, 'input[name="subject"]', subject, "subject");
  await setRequiredSelect(frame, 'select[name="budget_type"]', "02", "budget_type");
  await page.waitForTimeout(1000);

  // Step 2: Set budget code and payment method
  await setRequiredSelect(frame, 'select[name="budget_code"]', budgetCode, "budget_code");
  await setRequiredSelect(frame, 'select[name="pay_kind"]', "04", "pay_kind"); // 04 = Corp Card

  // Card number (try to set if available)
  const cardNo = params.corp_card_no || process.env.IPK_CORP_CARD_NO || "";
  if (cardNo) {
    await setFieldValue(frame, 'input[name="card_no"]', cardNo);
  }

  // Step 3: Expense line items
  await setRequiredField(frame, 'textarea[name="p_reason"]', pReason, "p_reason");
  await setRequiredField(frame, 'input[name="invoice[]"]', date, "invoice");
  await setRequiredField(frame, 'input[name="item_desc[]"]', itemDesc, "item_desc");
  await setFieldValue(frame, 'input[name="item_qty[]"]', "1");
  await setFieldValue(frame, 'input[name="item_amount[]"]', String(amountNoVat));
  await setFieldValue(frame, 'input[name="item_amount_vat[]"]', String(vat));

  // Account code selection
  await setSelectValue(frame, 'select[name="item_account_code[]"]', accountCode);

  // Vendor and control number
  if (vendor) await setFieldValue(frame, 'input[name="item_vendor[]"]', vendor);
  if (controlNo) await setFieldValue(frame, 'input[name="item_control_no[]"]', controlNo);

  // Meeting info fields
  await setFieldValue(frame, 'input[name="ov_member"]', participants);
  await setFieldValue(frame, 'input[name="ov_purpose"]', purposeMinutes);
  if (venue) await setFieldValue(frame, 'input[name="ov_place"]', venue);

  // Set totals
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

/** Travel Settlement (AppFrm-054) — domestic travel expense settlement */
async function submitTravelSettlement(
  page: any,
  frame: any,
  sessionManager: SessionManager,
  config: Config,
  params: Record<string, any>,
  mode: "draft" | "request"
) {
  const userInfo = sessionManager.getUserInfo()!;
  const startDate = params.start_date || todayStr();
  const endDate = params.end_date || startDate;
  const destination = params.destination || "";
  const purpose = params.purpose || "Business travel";
  const subject = params.title || `[Settlement] ${purpose}`;
  const budgetControlNo = params.budget_control_no || "";
  const approvedDocRef = params.approved_doc_ref || "";
  const purposeCategory = params.purpose_category || "Participation in the conference/seminar";

  // Calculate nights and daily expense
  const startD = new Date(startDate);
  const endD = new Date(endDate);
  const nights = Math.max(0, Math.round((endD.getTime() - startD.getTime()) / 86400000));
  const dailyExpense = params.daily_expense || (nights === 0 ? 20000 : 30000 * nights);
  const transportFee = params.transport_fee || 0;
  const accommodationFee = params.accommodation || 0;
  const foodExpense = params.food_expense || 0;

  // Budget type
  const budgetType = params.budget_type || "02"; // R&D default

  // Set subject
  await setRequiredField(frame, 'input[name="subject"]', subject, "subject");

  // Traveler info
  await setFieldValue(frame, '.validate[name="report_name"]', userInfo.name);
  await setFieldValue(frame, '.validate[name="report_date"]', todayStr());

  // Dates
  await setRequiredField(frame, 'input[name="start_day"]', startDate, "start_day");
  await setRequiredField(frame, 'input[name="end_day"]', endDate, "end_day");
  // Also try .validate selectors (form variants)
  await setFieldValue(frame, '.validate[name="start_day"]', startDate);
  await setFieldValue(frame, '.validate[name="end_day"]', endDate);

  // Start/end times for day trips
  if (params.start_time) await setFieldValue(frame, 'input[name="start_time"]', params.start_time);
  if (params.end_time) await setFieldValue(frame, 'input[name="end_time"]', params.end_time);

  // Purpose category
  await setSelectValue(frame, 'select[name="purpose_category"]', purposeCategory);
  await setFieldValue(frame, 'textarea[name="purpose"]', purpose);
  await setFieldValue(frame, '.validate[name="purpose_field"]', purpose);

  // Destination
  await setFieldValue(frame, 'input[name="destination"]', destination);
  await setFieldValue(frame, '.validate[name="report_dest"]', destination);

  // AJAX cascade: province → city → transport_mode
  if (params.province) {
    await setSelectValue(frame, 'select[name="province"]', params.province);
    await page.waitForTimeout(2000); // Wait for city AJAX
  }
  if (params.city) {
    await setSelectValue(frame, 'select[name="city"]', params.city);
    await page.waitForTimeout(2000); // Wait for transport AJAX
  }
  if (params.transport_mode) {
    await setSelectValue(frame, 'select[name="transport_mode"]', params.transport_mode);
    await page.waitForTimeout(1000);
  }

  // Budget type → code cascade
  await setSelectValue(frame, 'select[name="budget_type"]', budgetType);
  await page.waitForTimeout(2000);
  if (params.budget_code) {
    await setSelectValue(frame, 'select[name="budget_code"]', params.budget_code);
    await page.waitForTimeout(1500);
  }

  // Budget control number
  if (budgetControlNo) {
    await setFieldValue(frame, 'input[name="budget_control_no"]', budgetControlNo);
    await setFieldValue(frame, '.validate[name="budget_control_no"]', budgetControlNo);
  }

  // Expense amounts
  await setFieldValue(frame, 'input[name="daily_expense"]', String(dailyExpense));
  if (transportFee) await setFieldValue(frame, 'input[name="transport_fee"]', String(transportFee));
  if (accommodationFee) await setFieldValue(frame, 'input[name="accommodation"]', String(accommodationFee));
  if (foodExpense) await setFieldValue(frame, 'input[name="food_expense"]', String(foodExpense));

  // Own vehicle fields
  if (params.oil_price) await setFieldValue(frame, 'input[name="oil_price"]', String(params.oil_price));
  if (params.distance_km) await setFieldValue(frame, 'input[name="distance_km"]', String(params.distance_km));
  if (params.toll_fee) await setFieldValue(frame, 'input[name="toll"]', String(params.toll_fee));

  // Own car cost = oil_price * distance_km / 10
  if (params.oil_price && params.distance_km) {
    const ownCarCost = Math.round(params.oil_price * params.distance_km / 10);
    await setFieldValue(frame, 'input[name="own_car"]', String(ownCarCost));
  }

  // Approved doc reference
  if (approvedDocRef) {
    await setFieldValue(frame, 'input[name="approved_doc_ref"]', approvedDocRef);
    await setFieldValue(frame, '.validate[name="approved_doc_ref"]', approvedDocRef);
  }

  // Invitation field (default: No)
  await setSelectValue(frame, 'select[name="travel_with_invitation"]', "No");

  // Handle attachment
  if (params.attachment_path) {
    const fileInput = frame.locator('input[name="doc_attach_file[]"]').first();
    await fileInput.setInputFiles(params.attachment_path);
    await page.waitForTimeout(1000);
  }

  await page.waitForTimeout(1000);
  await setFormMode(frame, mode);
  const docId = await submitForm(page, frame, "check_form_request");

  const warnings: string[] = [];
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

  // Set form fields
  await setRequiredField(frame, 'input[name="subject"]', subject, "subject");
  await setFieldValue(frame, 'input[name="original_leave_doc"]', originalDoc);
  await setFieldValue(frame, '.validate[name="original_leave_doc"]', originalDoc);

  // Leave type selection
  await setSelectValue(frame, 'select[name="leave_kind"]', leaveCode);
  await setSelectValue(frame, 'select[name="leave_kind[]"]', leaveCode);

  // Period
  await setRequiredField(frame, 'input[name="begin_date"]', periodStart, "begin_date");
  await setFieldValue(frame, 'input[name="begin_date[]"]', periodStart);
  await setRequiredField(frame, 'input[name="end_date"]', periodEnd, "end_date");
  await setFieldValue(frame, 'input[name="end_date[]"]', periodEnd);

  // Return days/hours
  await setFieldValue(frame, 'input[name="return_days"]', String(returnDays));
  await setFieldValue(frame, 'input[name="return_hours"]', String(returnHours));

  // Description
  await setFieldValue(frame, 'textarea[name="description"]', description);
  await setFieldValue(frame, 'textarea[name="contents1"]', description);

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

  // Set form fields
  await setRequiredField(frame, 'input[name="subject"]', subject, "subject");
  await setFieldValue(frame, 'input[name="requester"]', requester);
  await setFieldValue(frame, '.validate[name="requester"]', requester);

  // Section 1: Purpose
  await setFieldValue(frame, 'textarea[name="disclosure_purpose"]', disclosurePurpose);
  await setFieldValue(frame, '.validate[name="purpose_field"]', disclosurePurpose);

  // Section 2: Date
  await setFieldValue(frame, 'input[name="disclosure_date"]', disclosureDate);
  await setFieldValue(frame, '.validate[name="disclosure_date"]', disclosureDate);

  // Section 3: Material description
  await setFieldValue(frame, 'input[name="material_description"]', materialDesc);
  await setFieldValue(frame, '.validate[name="material_description"]', materialDesc);

  // Section 4: Conference or journal
  await setFieldValue(frame, 'input[name="conference_or_journal"]', conferenceOrJournal);
  await setFieldValue(frame, '.validate[name="conference_or_journal"]', conferenceOrJournal);

  // Radio Q&A fields (Q1-Q5) via parameterized evaluate
  const radioValues: Record<string, string> = {
    patent_filed: params.patent_filed || "",
    patent_planned: params.patent_planned || "",
    material_published: params.material_published || "N",
    collaborator_approval: params.collaborator_approval || "Y",
    contains_confidential: params.contains_confidential || "N",
  };

  await frame.evaluate(
    (rv: Record<string, string>) => {
      // Map param names to radio group names/indices in the form
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
        // Try multiple selector patterns for radio buttons
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
  await frame.evaluate(() => {
    const chk = document.querySelector('input[name="chk410306"]') as HTMLInputElement
      || document.querySelector('input[type="checkbox"][name*="chk"]') as HTMLInputElement;
    if (chk && !chk.checked) {
      chk.checked = true;
      chk.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });

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

  // Set basic fields
  await setRequiredField(frame, 'input[name="subject"]', subject, "subject");

  // Traveler info
  const payrollId = process.env.IPK_PAYROLL_ID || "";
  const travelerStr = payrollId ? `${userInfo.name}(${payrollId})` : userInfo.name;
  await setFieldValue(frame, 'input[name="traveler"]', travelerStr);
  await setFieldValue(frame, '.validate[name="traveler"]', travelerStr);

  // Budget control number
  if (budgetControlNo) {
    await setFieldValue(frame, 'input[name="budget_control_no"]', budgetControlNo);
    await setFieldValue(frame, '.validate[name="budget_control_no"]', budgetControlNo);
  }

  // Country and conference
  await setFieldValue(frame, 'input[name="country"]', country);
  await setFieldValue(frame, '.validate[name="country"]', country);
  await setFieldValue(frame, 'input[name="conference_name"]', conferenceName);
  await setFieldValue(frame, '.validate[name="conference_name"]', conferenceName);

  // Purpose
  await setFieldValue(frame, 'textarea[name="purpose"]', purpose);
  await setFieldValue(frame, '.validate[name="purpose_field"]', purpose);

  // Travel with invitation (default: No), Car rent (default: No)
  await frame.evaluate(() => {
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

  // Dates
  await setFieldValue(frame, 'input[name="travel_start"]', travelStart);
  await setFieldValue(frame, '.validate[name="travel_start"]', travelStart);
  await setFieldValue(frame, 'input[name="travel_end"]', travelEnd);
  await setFieldValue(frame, '.validate[name="travel_end"]', travelEnd);
  await setFieldValue(frame, 'input[name="payment_date"]', paymentDate);
  await setFieldValue(frame, '.validate[name="payment_date"]', paymentDate);

  // Schedule rows (daily itinerary)
  if (params.schedule_rows && Array.isArray(params.schedule_rows)) {
    await frame.evaluate(
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

  // Budget account code
  if (params.budget_code) {
    await setSelectValue(frame, 'select[name="budget_type"]', "02"); // R&D
    await page.waitForTimeout(2000);
    await setSelectValue(frame, 'select[name="budget_code"]', params.budget_code);
    await page.waitForTimeout(1500);
  }

  // Corp card number
  if (corpCardNo) {
    await setFieldValue(frame, 'input[name="corp_card_no"]', corpCardNo);
    await setFieldValue(frame, '.validate[name="corp_card_no"]', corpCardNo);
  }

  // Expense categories: transport, daily, accommodation, food, misc
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
      await setFieldValue(frame, `input[name="${fieldName}"]`, String(value));
      await setFieldValue(frame, `.validate[name="${fieldName}"]`, String(value));
    }
  }

  // Business materials description
  if (params.material_description) {
    await setFieldValue(frame, 'input[name="business_materials"]', params.material_description);
    await setFieldValue(frame, '.validate[name="business_materials"]', params.material_description);
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

