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

/** Account code for Team Activities (RS only) on card_expense_rd (AppFrm-021). */
const TEAM_ACTIVITY_ACCOUNT_CODE = "412107";

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
    id: "DRAFT_FIRST",
    standard: "A document is saved as a draft and reviewed by a person before it is submitted for approval.",
    passes: "draft_only is true, or confirm_submit is explicitly true.",
    check(params) {
      if (params.draft_only !== false || params.confirm_submit === true) return null;
      return {
        rule: "DRAFT_FIRST",
        fields: ["draft_only", "confirm_submit"],
        message: "To submit for approval, set both draft_only=false AND confirm_submit=true",
      };
    },
  },
  {
    id: "TEAM_ACTIVITY_FIELDS_REQUIRED",
    standard: "A Team Activities (RS only) card ER (account 412107) records venue, meeting time, participants and purpose - the groupware form accepts the row without them, but the account itself requires them.",
    passes: "When card_expense_rd is filed with item_account_code '412107', venue, meeting_begin, meeting_end, participants and purpose_minutes (or purpose) are all non-empty.",
    check(params) {
      if (String(params.form_type) !== "card_expense_rd") return null;
      const byCode = String(params.item_account_code) === TEAM_ACTIVITY_ACCOUNT_CODE;
      const byLabel = !params.item_account_code && /team activit/i.test(String(params.account_code_label ?? ""));
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
          `Team Activities (account 412107) requires ${fields.join(", ")}. Provide venue, meeting_begin, ` +
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
