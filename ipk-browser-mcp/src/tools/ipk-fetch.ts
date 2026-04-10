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
  const frame = await navigateInFrame(
    page,
    `/Document/document_list.php?type=${urlType}`,
    config
  );

  if (!frame) return [];

  return frame.evaluate(
    (args: { maxItems: number; urlType: string }) => {
      const rows = document.querySelectorAll(
        "table.list_table tbody tr, table.tbl_list tbody tr, table tbody tr"
      );
      const results: any[] = [];

      for (const row of rows) {
        if (results.length >= args.maxItems) break;

        const cells = row.querySelectorAll("td");
        if (cells.length < 3) continue;

        let docId = "";

        // Primary: href-based doc_id
        const linkEl = row.querySelector("a[href*='doc_id=']") as HTMLAnchorElement | null;
        if (linkEl) {
          const m = (linkEl.getAttribute("href") || "").match(/doc_id=([^&]+)/);
          if (m) docId = m[1];
        }

        // Fallback: onclick attribute on any element in the row (scope: row only)
        if (!docId) {
          const onclickEl = row.querySelector("[onclick]") as HTMLElement | null;
          const onclickAttr = onclickEl
            ? onclickEl.getAttribute("onclick") || ""
            : (row as HTMLElement).getAttribute("onclick") || "";

          if (onclickAttr) {
            // 1차: doc_id= pattern
            const m1 = onclickAttr.match(/['"]?doc_id['"]?\s*[=,]\s*['"]?(\d+)/i);
            if (m1) {
              docId = m1[1];
            } else {
              // 2차: first quoted 5+ digit number in onclick string only
              const m2 = onclickAttr.match(/['"](\d{5,})['"]/);
              if (m2) {
                docId = m2[1];
              } else {
                // Both failed — skip this row
                console.warn("[ipk_fetch] Could not extract doc_id from onclick:", onclickAttr.slice(0, 100));
                continue;
              }
            }
          } else {
            continue; // no href and no onclick — not a document row
          }
        }

        const titleEl = linkEl || (row.querySelector("a") as HTMLAnchorElement | null);
        const title = titleEl?.textContent?.trim() || "";
        const date = cells[1]?.textContent?.trim() || "";
        const author = cells[2]?.textContent?.trim() || "";
        const statusText = cells[cells.length - 1]?.textContent?.trim() || args.urlType;

        results.push({
          docId,
          title,
          status: statusText || args.urlType,
          date,
          author,
          formType: "unknown",
        });
      }

      return results;
    },
    { maxItems, urlType }
  );
}

export async function handleIpkFetchApprovals(
  sessionManager: SessionManager,
  config: Config,
  params: { status?: string; limit?: number }
) {
  if (!sessionManager.isLoggedIn()) {
    return textResult({ error: true, code: "NOT_LOGGED_IN", message: "Call ipk_login first" });
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
