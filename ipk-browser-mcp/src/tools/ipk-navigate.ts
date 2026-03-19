import { z } from "zod";
import { SessionManager } from "../browser/session.js";
import { navigateInFrame, getMainFrame } from "../browser/iframe-helper.js";
import { Config } from "../types.js";
import { textResult } from "../util.js";

export const ipkNavigateSchema = {
  url: z
    .string()
    .describe(
      "URL to navigate to. Can be a full URL or a path relative to the groupware base URL (e.g. '/Document/document_list.php')"
    ),
  wait_for: z
    .enum(["networkidle", "load", "domcontentloaded"])
    .default("networkidle")
    .describe("Wait condition after navigation"),
};

export const ipkNavigateDescription =
  "Navigate within the IPK groupware main_menu iframe. " +
  "Accepts full URLs or relative paths. Content is rendered inside the groupware iframe structure.";

export async function handleIpkNavigate(
  sessionManager: SessionManager,
  config: Config,
  params: { url: string; wait_for?: string }
) {
  if (!sessionManager.isLoggedIn()) {
    return textResult({ error: true, code: "NOT_LOGGED_IN", message: "Call ipk_login first" });
  }

  const page = sessionManager.getPage()!;

  try {
    const frame = await navigateInFrame(page, params.url, config);

    if (!frame) {
      return textResult({
        error: true,
        code: "NAVIGATION_FAILED",
        message: "Failed to navigate. main_menu frame not found.",
      });
    }

    const frameUrl = frame.url();
    const title = await frame.title();

    return textResult({
      error: false,
      data: {
        url: frameUrl,
        title,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return textResult({ error: true, code: "NAVIGATION_ERROR", message: msg });
  }
}

