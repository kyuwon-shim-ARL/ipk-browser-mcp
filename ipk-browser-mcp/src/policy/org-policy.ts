/**
 * Organisational policy: what IPK requires of an approval document, independent of
 * what the groupware form itself validates.
 *
 * The form knows its own required fields and rejects a submission that lacks them.
 * It does not know, and will not reject, a document that breaks an office rule -
 * doc 299905 was saved with Korean free text and every layer (read-back check,
 * benchmark, reconciliation) passed it, because none of them defined the rule.
 *
 * This file is that definition. Each rule states the standard in words and the
 * criterion a submission must meet, and `check` is the executable form of the
 * criterion. The submit handler runs it before touching the form; the benchmark
 * scorer applies the same standard to the audit trail (bench/score.mjs, M6).
 */
import { isMeetingAccount } from "../forms/card-er.js";

export interface PolicyViolation {
  rule: string;
  message: string;
  fields: string[];
}

export interface PolicyRule {
  id: string;
  /** The organisational requirement, as a person would state it. */
  standard: string;
  /** What a submission must satisfy for this rule to pass. */
  passes: string;
  /** Returns a violation, or null when the params satisfy the rule. */
  check: (params: Record<string, any>) => PolicyViolation | null;
}

const HANGUL = /[\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uAC00-\uD7AF\uD7B0-\uD7FF]/;

export function containsHangul(s: unknown): boolean {
  return typeof s === "string" && HANGUL.test(s);
}

/**
 * Parameters a person types as prose. Code-valued params (budget_code, bound_code,
 * leave_type, ...) are excluded: they are matched against options the form offers,
 * and those option labels are the groupware's own text.
 */
export const FREE_TEXT_PARAMS = [
  "subject",
  "title",
  "purpose",
  "destination",
  "reason",
  "details",
  "description",
  "participants",
  "venue",
  "work_place",
  "organization",
  "attendees",
  "schedule",
  "item_name",
  "seller_en",
  "item_description",
  "item_vendor",
  "purpose_minutes",
  "purpose_category",
  "disclosure_purpose",
  "material_description",
  "conference_or_journal",
  "country",
  "conference_name",
] as const;

/** Vendors billed from abroad: no Korean VAT is charged, so none may be split out. */
const OVERSEAS_IT_VENDORS = /runpod|openai|chatgpt|anthropic|claude|google cloud|gcp|aws|amazon web|azure|github|vercel|huggingface|hugging face|lambda labs|vast\.ai|modal/i;

/** Forms whose handler derives VAT as amount/1.1 instead of reading it from a receipt. */
const VAT_SPLITTING_FORMS = new Set(["expense", "card_expense"]);

/** Labels of the meeting accounts, for when only account_code_label is given. */
const MEETING_ACCOUNT_LABEL = /team activit|meeting/i;

/** A destination naming Seoul, in English or Hangul - matched against travel_request's
 *  free-text destination param (feedback_seoul_is_outside_metro.md). */
const SEOUL_RE = /seoul|서울/i;

/**
 * Attachment kinds a vendor's card ER (card_expense_rd) needs, matched by filename -
 * generalised so another vendor can be added as one more table entry. RunPod needs 4
 * (feedback_runpod_er_attachments.md / CLAUDE.md Attachment Conventions, dir name
 * convention invoice_signed.pdf / CC_sales_slip.pdf / daily_usage.png / receipt.pdf).
 */
const VENDOR_ATTACHMENT_REQUIREMENTS: Record<string, { label: string; match: RegExp }[]> = {
  runpod: [
    { label: "signed invoice", match: /invoice/i },
    { label: "card sales slip", match: /(cc[_-]?sales[_-]?slip|sales[_-]?slip|매출전표)/i },
    { label: "daily usage screenshot", match: /daily[_-]?usage/i },
    { label: "receipt", match: /receipt/i },
  ],
};

