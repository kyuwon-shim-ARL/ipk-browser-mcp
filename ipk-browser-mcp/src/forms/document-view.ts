/**
 * Pure parsers for document_view.php's body text (document.body.innerText - same
 * convention as card-er-location.ts's approval-line parser: there is no captured markup
 * to select against, only the flattened text). Built against the real doc 301306
 * (AppFrm-021, 2026-10-12, returned for revision then revised) - see
 * test/fixtures/card-er-location/document-view-301306-revision.rawtext.txt (names
 * redacted, opinion text paraphrased).
 */

export interface ApprovalOpinion {
  name: string;
  role: string;
  date: string;
  text: string;
  hasOpinion: boolean;
}

// Greedy (.*) for the role, not [^)]*: a role like "Team Head (R)" has its own nested
// parens, so a non-greedy/no-')' class would stop at the first ')' and fail to match.
const HEADER_RE = /^(.+?)\s*\((.*)\)\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})$/;

/**
 * Every "{name} ({role}) {date}" header paired with the line after it, from "Opinion of
 * approval" up to "Document Modify History". The "====" line (separating the formal
 * approval-line opinions from a returned-for-revision exchange) is skipped, not treated
 * as a header or an opinion body.
 */
export function parseApprovalOpinions(bodyText: string): ApprovalOpinion[] {
  const lines = bodyText.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => l.trim() === "Opinion of approval" || l.trim().startsWith("Opinion of approval\t"));
  if (startIdx === -1) return [];
  const endIdx = lines.findIndex((l, i) => i > startIdx && l.trim().startsWith("Document Modify History"));
  const slice = lines.slice(startIdx, endIdx === -1 ? lines.length : endIdx);

  // The first header shares its line with "Opinion of approval\t" - split that off.
  const firstLine = slice[0].replace(/^Opinion of approval\t?/, "");
  const body = [firstLine, ...slice.slice(1)].filter((l) => !/^=+$/.test(l.trim()));

  const out: ApprovalOpinion[] = [];
  for (let i = 0; i < body.length - 1; i++) {
    const m = HEADER_RE.exec(body[i].trim());
    if (!m) continue;
    const text = (body[i + 1] ?? "").trim();
    out.push({ name: m[1].trim(), role: m[2].trim(), date: m[3].trim(), text, hasOpinion: text !== "[No opinion]" && text !== "" });
    i++; // consumed the text line too
  }
  return out;
}

/** Filenames listed under "Additional document" (the P3 revision slots), [] if absent. */
export function parseAdditionalDocuments(bodyText: string): string[] {
  const lines = bodyText.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => l.trim() === "Additional document");
  if (startIdx === -1) return [];
  const out: string[] = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "" || line === "[ Close ] [ Print ]") break;
    const m = /([^\t[\]]+\.[a-zA-Z0-9]+)\s*\[\d+Bytes\]/.exec(line);
    if (m) out.push(m[1].trim());
  }
  return out;
}

/** The resolved account code (e.g. "410306") from the item table's "[NNNNNN]" cell. */
export function parseAccountCode(bodyText: string): string | null {
  const m = /\[(\d{6})\]/.exec(bodyText);
  return m ? m[1] : null;
}

/** "Date/Time\t  2026-09-27 ~2026-10-01" -> { start, end }. */
export function parseEventDates(bodyText: string): { start: string; end: string } | null {
  const m = /Date\/Time\t\s*(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})/.exec(bodyText);
  return m ? { start: m[1], end: m[2] } : null;
}

/** "Total\t\n650,000 KRW" -> 650000. */
export function parseTotalAmount(bodyText: string): number | null {
  const m = /Total\t\s*\n?\s*([\d,]+)\s*KRW/.exec(bodyText);
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

/** "Organizer\t  [Domestic] AI4Sci Korea 2026 Organizing Committee (...)" -> the name
 *  after the optional "[Domestic]"/"[Overseas]" tag. */
export function parseOrganizer(bodyText: string): string | null {
  const m = /Organizer\t\s*(?:\[[^\]]*\]\s*)?([^\n]+)/.exec(bodyText);
  return m ? m[1].trim() : null;
}
