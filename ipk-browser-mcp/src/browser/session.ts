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
export class SessionManager {
  private browser: Browser | null = null;
  private session: SessionState | null = null;
  private config: Config;
  private shutdownRegistered = false;
  private loginInProgress = false;

  constructor(config: Config) {
    this.config = config;
    this.registerShutdown();
  }

  private registerShutdown(): void {
    if (this.shutdownRegistered) return;
    this.shutdownRegistered = true;

    const cleanup = async () => {
      await this.destroy();
      process.exit(0);
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

      if (fs.existsSync(storagePath)) {
        try {
          context = await browser.newContext({
            viewport: { width: 1920, height: 1080 },
            storageState: storagePath,
          });
        } catch {
          context = await browser.newContext({
            viewport: { width: 1920, height: 1080 },
          });
        }
      } else {
        context = await browser.newContext({
          viewport: { width: 1920, height: 1080 },
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

      const loggedIn = page.url().includes("main.php");

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

      const userInfo = {
        username,
        name: process.env.IPK_USER_NAME || username.replace(".", " "),
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

  isLoggedIn(): boolean {
    return this.session?.loggedIn ?? false;
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
