/**
 * Pure logic for ipk_reviewer_opinions (plan v6 P3 3a/3b): never blocks, never writes to
 * the groupware - it surfaces requests a processing department has made on >=2 documents
 * by different drafters as a "rule candidate" for a person to turn into an actual
 * ACCOUNT_ATTACHMENTS_REQUIRED/field-rules entry. Local-only: names and opinion text are
 * never written to the repo, only to ~/.cache/ipk-mcp/ (enforced by the tool wrapper).
 *
 * Department matching is a known-alias lookup, not a guess: an opinion's role department
 * is kept as a processing-department opinion only if it equals (case-insensitively) one of
 * the document's own Takeover departments or a listed alias of one. Anything else is
 * reported as an unmatched department for a person to add to DEPT_ALIASES, never silently
 * treated as a match or silently dropped as noise.
 */
import { parseApprovalOpinions, parseTakeoverDepartments, type ApprovalOpinion } from "../forms/document-view.js";

/** department (as it appears in the Takeover row) -> its known short forms/aliases. */
export const DEPT_ALIASES: Record<string, string[]> = {
  "Budget Planning & Finance": ["BPF", "Budget Planning & Finance", "Budget Planning and Finance"],
};

function matchesDept(roleDept: string, takeoverDept: string): boolean {
  const aliases = DEPT_ALIASES[takeoverDept] ?? [takeoverDept];
  return aliases.some((a) => a.toLowerCase() === roleDept.toLowerCase());
}

export interface ProcessingOpinion {
  docId: string;
  drafter: string;
  formType: string;
  accountCode: string | null;
  department: string;
  text: string;
}

export interface ExtractResult {
  opinions: ProcessingOpinion[];
  unmatchedDepartments: string[];
}

/** role is "{Department} - {Title}" or just "{Department}" - the part before " - " (or
 *  the whole thing) is what gets compared against the Takeover departments. */
function roleDepartment(role: string): string {
  const idx = role.indexOf(" - ");
  return (idx === -1 ? role : role.slice(0, idx)).trim();
}

export function extractProcessingOpinions(
  docId: string,
  drafter: string,
  formType: string,
  accountCode: string | null,
  bodyText: string
): ExtractResult {
  const takeoverDepts = parseTakeoverDepartments(bodyText) ?? [];
  const opinions: ProcessingOpinion[] = [];
  const unmatched = new Set<string>();
  if (takeoverDepts.length === 0) return { opinions, unmatchedDepartments: [] };

  const real = parseApprovalOpinions(bodyText).filter((o: ApprovalOpinion) => o.hasOpinion);
  for (const o of real) {
    const dept = roleDepartment(o.role);
    // Drafter's own follow-up reply shares the opinion log but is never itself a
    // processing-department opinion (same name, no department to match).
    if (o.name === drafter) continue;
    if (takeoverDepts.some((td) => matchesDept(dept, td))) {
      opinions.push({ docId, drafter, formType, accountCode, department: dept, text: o.text });
    } else {
      unmatched.add(dept);
    }
  }
  return { opinions, unmatchedDepartments: [...unmatched] };
}

// ── clustering ──────────────────────────────────────────────────────

function normalizeTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1)
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export interface RuleCandidate {
  formType: string;
  accountCode: string | null;
  department: string;
  representativeText: string;
  docIds: string[];
  drafters: string[];
}

/**
 * Groups opinions by (formType, accountCode), clusters near-identical requests within
 * each group by normalized-keyword Jaccard overlap (>= threshold), and flags a cluster as
 * a rule candidate only when it spans >=2 documents by >=2 DIFFERENT drafters - the same
 * drafter repeating a request isn't evidence of an org-wide rule.
 */
export function clusterOpinions(opinions: ProcessingOpinion[], threshold = 0.5): RuleCandidate[] {
  const groups = new Map<string, ProcessingOpinion[]>();
  for (const o of opinions) {
    const key = `${o.formType}|${o.accountCode ?? ""}`;
    const g = groups.get(key);
    if (g) g.push(o);
    else groups.set(key, [o]);
  }

  const candidates: RuleCandidate[] = [];
  for (const [key, group] of groups) {
    const [formType, accountCodeRaw] = key.split("|");
    const accountCode = accountCodeRaw || null;
    const clusters: { tokens: Set<string>; members: ProcessingOpinion[] }[] = [];
    for (const o of group) {
      const tokens = normalizeTokens(o.text);
      const match = clusters.find((c) => jaccard(tokens, c.tokens) >= threshold);
      if (match) match.members.push(o);
      else clusters.push({ tokens, members: [o] });
    }
    for (const c of clusters) {
      const docIds = [...new Set(c.members.map((m) => m.docId))];
      const drafters = [...new Set(c.members.map((m) => m.drafter))];
      if (docIds.length >= 2 && drafters.length >= 2) {
        candidates.push({
          formType, accountCode, department: c.members[0].department,
          representativeText: c.members[0].text, docIds, drafters,
        });
      }
    }
  }
  return candidates;
}
