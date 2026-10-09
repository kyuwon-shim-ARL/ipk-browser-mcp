/**
 * Domestic travel report (project_domestic_travel_report_endpoint.md, confirmed live
 * 2026-10-09): a domestic report is NOT a standalone document. It is written onto the
 * already-approved AppFrm-023 request at
 *   travel_report_write.php?doc_id=<approved request's doc_id>&approve_type=AppFrm-023&pop=Y
 * which has its own field set - report_date/report_name/report_post/report_group/
 * report_leader/report_dest(inherited, read-only text)/purpose_field/date_field/
 * org_field/person_field/discuss_field/agenda_field/result_field/other_field/
 * conclusion_field/gift_p/gift_r - and NO subject, start_day/end_day or pdoc_id: the
 * trip period and destination are inherited as static text from the request, not form
 * inputs. Its only save control (confirmed live) is `[ Draft ]` -> `Check_Form('D')`;
 * no final-submit button was present on the page actually inspected.
 *
 * AppFrm-076 (document_write.php?approve_type=AppFrm-076) is a different, standalone
 * form with subject/pdoc_id/start_day/end_day plus the same report_* fields - used only
 * for an explicit overseas report (report_kind: "overseas", or when the linked request
 * turns out to be AppFrm-026).
 */

export interface ApprovedTravelRequestMatch {
  docId: string;
  formCode: "AppFrm-023" | "AppFrm-026";
}

export interface ApprovedTravelRequestLookupError {
  error: string;
  candidates: number;
}

/** The report's own content fields (not the person's static info fields report_date/
 *  report_name/report_post/report_group/report_leader) - whether all of these are blank
 *  is what "this request has no report yet" means. Checked both by the overwrite guard
 *  (submitDomesticTravelReport) and by the auto-lookup's empty-report preference below. */
export const REPORT_CONTENT_FIELDS = ["purpose_field", "agenda_field", "result_field", "discuss_field", "conclusion_field"] as const;

/** Pure: true when every report content field is blank (nothing was ever written here). */
export function reportIsEmpty(fields: Record<string, string>): boolean {
  return REPORT_CONTENT_FIELDS.every((k) => !(fields[k] ?? "").trim());
}

/** Read the report content fields off the currently-loaded travel_report_write.php page -
 *  used both to decide "is this a candidate worth auto-picking" and, right before filling,
 *  "would this overwrite an existing report". */
export async function readReportContentFields(frame: any): Promise<Record<string, string>> {
  return frame.evaluate((names: string[]) => {
    const out: Record<string, string> = {};
    for (let i = 0; i < names.length; i++) {
      const el = document.querySelector(`[name="${names[i]}"]`) as HTMLInputElement | HTMLTextAreaElement | null;
      out[names[i]] = el ? el.value : "";
    }
    return out;
  }, REPORT_CONTENT_FIELDS as unknown as string[]);
}

/**
 * Pure: given the approved-documents list page's doc_id links (hrefs, already narrowed
 * to candidates worth considering - e.g. by readReportContentFields/reportIsEmpty
 * upstream), pick the one approved travel request (AppFrm-023 or AppFrm-026) among them.
 * Never guesses between several - "never ask for a groupware-queryable value" means
 * auto-lookup when it resolves to exactly one match, not when it doesn't.
 */
export function pickApprovedTravelRequest(hrefs: string[]): ApprovedTravelRequestMatch | ApprovedTravelRequestLookupError {
  const relevant = hrefs.filter((h) => /approve_type=AppFrm-023\b/.test(h) || /approve_type=AppFrm-026\b/.test(h));
  if (relevant.length === 0) {
    return { error: "no approved travel request found for this person in the lookup window", candidates: 0 };
  }
  if (relevant.length > 1) {
    return { error: `${relevant.length} approved travel requests matched - pass request_doc_id explicitly to pick one`, candidates: relevant.length };
  }
  const href = relevant[0];
  const docId = (href.match(/doc_id=(\d+)/) ?? [])[1];
  if (!docId) {
    return { error: "matched one approved travel request but could not read its doc_id from the link", candidates: 1 };
  }
  const formCode = /approve_type=AppFrm-026\b/.test(href) ? "AppFrm-026" : "AppFrm-023";
  return { docId, formCode };
}

