/**
 * Pure aggregation for ipk_precedent_attachments (plan v6 P2): never blocks a submission,
 * never changes a rule - it proposes candidate ACCOUNT_ATTACHMENTS_REQUIRED rows as text
 * for a person to label into kinds. The live fetch (sequential, read-only) lives in
 * src/tools/ipk-precedent-attachments.ts; everything here takes already-fetched text so
 * it is unit-testable without Playwright.
 */
import { parseAccountCode, parseFileAttachmentList, parseAdditionalDocuments } from "../forms/document-view.js";

export interface RawPrecedentDoc {
  docId: string;
  bodyText: string;
}

export interface PrecedentDocResult {
  docId: string;
  filenames: string[];
}

export interface FilenameToken {
  token: string;
  count: number;
}

export interface PrecedentReport {
  account: string;
  docsScanned: number;
  docsFound: number;
  docs: PrecedentDocResult[];
  frequentTokens: FilenameToken[];
  candidateRowText: string;
}

const STOPWORD_TOKEN = /^\d+$/; // pure numbers (dates, byte-size-looking fragments) aren't useful labels

/** Filename -> lowercase word tokens, numeric-only tokens and the extension dropped. */
function filenameTokens(filename: string): string[] {
  const base = filename.replace(/\.[a-zA-Z0-9]+$/, "");
  return base
    .split(/[-_.\s]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 2 && !STOPWORD_TOKEN.test(t));
}

export function frequentFilenameTokens(filenameLists: string[][]): FilenameToken[] {
  const counts = new Map<string, number>();
  for (const filenames of filenameLists) {
    for (const f of filenames) {
      for (const t of filenameTokens(f)) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([token, count]) => ({ token, count }))
    .sort((a, b) => b.count - a.count || a.token.localeCompare(b.token));
}

/** Every doc whose resolved account code matches `account`, with its filenames. Docs for
 *  a different account (or unreadable) are counted in docsScanned but excluded from docs. */
export function buildPrecedentReport(account: string, rawDocs: RawPrecedentDoc[]): PrecedentReport {
  const docs: PrecedentDocResult[] = [];
  for (const d of rawDocs) {
    if (parseAccountCode(d.bodyText) !== account) continue;
    const filenames = [...parseFileAttachmentList(d.bodyText), ...parseAdditionalDocuments(d.bodyText)];
    docs.push({ docId: d.docId, filenames });
  }
  const frequentTokens = frequentFilenameTokens(docs.map((d) => d.filenames));
  const candidateRowText = docs.length === 0
    ? `No precedent documents found for account ${account} in range - nothing to propose.`
    : `Candidate ACCOUNT_ATTACHMENTS_REQUIRED row for ${account}: ${docs.length} precedent doc(s), frequent ` +
      `filename tokens - ${frequentTokens.slice(0, 8).map((t) => `${t.token}(${t.count})`).join(", ")}. ` +
      "A person must label these into kinds before this becomes a rule - this is a proposal, not a rule change.";
  return { account, docsScanned: rawDocs.length, docsFound: docs.length, docs, frequentTokens, candidateRowText };
}
