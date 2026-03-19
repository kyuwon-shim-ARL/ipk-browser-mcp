import { z } from "zod";
import { SessionManager } from "../browser/session.js";
import { Config, ScreenshotResult } from "../types.js";
import * as fs from "fs";
import * as path from "path";
import { textResult } from "../util.js";

export const screenshotSchema = {
  filename: z.string().optional().describe("Custom filename (without path). Default: auto-generated timestamp."),
  full_page: z.boolean().default(false).describe("Capture full page (true) or viewport only (false)"),
};

export const screenshotDescription =
  "Take a screenshot of the current browser state. Returns the file path only (not image data) to save tokens. " +
  "Screenshots are automatically deleted after the configured TTL (default 60 minutes).";

export async function handleScreenshot(
  sessionManager: SessionManager,
  config: Config,
  params: { filename?: string; full_page?: boolean }
) {
  if (!sessionManager.isLoggedIn()) {
    return textResult({ error: true, code: "NOT_LOGGED_IN", message: "Call ipk_login first" });
  }

  const page = sessionManager.getPage()!;

  try {
    // Ensure screenshot directory exists
    fs.mkdirSync(config.screenshotDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = params.filename || `ipk-${timestamp}.png`;
    const filepath = path.join(config.screenshotDir, filename);

    await page.screenshot({
      path: filepath,
      fullPage: params.full_page || false,
    });

    // Schedule auto-deletion
    const ttlMs = config.screenshotTtlMinutes * 60 * 1000;
    setTimeout(() => {
      try {
        if (fs.existsSync(filepath)) {
          fs.unlinkSync(filepath);
        }
      } catch { /* ignore cleanup errors */ }
    }, ttlMs);

    const result: ScreenshotResult = {
      path: filepath,
      timestamp: new Date().toISOString(),
      ttlMinutes: config.screenshotTtlMinutes,
    };

    return textResult({
      error: false,
      data: result,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return textResult({ error: true, code: "SCREENSHOT_ERROR", message: msg });
  }
}

/** Clean up expired screenshots on startup */
export function cleanupExpiredScreenshots(config: Config): void {
  try {
    if (!fs.existsSync(config.screenshotDir)) return;

    const now = Date.now();
    const ttlMs = config.screenshotTtlMinutes * 60 * 1000;
    const files = fs.readdirSync(config.screenshotDir);

    for (const file of files) {
      if (!file.endsWith(".png")) continue;
      const filepath = path.join(config.screenshotDir, file);
      const stat = fs.statSync(filepath);
      if (now - stat.mtimeMs > ttlMs) {
        fs.unlinkSync(filepath);
      }
    }
  } catch { /* ignore */ }
}