/**
 * Network: search this person's own approved travel requests (type=approved - own docs
 * only, per CLAUDE.md's ER search table), prefer one (AppFrm-023) whose report is still
 * empty - never silently pick a request to overwrite - and resolve to the one match via
 * pickApprovedTravelRequest. An AppFrm-026 (overseas) candidate is not emptiness-checked
 * here (that form's own overwrite behaviour is unchanged/out of scope); it is still
 * offered as a candidate.
 */
export async function findOwnApprovedTravelRequest(
  page: any,
  opts: { baseUrl: string; keyword?: string; sinceDays?: number }
): Promise<ApprovedTravelRequestMatch | ApprovedTravelRequestLookupError> {
  const origin = new URL(opts.baseUrl).origin;
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  const e = new Date();
  const s = new Date(e.getTime() - (opts.sinceDays ?? 365) * 86400000);
  const listUrl =
    `${origin}/Document/document_list.php?type=approved&s_date=${ymd(s)}&e_date=${ymd(e)}` +
    `&keyword=${encodeURIComponent(opts.keyword ?? "")}&writer=Y&title=Y&contents=Y&attachment=Y`;
  await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1500);
  const hrefs: string[] = await page.mainFrame().$$eval("a[href*='doc_id=']", (as: any[]) => as.map((a: any) => a.getAttribute("href") || ""));
  const relevant = hrefs.filter((h) => /approve_type=AppFrm-023\b/.test(h) || /approve_type=AppFrm-026\b/.test(h));
  if (relevant.length === 0) {
    return { error: "no approved travel request found for this person in the lookup window", candidates: 0 };
  }

  const withEmptyReport: string[] = [];
  for (const href of relevant) {
    if (/approve_type=AppFrm-026\b/.test(href)) {
      withEmptyReport.push(href); // overseas: not emptiness-checked here
      continue;
    }
    const docId = (href.match(/doc_id=(\d+)/) ?? [])[1];
    if (!docId) continue;
    await page.goto(`${origin}/Document/travel_report_write.php?doc_id=${encodeURIComponent(docId)}&approve_type=AppFrm-023&pop=Y`, {
      waitUntil: "domcontentloaded", timeout: 30000,
    });
    await page.waitForTimeout(1200);
    const current = await readReportContentFields(page.mainFrame());
    if (reportIsEmpty(current)) withEmptyReport.push(href);
  }

  if (withEmptyReport.length === 0) {
    return {
      error: `${relevant.length} approved travel request(s) found, but every one already has a report written - ` +
        `pass request_doc_id explicitly (with overwrite_report: true to replace one)`,
      candidates: relevant.length,
    };
  }
  return pickApprovedTravelRequest(withEmptyReport);
}

/**
 * Pure: the domestic report's own fields (report_date/name/post/group/leader are this
 * person's own info, not form input choices - subject/destination/period are NOT here,
 * they don't exist as inputs on this page). purpose_field/agenda_field/result_field use
 * exactly the same fallback chain as org-policy.ts's TRAVEL_REPORT_FIELDS_MIN_LENGTH, so
 * that rule's length prediction matches what actually lands in the DOM.
 *
 * person_field ("Person to Meet / Contact information") is the counterparty, never this
 * person's own name - it comes only from params.persons_met (empty, not defaulted, when
 * absent; the caller is expected to warn - see submitDomesticTravelReport).
 */
export function buildDomesticReportFields(
  params: Record<string, any>,
  userInfo: { name: string; dept: string },
  env: { reportPost?: string; reportLeader?: string; userDept?: string },
  today: string
): Record<string, string> {
  const purpose = params.purpose || "Business travel";
  return {
    report_date: today,
    report_name: userInfo.name,
    report_post: env.reportPost || "",
    report_group: env.userDept || userInfo.dept || "",
    report_leader: env.reportLeader || "",
    purpose_field: String(purpose),
    date_field: params.schedule || "",
    org_field: params.organization || params.destination || "",
    person_field: params.persons_met || "",
    discuss_field: params.details || purpose,
    agenda_field: params.schedule || purpose,
    result_field: params.reason || `Expected outcomes: ${purpose}`,
    other_field: "N/A",
    conclusion_field: String(purpose),
  };
}
