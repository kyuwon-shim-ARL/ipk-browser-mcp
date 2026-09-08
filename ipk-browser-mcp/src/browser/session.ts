import { chromium, Browser, BrowserContext, Page, Frame } from "playwright";
import { Config, makeError, makeSuccess, SessionInfo, ToolResult } from "../types.js";
import * as fs from "fs";
import * as path from "path";

interface SessionState {
  context: BrowserContext;
  page: Page;
  loggedIn: boolean;
  userInfo: { username: string; name: string; dept: string };
  lastActivity: number;
}

/**
 * Browser session manager.
 * - Lazy browser launch (first tool call)
 * - Single session (Phase 1)
 * - Auth persistence via storageState
 * - Graceful shutdown on SIGTERM/SIGINT
 */
/**
 * Verify the page is actually authenticated, not just sitting on main.php.
 * The groupware frameset renders the logged-in user's identity ("Welcome, <name>")
 * and a logout control; an unauthenticated response has a password input instead.
 */
async function hasAuthMarker(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const frames = [document, ...Array.from(document.querySelectorAll("frame, iframe"))
        .map((f) => {
          try {
            return (f as HTMLIFrameElement).contentDocument;
          } catch {
            return null;
          }
        })
        .filter((d): d is Document => !!d)];
      for (const doc of frames) {
        if (doc.querySelector('input[type="password"], input[name="Password"]')) continue;
        const text = doc.body?.innerText || "";
        if (/Welcome,|Logout|로그아웃/i.test(text)) return true;
        if (doc.querySelector('a[href*="logout"], a[href*="Logout"]')) return true;
      }
      return false;
    });
  } catch {
    return false;
  }
}

export class SessionManager {
  private static SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
  private static SHUTDOWN_TIMEOUT_MS = 3000;
  private browser: Browser | null = null;
  private session: SessionState | null = null;
  private config: Config;
  private shutdownRegistered = false;
  private loginInProgress = false;
  private shuttingDown = false;

  constructor(config: Config) {
    this.config = config;
    this.registerShutdown();
  }

  private registerShutdown(): void {
    if (this.shutdownRegistered) return;
    this.shutdownRegistered = true;

    // The signal handler replaces Node's default terminate behaviour, so it must be
    // bounded: if a close() hangs, an unbounded await here makes SIGINT/SIGTERM fail
    // and forces the caller to SIGKILL (which leaks the Chromium child process).
    const cleanup = async () => {
      if (this.shuttingDown) return;
      this.shuttingDown = true;
      const timedOut = Symbol("timeout");
      const result = await Promise.race([
        this.destroy().then(() => "ok" as const),
        new Promise<typeof timedOut>((resolve) =>
          setTimeout(() => resolve(timedOut), SessionManager.SHUTDOWN_TIMEOUT_MS).unref()
        ),
      ]);
      process.exit(result === timedOut ? 1 : 0);
    };
    process.on("SIGTERM", cleanup);
    process.on("SIGINT", cleanup);
  }

