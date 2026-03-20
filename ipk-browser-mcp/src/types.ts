/** Supported form types in IPK groupware */
export type FormType = "leave" | "expense" | "working" | "travel" | "travel_request";

/** Leave type codes */
export const LEAVE_TYPES: Record<string, string> = {
  annual: "01",
  sick: "02",
  special: "03",
  menstruation: "04",
  official: "05",
  childcare: "07",
  unpaid: "08",
  childcare_hours: "09",
  temporary_suspension: "10",
  compensatory: "11",
  other: "12",
  fetus_checkup: "13",
  saved_annual: "14",
  paternity: "15",
};

/** Leave types that require attachment */
export const ATTACHMENT_REQUIRED_LEAVES: Record<string, string> = {
  "02": "진단서/입원확인서",
  "03": "증빙서류",
  "05": "증빙서류",
  "07": "증빙서류",
  "13": "증빙서류",
  "15": "출생증명서",
};

/** Form approval codes */
export const FORM_CODES: Record<FormType, string> = {
  leave: "AppFrm-073",
  expense: "AppFrm-021",
  working: "AppFrm-027",
  travel: "AppFrm-076",
  travel_request: "AppFrm-023",
};

/** Human-readable leave names */
export const LEAVE_NAMES: Record<string, string> = {
  annual: "Annual leave",
  sick: "Sick leave",
  special: "Special leave",
  menstruation: "Menstruation leave",
  official: "Official leave",
  childcare: "Child delivery and Nursing leave",
  unpaid: "Unpaid leave",
  childcare_hours: "Childcare hours",
  temporary_suspension: "Temporary suspension",
  compensatory: "Compensatory leave",
  other: "Other leave",
  fetus_checkup: "Fetus Checkup",
  saved_annual: "Saved annual leave",
  paternity: "Paternity Leave",
};

/** MCP tool error response */
export interface ToolError {
  error: true;
  code: string;
  message: string;
}

/** MCP tool success response */
export interface ToolSuccess<T = unknown> {
  error: false;
  data: T;
}

export type ToolResult<T = unknown> = ToolError | ToolSuccess<T>;

export function makeError(code: string, message: string): ToolError {
  return { error: true, code, message };
}

export function makeSuccess<T>(data: T): ToolSuccess<T> {
  return { error: false, data };
}

/** Session info returned from login */
export interface SessionInfo {
  sessionId: string;
  username: string;
  loggedIn: boolean;
  userInfo: {
    username: string;
    name: string;
    dept: string;
  };
}

/** Approval list item */
export interface ApprovalItem {
  docId: string;
  title: string;
  status: string;
  date: string;
  author: string;
  formType: string;
}

/** Form submission result */
export interface SubmitResult {
  success: boolean;
  docId?: string;
  mode: "draft" | "request";
  formType: FormType;
  message: string;
}

/** Page content extraction result */
export interface PageContent {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}

/** Screenshot result */
export interface ScreenshotResult {
  path: string;
  timestamp: string;
  ttlMinutes: number;
}

/** Configuration from environment variables */
export interface Config {
  baseUrl: string;
  username: string;
  password: string;
  headless: boolean;
  screenshotDir: string;
  screenshotTtlMinutes: number;
  navTimeoutMs: number;
  storageStateDir: string;
}

const CONFIG_DIR = `${process.env.HOME}/.config/ipk-browser-mcp`;
const ENV_FILE = `${CONFIG_DIR}/.env`;

/** Load .env file from ~/.config/ipk-browser-mcp/.env as fallback */
function loadDotenv(): Record<string, string> {
  try {
    const { readFileSync } = require("fs");
    const content = readFileSync(ENV_FILE, "utf-8");
    const vars: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      vars[key] = val;
    }
    return vars;
  } catch {
    return {};
  }
}

/** Get env var with dotenv fallback */
function env(key: string, fallback: string = ""): string {
  return process.env[key] || loadDotenv()[key] || fallback;
}

export function loadConfig(): Config {
  return {
    baseUrl: env("IPK_BASE_URL", "https://gw.ip-korea.org"),
    username: env("IPK_USERNAME"),
    password: env("IPK_PASSWORD"),
    headless: env("BROWSER_HEADLESS") !== "false",
    screenshotDir: env("SCREENSHOT_DIR", "/tmp/ipk-mcp-screenshots"),
    screenshotTtlMinutes: parseInt(env("SCREENSHOT_TTL_MINUTES", "60"), 10),
    navTimeoutMs: parseInt(env("NAV_TIMEOUT_MS", "30000"), 10),
    storageStateDir: env("STORAGE_STATE_DIR", `${process.env.HOME}/.config/ipk-mcp/profiles`),
  };
}