/** Which vendor (if any) a card_expense_rd's item_name/seller_en/item_vendor names. */
function vendorAttachmentKey(params: Record<string, any>): string | null {
  const text = ["item_name", "seller_en", "item_vendor"]
    .map((k) => (typeof params[k] === "string" ? params[k] : ""))
    .join(" ")
    .toLowerCase();
  return Object.keys(VENDOR_ATTACHMENT_REQUIREMENTS).find((k) => text.includes(k)) ?? null;
}

/** Whole days between two YYYY-MM-DD dates; NaN if either doesn't parse. */
function nightsBetween(start: string, end: string): number {
  const a = new Date(start).getTime();
  const b = new Date(end).getTime();
  return Math.round((b - a) / 86400000);
}

export const ORG_POLICY: PolicyRule[] = [
  {
    id: "ENGLISH_ONLY",
    standard: "Approval documents are written in English. Korean input from the requester is translated before it reaches the form.",
    passes: "No free-text parameter (subject, purpose, destination, reason, ...) contains Hangul.",
    check(params) {
      const fields = FREE_TEXT_PARAMS.filter((k) => containsHangul(params[k]));
      if (fields.length === 0) return null;
      return {
        rule: "ENGLISH_ONLY",
        fields: [...fields],
        message:
          `Korean text in ${fields.join(", ")}. Approval documents must be in English - ` +
          `translate these values and resubmit. Nothing was written to the form.`,
      };
    },
  },
  {
    id: "NO_FINAL_SUBMIT",
    standard:
      "A document is saved as a draft and reviewed by a person before it is submitted for approval. " +
      "Submission itself (draft_only=false) is refused by default. A person who wants submission " +
      "unlocked for this process must set env IPK_ALLOW_SUBMIT=1 - and even then the MCP does not " +
      "perform the final approval-request click itself (see src/tools/ipk-submit.ts noFinalSubmitNote); " +
      "it saves a draft and reports the click path for a person to press the button. " +
      "(Future option, out of scope here: per-call MCP elicitation instead of the env switch.)",
    passes: "draft_only is not false, or (confirm_submit is true AND env IPK_ALLOW_SUBMIT=1).",
    check(params) {
      if (params.draft_only !== false) return null;
      if (params.confirm_submit === true && process.env.IPK_ALLOW_SUBMIT === "1") return null;
      return {
        rule: "NO_FINAL_SUBMIT",
        fields: ["draft_only", "confirm_submit"],
        message:
          "Submission is refused: set draft_only=true for a draft, or to unlock submission set " +
          "confirm_submit=true AND the environment variable IPK_ALLOW_SUBMIT=1. Even then, this tool " +
          "will not click the final approval-request button itself - it saves a draft and tells you " +
          "where to click.",
      };
    },
  },
  {
    id: "TEAM_ACTIVITY_FIELDS_REQUIRED",
    standard: "A card ER on a meeting account (Team Activities 412107 and the other accounts the account picker treats as meetings) records venue, meeting time, participants and purpose - the page requires venue and meeting time for every meeting account, and precedent documents always carry participants and purpose.",
    passes: "When card_expense_rd is filed with a meeting item_account_code (isMeetingAccount), or with no code and a Team Activities / meeting account_code_label, venue, meeting_begin, meeting_end, participants and purpose_minutes (or purpose) are all non-empty.",
    check(params) {
      if (String(params.form_type) !== "card_expense_rd") return null;
      const byCode = isMeetingAccount(params.item_account_code);
      const byLabel = !params.item_account_code && MEETING_ACCOUNT_LABEL.test(String(params.account_code_label ?? ""));
      if (!byCode && !byLabel) return null;
      const required = {
        venue: params.venue,
        meeting_begin: params.meeting_begin,
        meeting_end: params.meeting_end,
        participants: params.participants,
        purpose_minutes: params.purpose_minutes || params.purpose,
      };
      const fields = Object.entries(required)
        .filter(([, v]) => typeof v !== "string" || v.trim() === "")
        .map(([k]) => k);
      if (fields.length === 0) return null;
      return {
        rule: "TEAM_ACTIVITY_FIELDS_REQUIRED",
        fields,
        message:
          `Meeting account ${params.item_account_code || params.account_code_label} requires ${fields.join(", ")}. Provide venue, meeting_begin, ` +
          `meeting_end, participants and purpose_minutes (or purpose). Nothing was written to the form.`,
      };
    },
  },
  {
    id: "OVERSEAS_IT_VAT_ZERO",
    standard: "Overseas IT subscriptions (RunPod, OpenAI, Google Cloud, ...) carry no Korean VAT: VAT=0 and the ex-VAT amount equals the total. Splitting VAT out double-taxes the item and the document is sent back.",
    passes: "An expense whose vendor or description names an overseas IT vendor is not filed through a form that derives VAT as amount/1.1.",
    check(params) {
      if (!VAT_SPLITTING_FORMS.has(String(params.form_type))) return null;
      const fields = ["item_vendor", "item_description", "purpose", "details"].filter(
        (k) => typeof params[k] === "string" && OVERSEAS_IT_VENDORS.test(params[k])
      );
      if (fields.length === 0) return null;
      return {
        rule: "OVERSEAS_IT_VAT_ZERO",
        fields,
        message:
          `${params.form_type} splits VAT as amount/1.1, but ${fields.join(", ")} names an overseas IT vendor ` +
          `that charges no Korean VAT. File it as card_expense_rd (amounts come from the card receipt) ` +
          `so VAT stays 0. Nothing was written to the form.`,
      };
    },
  },
  {
    id: "SEOUL_IS_OUTSIDE_METRO",
    standard: "A travel_request to Seoul is filed bound_code '20' (Outside Metropolitan): IPK's Pangyo (Seongnam) HQ puts Seoul outside the metro boundary, not within it, however intuitive '수도권=관내' sounds. An AI4Sci Korea (Seoul Dragon City) request was drafted '19' and the person corrected it.",
    passes: "When destination names Seoul (English or Hangul), bound_code is '20'.",
    check(params) {
      if (String(params.form_type) !== "travel_request") return null;
      if (!SEOUL_RE.test(String(params.destination ?? ""))) return null;
      if (String(params.bound_code ?? "") === "20") return null;
      return {
        rule: "SEOUL_IS_OUTSIDE_METRO",
        fields: ["bound_code", "destination"],
        message:
          `destination '${params.destination}' names Seoul; bound_code must be '20' (Outside Metropolitan), ` +
          `not '19' - IPK's Pangyo HQ classifies Seoul as outside the metro boundary. Nothing was written to the form.`,
      };
    },
  },
  {
    id: "VENDOR_ATTACHMENTS_REQUIRED",
    standard: "A card ER for a vendor with known attachment requirements (RunPod: signed invoice, card sales slip, daily usage screenshot, receipt) carries all of them - an incomplete set has needed re-attaching before.",
    passes: "When item_name/seller_en/item_vendor names a vendor in the requirements table, attachment_path(s) include a file matching every required kind.",
    check(params) {
      if (String(params.form_type) !== "card_expense_rd") return null;
      const vendor = vendorAttachmentKey(params);
      if (!vendor) return null;
      const kinds = VENDOR_ATTACHMENT_REQUIREMENTS[vendor];
      const paths: string[] = [params.attachment_path, ...(Array.isArray(params.attachment_paths) ? params.attachment_paths : [])].filter(Boolean);
      const missing = kinds.filter((k) => !paths.some((p) => k.match.test(String(p))));
      if (missing.length === 0) return null;
      return {
        rule: "VENDOR_ATTACHMENTS_REQUIRED",
        fields: ["attachment_paths"],
        message:
          `${vendor} card ER needs ${kinds.length} attachments (${kinds.map((k) => k.label).join(", ")}); ` +
          `missing: ${missing.map((k) => k.label).join(", ")}. Nothing was written to the form.`,
      };
    },
  },
  {
    id: "NO_REPORT_FOR_DAY_TRIP",
    standard: "A domestic travel report (form_type 'travel', written onto the approved AppFrm-023 request at travel_report_write.php) is only filed for trips of 2 nights (2박3일) or more - across the person's 15 domestic trips, all 5 of >=2 nights have a report and all 9 same-day trips do not, no exceptions.",
    passes: "start_date/end_date are absent (nothing to compute yet), or span 2 nights or more.",
    check(params) {
      if (String(params.form_type) !== "travel") return null;
      if (!params.start_date || !params.end_date) return null;
      const nights = nightsBetween(String(params.start_date), String(params.end_date));
      if (Number.isNaN(nights) || nights >= 2) return null;
      return {
        rule: "NO_REPORT_FOR_DAY_TRIP",
        fields: ["start_date", "end_date"],
        message:
          `start_date/end_date span ${nights} night(s); a domestic travel report is only filed for 2 nights ` +
          `(2박3일) or more - a same-day or 1-night trip does not get one. Nothing was written to the form.`,
      };
    },
  },
  {
    id: "TRAVEL_REPORT_FIELDS_MIN_LENGTH",
    standard: "travel_report_write.php's own Check_Form() rejects purpose_field, agenda_field and result_field under 100 characters - caught here, before the form is touched, using the same fallbacks submitTravel applies (agenda_field falls back to purpose, result_field to 'Expected outcomes: <purpose>').",
    passes: "purpose_field, agenda_field and result_field (after submitTravel's own fallbacks) are each >=100 characters.",
    check(params) {
      if (String(params.form_type) !== "travel") return null;
      const purpose = params.purpose || "Business travel";
      const computed: Record<string, string> = {
        purpose_field: String(purpose),
        agenda_field: String(params.schedule || purpose),
        result_field: String(params.reason || `Expected outcomes: ${purpose}`),
      };
      const short = Object.keys(computed).filter((k) => computed[k].length < 100);
      if (short.length === 0) return null;
      return {
        rule: "TRAVEL_REPORT_FIELDS_MIN_LENGTH",
        fields: short,
        message:
          `${short.join(", ")} must each be >=100 characters (travel_report_write.php's own Check_Form() ` +
          `rejects shorter values); lengths: ${short.map((k) => `${k}=${computed[k].length}`).join(", ")}. ` +
          `Nothing was written to the form.`,
      };
    },
  },
];