  private async ensureBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: this.config.headless,
      });
    }
    return this.browser;
  }

  private getStorageStatePath(username: string): string {
    return path.join(this.config.storageStateDir, `${username}.json`);
  }

  async login(username: string, password: string): Promise<ToolResult<SessionInfo>> {
    if (!username || !password) {
      return makeError("MISSING_CREDENTIALS", "Username and password are required");
    }

    if (this.loginInProgress) {
      return makeError("LOGIN_IN_PROGRESS", "Another login is already in progress");
    }
    this.loginInProgress = true;

    try {
      const browser = await this.ensureBrowser();

      // Try to reuse stored session
      const storagePath = this.getStorageStatePath(username);
      let context: BrowserContext;

      // Use a real Chrome user agent — some servers detect "HeadlessChrome" as a bot
      // and return the frameset (main.php) instead of the requested page.
      const userAgent =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

      if (fs.existsSync(storagePath)) {
        try {
          context = await browser.newContext({
            viewport: { width: 1920, height: 1080 },
            userAgent,
            storageState: storagePath,
          });
        } catch {
          context = await browser.newContext({
            viewport: { width: 1920, height: 1080 },
            userAgent,
          });
        }
      } else {
        context = await browser.newContext({
          viewport: { width: 1920, height: 1080 },
          userAgent,
        });
      }

      const page = await context.newPage();

      // Navigate to login page
      await page.goto(this.config.baseUrl, { timeout: this.config.navTimeoutMs });
      await page.waitForLoadState("networkidle");

      // Check if already logged in (from storageState)
      if (page.url().includes("main.php")) {
        // Already logged in
      } else {
        // Fill login form
        await page.fill("input[name='Username']", username);
        await page.fill("input[name='Password']", password);

        // Submit via Check_Form() - parameterized (no user data in JS)
        await page.evaluate(() => {
          (window as any).Check_Form();
        });

        // Wait for navigation
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(2000);

        if (!page.url().includes("main.php")) {
          await page.goto(`${this.config.baseUrl}/main.php`, {
            timeout: this.config.navTimeoutMs,
          });
          await page.waitForTimeout(1000);
        }
      }

      // URL alone is a false positive: the goto() above lands on main.php whether or not
      // the credentials were accepted. Require an authenticated marker in the page too.
      const loggedIn = page.url().includes("main.php") && (await hasAuthMarker(page));

      if (!loggedIn) {
        await context.close();
        return makeError("LOGIN_FAILED", "Login failed - check credentials");
      }

      // Save storage state for reuse
      fs.mkdirSync(this.config.storageStateDir, { recursive: true, mode: 0o700 });
      await context.storageState({ path: storagePath });
      fs.chmodSync(storagePath, 0o600);

      // Close previous session if exists
      if (this.session) {
        await this.session.context.close();
      }

      // IPK_USER_NAME is routinely set to the login id ("kyuwon.shim"), and this name goes
      // into document subjects and reports. Turn an id-shaped value into the display form
      // rather than signing a document "kyuwon.shim".
      const rawName = process.env.IPK_USER_NAME || username;
      const displayName = /\s/.test(rawName)
        ? rawName
        : rawName
            .split(/[._]+/)
            .filter(Boolean)
            .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
            .join(" ");
      const userInfo = {
        username,
        name: displayName,
        dept: process.env.IPK_USER_DEPT || "",
      };

      this.session = {
        context,
        page,
        loggedIn: true,
        userInfo,
        lastActivity: Date.now(),
      };

      return makeSuccess<SessionInfo>({
        sessionId: "default",
        username,
        loggedIn: true,
        userInfo,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return makeError("LOGIN_ERROR", `Login error: ${msg}`);
    } finally {
      this.loginInProgress = false;
    }
  }

  getSession(): SessionState | null {
    if (this.session) {
      this.session.lastActivity = Date.now();
    }
    return this.session;
  }

  getPage(): Page | null {
    return this.session?.page || null;
  }

  getMainFrame(): Frame | null {
    const page = this.getPage();
    if (!page) return null;
    return page.frame("main_menu");
  }

  /**
   * Distinguishes "never logged in" from "session expired" so tools can tell the caller
   * which one happened. A 30-minute idle expiry otherwise reads as a dropped connection.
   */
  getLoginState(): "none" | "expired" | "active" {
    if (!this.session?.loggedIn) return "none";
    if (Date.now() - this.session.lastActivity > SessionManager.SESSION_TTL_MS) return "expired";
    return "active";
  }

  isLoggedIn(): boolean {
    if (!this.session?.loggedIn) return false;
    // Check if session is stale
    if (Date.now() - this.session.lastActivity > SessionManager.SESSION_TTL_MS) {
      return false;
    }
    return true;
  }

  /** Remaining session TTL in ms. Returns 0 if not logged in. */
  getSessionRemainingMs(): number {
    if (!this.session?.loggedIn) return 0;
    const elapsed = Date.now() - this.session.lastActivity;
    return Math.max(0, SessionManager.SESSION_TTL_MS - elapsed);
  }

  /** Touch session activity timestamp (call after successful navigation/interaction). */
  touchActivity(): void {
    if (this.session) {
      this.session.lastActivity = Date.now();
    }
  }

  getUserInfo(): SessionState["userInfo"] | null {
    return this.session?.userInfo || null;
  }

  async destroy(): Promise<void> {
    if (this.session) {
      try {
        await this.session.context.close();
      } catch { /* ignore */ }
      this.session = null;
    }
    if (this.browser) {
      try {
        await this.browser.close();
      } catch { /* ignore */ }
      this.browser = null;
    }
  }
}
