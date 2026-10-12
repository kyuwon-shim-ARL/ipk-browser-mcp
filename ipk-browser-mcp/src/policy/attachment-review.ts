/**
 * Attachment review for card ERs: does the submission carry the right KINDS of evidence
 * for its resolved account, and does the agent's own quote from each file actually say
 * what the form claims (event date, total amount, issuer)?
 *
 * This absorbs the former VENDOR_ATTACHMENT_REQUIREMENTS table in org-policy.ts (RunPod's
 * 4-file rule is unchanged, just relocated) and adds 410306 (conference participation fees),
 * whose return trip from approval (doc 299905-adjacent incidents) was missing a fee table.
 *
 * Threat model (plan v6, P1 §3): a quote check catches "didn't look / skipped a day" -
 * the actual incident pattern. It does NOT prove the file's content; an agent that
 * fabricates a quote from an image-only PDF cannot be caught mechanically. That risk is
 * reduced by recording {path, sha256, kind, quote} in the audit for a person to check later,
 * not by this function.
 */
import * as fs from "fs";
import * as crypto from "crypto";

export const ATTACHMENT_KINDS = [
  "card_slip", "society_receipt", "invoice", "permission",
  "fee_table", "program", "usage", "receipt", "other",
] as const;
export type AttachmentKind = typeof ATTACHMENT_KINDS[number];

export interface AttachmentInput {
  path: string;
  kind: AttachmentKind;
  quotes?: string[];
}

export interface AttestationException {
  kind: AttachmentKind;
  date?: string; // YYYY-MM-DD, for program exceptions tied to one day
  reason: string;
  person_confirmed: true;
}

export interface AttachmentReviewParams {
  /** Resolved account code the ER is actually filed against (post Sel_account), e.g. "410306". */
  accountCode?: string | null;
  /** Vendor key for the legacy vendor-keyed table (e.g. "runpod"), when accountCode doesn't apply. */
  vendorKey?: string | null;
  attachments?: AttachmentInput[];
  /** Legacy unlabeled paths - only used to detect "no kinds given at all" on a form that requires kinds. */
  legacyPaths?: string[];
  eventStart?: string; // YYYY-MM-DD
  eventEnd?: string; // YYYY-MM-DD
  totalAmount?: number;
  /** organizer_nm (society_receipt issuer) or vendor name, whichever this account uses. */
  issuerName?: string;
  exceptions?: AttestationException[];
}

export interface AttachmentReviewResult {
  blocks: string[];
  warnings: string[];
  flagged: { kind: AttachmentKind; reason: string }[];
  auditRecords: { path: string; sha256: string | null; kind: AttachmentKind; quote: string | null }[];
}

interface Requirement {
  kinds: AttachmentKind[];
  evidenceDocs: string[];
}

/** account code -> requirement. Keep account 410306 here; vendor-keyed entries live in VENDOR_REQUIREMENTS. */
export const ACCOUNT_ATTACHMENTS_REQUIRED: Record<string, Requirement> = {
  "410306": {
    kinds: ["card_slip", "society_receipt", "permission", "fee_table", "program"],
    evidenceDocs: ["293384", "296590", "301306"],
  },
};

/** Vendor-keyed requirements (relocated from org-policy.ts VENDOR_ATTACHMENT_REQUIREMENTS). */
export const VENDOR_ATTACHMENTS_REQUIRED: Record<string, Requirement> = {
  runpod: {
    kinds: ["invoice", "card_slip", "usage", "receipt"],
    evidenceDocs: ["RunPod ER precedent"],
  },
};

/** Filename hints per kind - mismatch only warns, never blocks (plan P1 note). */
const FILENAME_HINTS: Partial<Record<AttachmentKind, RegExp>> = {
  card_slip: /(cc[_-]?sales[_-]?slip|sales[_-]?slip|매출전표)/i,
  invoice: /invoice/i,
  usage: /daily[_-]?usage|usage/i,
  receipt: /receipt/i,
  society_receipt: /receipt/i,
  program: /program/i,
  permission: /permission|invitation/i,
  fee_table: /fee|table|registration/i,
};

const ISSUER_STOPWORDS = /\b(korea|society|association|conference|학회|협회)\b/gi;

