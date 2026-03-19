import { z } from "zod";
import { SessionManager } from "../browser/session.js";
import { navigateInFrame, getMainFrame } from "../browser/iframe-helper.js";
import { Config, ApprovalItem } from "../types.js";
import { maskPiiFields } from "../security/masking.js";
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

export async function handleIpkFetchApprovals(
  sessionManager: SessionManager,
  config: Config,
  params: { status?: string; limit?: number }
) {
  if (!sessionManager.isLoggedIn()) {
    return textResult({ error: true, code: "NOT_LOGGED_IN", message: "Call ipk_login first" });
  }

  const page = sessionManager.getPage()!;
  const limit = params.limit || 20;

  try {
    // Navigate to document list
    const frame = await navigateInFrame(
      page,
      "/Document/document_list.php?mtype=user&stype=write",
      config
    );

    if (!frame) {
      return textResult({ error: true, code: "NAVIGATION_FAILED", message: "Failed to navigate to document list" });
    }

    // Extract document list from table - PARAMETERIZED
    const items: ApprovalItem[] = await frame.evaluate(
      (maxItems: number) => {
        const rows = document.querySelectorAll("table.list_table tbody tr, table.tbl_list tbody tr");
        const results: any[] = [];

        for (const row of rows) {
          if (results.length >= maxItems) break;

          const cells = row.querySelectorAll("td");
          if (cells.length < 4) continue;

          // Try to extract document info from table cells
          const linkEl = row.querySelector("a[href*='doc_id=']");
          if (!linkEl) continue;

          const href = linkEl.getAttribute("href") || "";
          const docIdMatch = href.match(/doc_id=([^&]+)/);
          const docId = docIdMatch ? docIdMatch[1] : "";

          results.push({
            docId,
            title: linkEl.textContent?.trim() || "",
            status: cells[cells.length - 1]?.textContent?.trim() || "unknown",
            date: cells[1]?.textContent?.trim() || "",
            author: cells[2]?.textContent?.trim() || "",
            formType: "unknown",
          });
        }

        return results;
      },
      limit
    );

    // Apply status filter
    let filtered = items;
    if (params.status && params.status !== "all") {
      const statusMap: Record<string, string[]> = {
        pending: ["진행", "pending", "대기"],
        approved: ["완료", "approved", "승인"],
        rejected: ["반려", "rejected"],
        draft: ["임시", "draft"],
      };
      const keywords = statusMap[params.status] || [];
      filtered = items.filter((item) =>
        keywords.some((kw) => item.status.toLowerCase().includes(kw))
      );
    }

    // Mask PII in author names
    const masked = filtered.map((item) => ({
      ...item,
      author: item.author, // Author is the current user, no need to mask own name
    }));

    return textResult({
      error: false,
      data: {
        count: masked.length,
        totalFound: items.length,
        filter: { status: params.status || "all" },
        items: masked,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return textResult({ error: true, code: "FETCH_ERROR", message: msg });
  }
}