/**
 * Where generated files live. A PDF rendered by a script (an email re-laid-out as a
 * "승인 근거" page) is not evidence; the person's own Gmail print is. Evidence is placed
 * by the person under Downloads/Documents/data/attachments, never produced into /tmp.
 */
const GENERATED_FILE_DIRS = /^\/tmp\/|\/scratchpad\//;

ORG_POLICY.push({
  id: "NO_GENERATED_EVIDENCE",
  standard: "Attachments are real documents the person supplied (an approval email printed from Gmail, a receipt, an invoice). The tool never fabricates or re-lays-out evidence. doc 299953 went out with a script-rendered PDF that the person had to replace.",
  passes: "Every attachment path is outside /tmp and any scratchpad directory.",
  check(params) {
    const paths: string[] = [params.attachment_path, ...(Array.isArray(params.attachment_paths) ? params.attachment_paths : [])].filter(Boolean);
    const bad = paths.filter((x) => GENERATED_FILE_DIRS.test(String(x)));
    if (bad.length === 0) return null;
    return {
      rule: "NO_GENERATED_EVIDENCE",
      fields: ["attachment_path"],
      message:
        `${bad.join(", ")}: files in /tmp or a scratchpad are what scripts produce, not what a person supplied. ` +
        `Attach the person's own file (e.g. the Gmail print-to-PDF) from Downloads, Documents or data/attachments.`,
    };
  },
});

/** All violations at once, so the caller can report every problem in a single refusal. */
export function checkOrgPolicy(params: Record<string, any>): PolicyViolation[] {
  const out: PolicyViolation[] = [];
  for (const rule of ORG_POLICY) {
    const v = rule.check(params);
    if (v) out.push(v);
  }
  return out;
}