function requirementFor(params: AttachmentReviewParams): Requirement | null {
  if (params.accountCode && ACCOUNT_ATTACHMENTS_REQUIRED[params.accountCode]) {
    return ACCOUNT_ATTACHMENTS_REQUIRED[params.accountCode];
  }
  if (params.vendorKey && VENDOR_ATTACHMENTS_REQUIRED[params.vendorKey]) {
    return VENDOR_ATTACHMENTS_REQUIRED[params.vendorKey];
  }
  return null;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH_ALT = "jan|feb|mar|apr|may|jun|jul|aug|sept|sep|oct|nov|dec";

interface DateCandidate { month: number; day: number; year?: number }

/** Every (month, day[, year]) candidate a quote could plausibly contain. Order matters:
 *  the more specific patterns (with an explicit month name or a trailing dot) run first. */
function extractDateCandidates(text: string): DateCandidate[] {
  const out: DateCandidate[] = [];
  const push = (month: number, day: number, year?: number) => {
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) out.push({ month, day, year });
  };

  // "28/Sept/2026"
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2})\\/(${MONTH_ALT})\\.?\\/(\\d{4})`, "gi"))) {
    push(MONTHS[m[2].toLowerCase()], Number(m[1]), Number(m[3]));
  }
  // ISO "2026-09-27"
  for (const m of text.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)) {
    push(Number(m[2]), Number(m[3]), Number(m[1]));
  }
  // Korean "9월 27일"
  for (const m of text.matchAll(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/g)) {
    push(Number(m[1]), Number(m[2]));
  }
  // "Sep 27", "Sept. 27", "September 27"
  for (const m of text.matchAll(new RegExp(`\\b(${MONTH_ALT})[a-z]*\\.?\\s+(\\d{1,2})(?:\\s*,?\\s*(\\d{4}))?`, "gi"))) {
    push(MONTHS[m[1].toLowerCase()], Number(m[2]), m[3] ? Number(m[3]) : undefined);
  }
  // "27 Sep"
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2})\\s+(${MONTH_ALT})[a-z]*\\.?(?:\\s*,?\\s*(\\d{4}))?`, "gi"))) {
    push(MONTHS[m[2].toLowerCase()], Number(m[1]), m[3] ? Number(m[3]) : undefined);
  }
  // "27.09." - day.month. with a trailing dot (European-style, reversed from M.D)
  for (const m of text.matchAll(/\b(\d{1,2})\.(\d{1,2})\.(?!\d)/g)) {
    push(Number(m[2]), Number(m[1]));
  }
  // "9/27" - month/day
  for (const m of text.matchAll(/\b(\d{1,2})\/(\d{1,2})\b(?!\/)/g)) {
    push(Number(m[1]), Number(m[2]));
  }
  // "9.27" - month.day (no trailing dot)
  for (const m of text.matchAll(/\b(\d{1,2})\.(\d{1,2})\b(?!\.)/g)) {
    push(Number(m[1]), Number(m[2]));
  }
  return out;
}

/** Does any date candidate in `quote` denote (month, day), and if it carries a year, does
 *  that year match targetYear (when given)? A bare number ("27") never has both month and
 *  day, so it never matches - exactly the "didn't look" signal this check exists to catch. */
export function quoteMatchesDate(quote: string, month: number, day: number, targetYear?: number): boolean {
  const candidates = extractDateCandidates(quote);
  return candidates.some((c) => {
    if (c.month !== month || c.day !== day) return false;
    if (c.year !== undefined && targetYear !== undefined && c.year !== targetYear) return false;
    return true;
  });
}

/** Normalizes a quote's numbers (strips commas/currency/won marks) and checks for `amount`. */
export function quoteMatchesAmount(quote: string, amount: number): boolean {
  const normalized = quote.replace(/[,\s]/g, "");
  const nums = normalized.match(/\d+/g) || [];
  return nums.some((n) => Number(n) === amount);
}

/** Core keyword(s) of an issuer/organizer name, with common stopwords (society/association/
 *  conference, the event year, Hangul 학회/협회) removed. */
