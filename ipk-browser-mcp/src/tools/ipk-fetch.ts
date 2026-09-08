import { z } from "zod";
import { SessionManager } from "../browser/session.js";
import { navigateInFrame } from "../browser/iframe-helper.js";
import { Config, ApprovalItem } from "../types.js";
import { textResult } from "../util.js";

export const ipkFetchApprovalsSchema = {
  status: z
    .enum(["all", "pending", "approved", "rejected", "draft"])
    .default("all")
    .describe("Filter by approval status"),
  limit: z.number().default(20).describe("Max number of items to return"),
};

export const ipkFetchApprovalsDescription =
  "Fetch approval/document list from IPK groupware. Returns structured JSON with document IDs, titles, status, and dates.";

/** Map MCP status param → groupware URL type value */
const STATUS_URL_MAP: Record<string, string> = {
  pending: "progress",
  approved: "approved",
  rejected: "rejected",
  draft: "draft",
};

/** Fetch order for "all": higher-priority first so dedup keeps the best record */
const ALL_STATUS_TYPES = ["approved", "rejected", "draft", "progress"] as const;

/** Dedup priority: higher number wins when same docId appears in multiple lists */
const DEDUP_PRIORITY: Record<string, number> = {
  approved: 3,
  rejected: 2,
  draft: 1,
  progress: 0,
};

function statusToPriority(status: string): number {
  const s = status.toLowerCase();
  for (const [key, pri] of Object.entries(DEDUP_PRIORITY)) {
    if (s.includes(key)) return pri;
  }
  return -1;
}

async function fetchByType(
  sessionManager: SessionManager,
  config: Config,
  urlType: string,
  maxItems: number
): Promise<ApprovalItem[]> {
  const page = sessionManager.getPage()!;
  // Use page.goto() (full-page navigation) — frame.goto() is unreliable in MCP context
  // because the server detects the nested-frame request and returns the frameset instead.
  // Use URL origin to strip any /main.php path that IPK_BASE_URL may include.
  const origin = new URL(config.baseUrl).origin;
  await page.goto(
    `${origin}/Document/document_list.php?type=${urlType}`,
    { waitUntil: "domcontentloaded", timeout: config.navTimeoutMs }
  );

  const results = await page.evaluate(
    (args: { maxItems: number; urlType: string }) => {
      // Find rows via doc_id links — works regardless of table class or tbody presence.
      // Row structure: [0]=docNum [1]=title [2]=dept [3]=author [4]=status [5]=date
      const links = document.querySelectorAll("a[href*='doc_id=']") as NodeListOf<HTMLAnchorElement>;
      const out: any[] = [];
      const seen = new Set<string>();

      for (const link of links) {
        if (out.length >= args.maxItems) break;

        const m = (link.getAttribute("href") || "").match(/doc_id=([^&]+)/);
        if (!m) continue;
        const docId = m[1];
        if (seen.has(docId)) continue;
        seen.add(docId);

        const row = link.closest("tr");
        if (!row) continue;
        const cells = row.querySelectorAll("td");
        if (cells.length < 4) continue;

        const title = link.textContent?.trim() || "";
        // cells: [0]=docNum [1]=title [2]=dept [3]=author [4]=status [5]=date
        const author = cells[3]?.textContent?.trim() || "";
        const status = cells[4]?.textContent?.trim() || args.urlType;
        const date = cells[5]?.textContent?.trim() || cells[cells.length - 1]?.textContent?.trim() || "";

        out.push({ docId, title, status, date, author, formType: "unknown" });
      }

      return out;
    },
    { maxItems, urlType }
  );

  // Restore frameset so subsequent MCP tools that rely on main_menu frame still work
  await page.goto(config.baseUrl, { waitUntil: "domcontentloaded", timeout: config.navTimeoutMs });

  return results;
}

export async function handleIpkFetchApprovals(
  sessionManager: SessionManager,
  config: Config,
  params: { status?: string; limit?: number }
) {
  if (!sessionManager.isLoggedIn()) {
    return textResult({
      error: true,
      code: "NOT_LOGGED_IN",
      message:
        sessionManager.getLoginState() === "expired"
          ? "Browser session expired after 30 minutes idle (the MCP connection is fine). Call ipk_login again."
          : "Call ipk_login first",
    });
  }

  const limit = params.limit || 20;
  const statusParam = params.status || "all";

  try {
    let rawItems: ApprovalItem[] = [];

    if (statusParam === "all") {
      // Sequential fetches — single frame cannot be navigated in parallel
      for (const urlType of ALL_STATUS_TYPES) {
        const items = await fetchByType(sessionManager, config, urlType, limit);
        rawItems.push(...items);
      }
    } else {
      const urlType = STATUS_URL_MAP[statusParam] ?? statusParam;
      rawItems = await fetchByType(sessionManager, config, urlType, limit);
    }

    // Dedup by docId: higher DEDUP_PRIORITY wins
    const dedupMap = new Map<string, ApprovalItem & { _pri: number }>();
    for (const item of rawItems) {
      const pri = statusToPriority(item.status);
      const existing = dedupMap.get(item.docId);
      if (!existing || pri > existing._pri) {
        dedupMap.set(item.docId, { ...item, _pri: pri });
      }
    }

    const deduped = [...dedupMap.values()]
      .sort((a, b) => b._pri - a._pri)
      .slice(0, limit)
      .map(({ _pri: _p, ...item }) => item);

    return textResult({
      error: false,
      data: {
        count: deduped.length,
        totalFound: rawItems.length,
        filter: { status: statusParam },
        items: deduped,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return textResult({ error: true, code: "FETCH_ERROR", message: msg });
  }
}
