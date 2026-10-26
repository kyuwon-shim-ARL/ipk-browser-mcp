/**
 * ipk_reviewer_opinions (plan v6 P3 3a/3b): an OFFLINE, local-only collector. It never
 * runs from a save path and never writes to the groupware - it reads groupapproved
 * documents, keeps only processing-department opinions (department matched against each
 * document's own Takeover row - see reviewer-opinions.ts's DEPT_ALIASES), and flags a
 * request repeated on >=2 documents by >=2 different drafters as a rule candidate with
 * doc_id evidence, for a person to decide whether it becomes an actual rule.
 *
 * Names and opinion text are local-only (~/.cache/ipk-mcp/), never the repo - the MCP
 * result itself only returns counts, candidates (paraphrased text, doc_ids, not names
 * beyond what's needed to show ">=2 different drafters"), and unmatched departments.
 */
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { SessionManager } from "../browser/session.js";
import { Config } from "../types.js";
import { textResult } from "../util.js";
import { navigateInFrame } from "../browser/iframe-helper.js";
import { parseAccountCode } from "../forms/document-view.js";
import { extractProcessingOpinions, clusterOpinions, type ProcessingOpinion } from "../precedent/reviewer-opinions.js";

export const ipkReviewerOpinionsSchema = {
  months: z.number().default(12).describe("How many months back to search groupapproved documents."),
  max_docs: z.number().default(60).describe("Cap on how many documents to open (politeness/cost bound)."),
};

export const ipkReviewerOpinionsDescription =
  "OFFLINE, read-only, LOCAL ONLY: collects processing-department opinions (e.g. Budget Planning & Finance) " +
  "across groupapproved documents and flags a request repeated by >=2 different drafters as a rule candidate, " +
  "with doc_id evidence. Never called from a save path, never writes to the groupware. Full detail (names, " +
  "opinion text) is cached under ~/.cache/ipk-mcp/ only; the MCP result reports counts/candidates/unmatched " +
  "departments, not raw names.";

function cacheDir(): string {
  return path.join(process.env.HOME || "/tmp", ".cache", "ipk-mcp", "reviewer-opinions");
}

async function readBodyText(frame: any): Promise<string> {
  try {
    return await frame.evaluate(() => (document.body ? document.body.innerText : ""));
  } catch {
    return "";
  }
}

async function readField(frame: any, name: string): Promise<string | null> {
  try {
    return await frame.evaluate((n: string) => {
      const el = document.querySelector(`input[name="${n}"]`) as HTMLInputElement | null;
      return el ? el.value : null;
    }, name);
  } catch {
    return null;
  }
}

/** "Drafter\t{Dept} - {Title} - {Name} (XXXXX)\tDate\t..." -> the name. */
function parseDrafterName(bodyText: string): string | null {
  const m = /Drafter\t[^\t\n]*-\s*([^(\t\n]+?)\s*\(/.exec(bodyText);
  return m ? m[1].trim() : null;
}

export async function handleIpkReviewerOpinions(
  sessionManager: SessionManager,
  config: Config,
  params: Record<string, any>
) {
  if (!sessionManager.isLoggedIn()) {
    return textResult({
      error: true,
      code: "NOT_LOGGED_IN",
      message: sessionManager.getLoginState() === "expired"
        ? "Browser session expired after 30 minutes idle. Call ipk_login again."
        : "Call ipk_login first",
    });
  }
  const months = Number(params.months) || 12;
  const maxDocs = Number(params.max_docs) || 60;

  const page = sessionManager.getPage()!;
  const today = new Date();
  const start = new Date(today);
  start.setMonth(start.getMonth() - months);
  const sDate = start.toISOString().slice(0, 10);
  const eDate = today.toISOString().slice(0, 10);

  const listFrame = await navigateInFrame(
    page,
    `/Document/document_list.php?type=groupapproved&s_date=${sDate}&e_date=${eDate}` +
      `&writer=Y&title=Y&contents=Y&attachment=Y`,
    config
  ).catch(() => null);
  if (!listFrame) {
    return textResult({ error: true, code: "NAVIGATION_FAILED", message: "Could not open the groupapproved document list." });
  }

  const allDocIds: string[] = await listFrame.evaluate(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    const links = document.querySelectorAll("a[href*='doc_id=']") as NodeListOf<HTMLAnchorElement>;
    for (const link of links) {
      const m = (link.getAttribute("href") || "").match(/doc_id=([^&]+)/);
      if (m && !seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
    }
    return out;
  }).catch(() => [] as string[]);

  const candidates = allDocIds.slice(0, maxDocs);
  const allOpinions: ProcessingOpinion[] = [];
  const unmatchedDepartments = new Set<string>();
  let docsWithTakeover = 0;
  let visited = 0;

  for (const docId of candidates) {
    const frame = await navigateInFrame(page, `/Document/document_view.php?doc_id=${docId}&pop_view=y`, config).catch(() => null);
    if (!frame) continue;
    visited += 1;
    const bodyText = await readBodyText(frame);
    const drafter = parseDrafterName(bodyText) || "";
    const approveType = (await readField(frame, "approve_type")) || "unknown";
    const accountCode = parseAccountCode(bodyText);
    const { opinions, unmatchedDepartments: unmatched } = extractProcessingOpinions(docId, drafter, approveType, accountCode, bodyText);
    if (opinions.length > 0 || unmatched.length > 0) docsWithTakeover += 1;
    allOpinions.push(...opinions);
    for (const u of unmatched) unmatchedDepartments.add(u);
  }

  const candidatesFound = clusterOpinions(allOpinions);

  let cachedAt: string | null = null;
  try {
    const dir = cacheDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    cachedAt = path.join(dir, `reviewer-opinions-${eDate}.json`);
    fs.writeFileSync(cachedAt, JSON.stringify({
      sDate, eDate, docsScanned: visited, docsWithTakeover, opinions: allOpinions, candidates: candidatesFound,
      unmatchedDepartments: [...unmatchedDepartments],
    }, null, 2), "utf8");
  } catch {
    // caching is best-effort
  }

  return textResult({
    error: false,
    data: {
      range: { s_date: sDate, e_date: eDate },
      docs_scanned: visited,
      docs_with_takeover_opinions: docsWithTakeover,
      processing_opinions_found: allOpinions.length,
      rule_candidates: candidatesFound.map((c) => ({
        form_type: c.formType, account_code: c.accountCode, department: c.department,
        summary: c.representativeText.slice(0, 200), doc_ids: c.docIds, drafter_count: c.drafters.length,
      })),
      unmatched_departments: [...unmatchedDepartments],
      cached_at: cachedAt,
      message: `${visited} doc(s) scanned, ${allOpinions.length} processing-department opinion(s) found, ` +
        `${candidatesFound.length} rule candidate(s). Full detail (names, verbatim text) is local-only at ${cachedAt ?? "(cache write failed)"}.`,
    },
  });
}