function issuerCoreTokens(name: string): string[] {
  const stripped = name.replace(ISSUER_STOPWORDS, " ").replace(/\b(19|20)\d{2}\b/g, " ");
  return stripped
    .split(/[\s()\-,./]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

export function quoteMatchesIssuer(quote: string, issuerName: string): boolean {
  const tokens = issuerCoreTokens(issuerName);
  if (tokens.length === 0) return true; // nothing left to check against
  const lowerQuote = quote.toLowerCase();
  return tokens.some((t) => lowerQuote.includes(t.toLowerCase()));
}

/** Every YYYY-MM-DD date from start to end, inclusive. Invalid/empty range -> []. */
export function datesBetween(start?: string, end?: string): string[] {
  if (!start || !end) return [];
  const a = new Date(`${start}T00:00:00Z`);
  const b = new Date(`${end}T00:00:00Z`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || b < a) return [];
  const out: string[] = [];
  for (let t = a.getTime(); t <= b.getTime(); t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

function sha256OfFile(filePath: string): string | null {
  try {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
}

function exceptionFor(exceptions: AttestationException[] | undefined, kind: AttachmentKind, date?: string) {
  return (exceptions || []).find((e) => e.kind === kind && e.person_confirmed === true && (date === undefined || e.date === date));
}

export function reviewAttachments(params: AttachmentReviewParams): AttachmentReviewResult {
  const blocks: string[] = [];
  const warnings: string[] = [];
  const flagged: { kind: AttachmentKind; reason: string }[] = [];
  const auditRecords: AttachmentReviewResult["auditRecords"] = [];

  const req = requirementFor(params);
  const attachments = params.attachments || [];

  if (req) {
    if (attachments.length === 0 && (params.legacyPaths || []).length > 0) {
      blocks.push(
        `This account requires labeled attachments (${req.kinds.join(", ")}) - attachment_path(s) ` +
        `without a kind are refused. Use attachments: [{path, kind}].`
      );
    } else if (attachments.length === 0) {
      blocks.push(`This account requires attachments (${req.kinds.join(", ")}) but none were given.`);
    } else {
      // duplicate kind
      const seen = new Map<AttachmentKind, number>();
      for (const a of attachments) seen.set(a.kind, (seen.get(a.kind) || 0) + 1);
      for (const [kind, count] of seen) {
        if (count > 1) blocks.push(`kind '${kind}' is claimed by ${count} attachments - one file = one kind.`);
      }
      const present = new Set(attachments.map((a) => a.kind));
      const missing = req.kinds.filter((k) => !present.has(k));
      if (missing.length > 0) {
        blocks.push(`Missing required attachment kind(s): ${missing.join(", ")}.`);
      }
    }
  }

  for (const a of attachments) {
    const hint = FILENAME_HINTS[a.kind];
    if (hint && !hint.test(a.path)) {
      warnings.push(`${a.path}: filename doesn't look like '${a.kind}' - check the label.`);
    }

    const quotes = a.quotes || [];
    if (a.kind === "program" && params.eventStart && params.eventEnd) {
      const targetYear = Number(params.eventStart.slice(0, 4));
      for (const dateStr of datesBetween(params.eventStart, params.eventEnd)) {
        const [, mo, da] = dateStr.split("-").map(Number);
        const matched = quotes.some((q) => quoteMatchesDate(q, mo, da, targetYear));
        if (!matched) {
          const exc = exceptionFor(params.exceptions, "program", dateStr);
          if (exc) {
            flagged.push({ kind: "program", reason: `${dateStr}: attestation_exception (${exc.reason})` });
          } else {
            blocks.push(`program: no quote covers ${dateStr}. Quote the program's own text for this date, or provide attestation_exception.`);
          }
        }
      }
    }
    if (a.kind === "fee_table" && params.totalAmount !== undefined) {
      const matched = quotes.some((q) => quoteMatchesAmount(q, params.totalAmount!));
      if (!matched) {
        const exc = exceptionFor(params.exceptions, "fee_table");
        if (exc) {
          flagged.push({ kind: "fee_table", reason: `attestation_exception (${exc.reason})` });
        } else {
          blocks.push(`fee_table: no quote contains the total amount (${params.totalAmount}). Quote the fee table's total, or provide attestation_exception.`);
        }
      }
    }
    if (a.kind === "society_receipt" && params.issuerName) {
      const matched = quotes.some((q) => quoteMatchesIssuer(q, params.issuerName!));
      if (!matched) {
        const exc = exceptionFor(params.exceptions, "society_receipt");
        if (exc) {
          flagged.push({ kind: "society_receipt", reason: `attestation_exception (${exc.reason})` });
        } else {
          blocks.push(`society_receipt: no quote names the issuer ('${params.issuerName}'). Quote the receipt's issuer line, or provide attestation_exception.`);
        }
      }
    }

    auditRecords.push({ path: a.path, sha256: sha256OfFile(a.path), kind: a.kind, quote: quotes[0] ?? null });
  }

  return { blocks, warnings, flagged, auditRecords };
}
