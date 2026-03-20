import { z } from "zod";
import { SessionManager } from "../browser/session.js";
import { textResult } from "../util.js";
import {
  navigateToForm,
  setFieldValue,
  setSelectValue,
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

export const ipkSubmitFormSchema = {
  form_type: z.enum(["leave", "expense", "working", "travel", "travel_request", "budget_transfer"]).describe("Form type to submit"),
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
  budget_code: z.string().optional().describe("Budget code (e.g. NN2512-0001)"),
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
};

export const ipkSubmitFormDescription =
  "Submit a form in IPK groupware. Supports: leave (휴가), expense (경비), working (휴일근무), travel (출장보고), travel_request (출장신청), budget_transfer (버젯트랜스퍼). " +
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

  const mode = params.draft_only !== false ? "draft" : "request";

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
      await page.waitForTimeout(1500);
      return await submitBudgetTransfer(page, mainFrame, sessionManager, config, params, mode);
    }

    const frame = await navigateToForm(page, formType, config);
    if (!frame) {
      return textResult({ error: true, code: "NAVIGATION_FAILED", message: "Failed to navigate to form" });
    }

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

  // Set all form fields via parameterized evaluate
  await setSelectValue(frame, 'select[name="leave_kind[]"]', leaveCode);
  await setSelectValue(frame, 'select[name="using_type[]"]', usingType);
  await setFieldValue(frame, 'input[name="begin_date[]"]', startDate);
  await setFieldValue(frame, 'input[name="end_date[]"]', endDate);

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
  const budgetCode = params.budget_code || "NN2512-0001";
  const participants = params.participants || "";
  const purpose = params.purpose || "overtime work";
  const pReason = params.reason || `${itemName} - receipt attached`;

  // Step 1: Set subject and budget_type
  await setFieldValue(frame, 'input[name="subject"]', subject);
  await setSelectValue(frame, 'select[name="budget_type"]', budgetType);
  await page.waitForTimeout(1000);

  // Step 2: Set remaining fields
  await setSelectValue(frame, 'select[name="budget_code"]', budgetCode);
  await setSelectValue(frame, 'select[name="pay_kind"]', "04");
  await setFieldValue(frame, 'textarea[name="p_reason"]', pReason);
  await setFieldValue(frame, 'input[name="invoice[]"]', date);
  await setFieldValue(frame, 'input[name="item_desc[]"]', itemName);
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
  const budgetCode = params.budget_code || "NN2512-0001";

  const subject = `Application for Working on ${workDate}, ${userInfo.name}`;

  // Step 1: Set subject and budget_type
  await setFieldValue(frame, 'input[name="subject"]', subject);
  await setSelectValue(frame, 'select[name="budget_type"]', budgetType);
  await page.waitForTimeout(1000);

  // Step 2: Set remaining fields
  await setSelectValue(frame, 'select[name="budget_code"]', budgetCode);
  await setFieldValue(frame, 'input[name="desired_date"]', workDate);
  await setFieldValue(frame, 'input[name="wroking_place"]', workPlace); // Note: typo is in the original groupware
  await setFieldValue(frame, 'input[name="sub_subject"]', reason);
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

  await setFieldValue(frame, 'input[name="subject"]', title);
  await setFieldValue(frame, '.validate[name="report_date"]', reportDate);
  await setFieldValue(frame, '.validate[name="report_name"]', userInfo.name);
  await setFieldValue(frame, '.validate[name="report_post"]', reportPost);
  await setFieldValue(frame, '.validate[name="report_group"]', userDept);
  await setFieldValue(frame, '.validate[name="report_leader"]', reportLeader);
  await setFieldValue(frame, '.validate[name="start_day"]', startDate);
  await setFieldValue(frame, '.validate[name="end_day"]', endDate);
  await setFieldValue(frame, '.validate[name="report_dest"]', destination);
  await setFieldValue(frame, '.validate[name="purpose_field"]', purpose);
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
  const budgetCode = params.budget_code || "NN2512-0001";

  const subject = `[Request] ${title}`;

  // Set common fields
  await setFieldValue(frame, 'input[name="subject"]', subject);

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

  // Set subject
  await setFieldValue(frame, 'input[name="subject"]', subject);

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

