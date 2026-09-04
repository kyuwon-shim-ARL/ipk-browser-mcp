import { z } from "zod";
import { SessionManager } from "../browser/session.js";
import { navigateInFrame } from "../browser/iframe-helper.js";
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
    .default("load")
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
    return textResult({
      error: true,
      code: "NOT_LOGGED_IN",
      message:
        sessionManager.getLoginState() === "expired"
          ? "Browser session expired after 30 minutes idle (the MCP connection is fine). Call ipk_login again."
          : "Call ipk_login first",
    });
  }

  const page = sessionManager.getPage()!;

  try {
    // Domain restriction is enforced inside navigateInFrame (iframe-helper.ts):
    // full URLs are checked against config.baseUrl hostname; relative paths are
    // prefixed with config.baseUrl, so cross-origin navigation is not possible.
    const frame = await navigateInFrame(page, params.url, config);

    if (!frame) {
      return textResult({
        error: true,
        code: "NAVIGATION_FAILED",
        message: "Failed to navigate. main_menu frame not found.",
      });
    }

    let frameUrl = frame.url();
    if (!frameUrl.includes("gw.ip-korea.org")) {
      try {
        frameUrl = await frame.evaluate(() => location.href);
      } catch (e) {
        console.warn("[ipk_navigate] frame.evaluate fallback failed:", e);
        // keep original frame.url()
      }
    }
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

