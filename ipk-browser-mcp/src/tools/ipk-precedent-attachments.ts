/**
 * ipk_precedent_attachments (plan v6 P2): an OFFLINE collector. It never runs from a save
 * path (see the structural test in test/tools/ipk-precedent-attachments.test.ts) and never
 * changes a rule - it reads colleagues' groupapproved card ERs (AppFrm-021) for the given
 * account, records each one's attachment filenames, and returns a frequent-filename-token
 * summary plus a plain-text proposal for a person to label into ACCOUNT_ATTACHMENTS_REQUIRED
 * kinds (attachment-review.ts). The cache is local only (~/.cache/ipk-mcp/), never the repo.
 *
 * Fetches sequentially (one page, one document at a time, awaited) - politeness over
 * speed, same discipline as clearAllAttachments's one-at-a-time deletes.
 */
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { SessionManager } from "../browser/session.js";
import { Config } from "../types.js";
import { textResult } from "../util.js";
import { navigateInFrame } from "../browser/iframe-helper.js";
import { toolDraftedDocIds } from "../internal/audit.js";
import { buildPrecedentReport, type RawPrecedentDoc } from "../precedent/attachment-precedent.js";

export const ipkPrecedentAttachmentsSchema = {
  account: z.string().describe("Account code to collect precedent for (e.g. '410306')."),
  months: z.number().default(12).describe("How many months back to search groupapproved documents."),
  max_docs: z.number().default(40).describe("Cap on how many candidate documents to open (politeness/cost bound)."),
  exclude_doc_ids: z.array(z.string()).optional().describe("doc_ids to skip in addition to this tool's own past drafts (toolDraftedDocIds)."),
};

export const ipkPrecedentAttachmentsDescription =
  "OFFLINE, read-only: collects colleagues' groupapproved card ER (AppFrm-021) attachment filenames for one " +
  "account over the last N months, and proposes (as text, never a rule change) candidate attachment kinds for " +
  "ACCOUNT_ATTACHMENTS_REQUIRED. Never called from a save path. Cached under ~/.cache/ipk-mcp/, never the repo.";

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function cacheDir(): string {
  return path.join(process.env.HOME || "/tmp", ".cache", "ipk-mcp", "precedent-attachments");
}

async function readBodyText(frame: any): Promise<string> {
  try {
    return await frame.evaluate(() => (document.body ? document.body.innerText : ""));
  } catch {
    return "";
  }
}

async function readApproveType(frame: any): Promise<string | null> {
  try {
    return await frame.evaluate(() => {
      const el = document.querySelector('input[name="approve_type"]') as HTMLInputElement | null;
      return el ? el.value : null;
    });
  } catch {
    return null;
  }
}

export async function handleIpkPrecedentAttachments(
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
  const account = String(params.account || "");
  if (!account) return textResult({ error: true, code: "ACCOUNT_REQUIRED", message: "account is required." });
  const months = Number(params.months) || 12;
  const maxDocs = Number(params.max_docs) || 40;

  const page = sessionManager.getPage()!;
  const today = new Date();
  const start = new Date(today);
  start.setMonth(start.getMonth() - months);
  const sDate = isoDate(start);
  const eDate = isoDate(today);

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

  const excluded = new Set<string>([
    ...toolDraftedDocIds(),
    ...(Array.isArray(params.exclude_doc_ids) ? params.exclude_doc_ids.map(String) : []),
  ]);
  const candidates = allDocIds.filter((id) => !excluded.has(id)).slice(0, maxDocs);

  const rawDocs: RawPrecedentDoc[] = [];
  let visited = 0;
  for (const docId of candidates) {
    const frame = await navigateInFrame(page, `/Document/document_view.php?doc_id=${docId}&pop_view=y`, config).catch(() => null);
    if (!frame) continue;
    visited += 1;
    const approveType = await readApproveType(frame);
    if (approveType !== "AppFrm-021") continue; // this account table is card-ER-specific
    const bodyText = await readBodyText(frame);
    rawDocs.push({ docId, bodyText });
  }

  const report = buildPrecedentReport(account, rawDocs);
  report.docsScanned = visited;

  let cachedAt: string | null = null;
  try {
    const dir = cacheDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    cachedAt = path.join(dir, `${account}-${eDate}.json`);
    fs.writeFileSync(cachedAt, JSON.stringify({ sDate, eDate, ...report }, null, 2), "utf8");
  } catch {
    // caching is best-effort
  }

  return textResult({
    error: false,
    data: { ...report, range: { s_date: sDate, e_date: eDate }, cached_at: cachedAt },
  });
}
