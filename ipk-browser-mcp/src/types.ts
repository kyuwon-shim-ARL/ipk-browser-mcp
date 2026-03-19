/** Supported form types in IPK groupware */
export type FormType = "leave" | "expense" | "working" | "travel";

/** Leave type codes */
export const LEAVE_TYPES: Record<string, string> = {
  annual: "01",
  compensatory: "11",
  saved_annual: "14",
  sick: "02",
  special: "03",
  paternity: "15",
  menstruation: "04",
  official: "05",
  childcare: "07",
  fetus_checkup: "13",
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
};

/** Human-readable leave names */
export const LEAVE_NAMES: Record<string, string> = {
  annual: "Annual leave",
  compensatory: "Compensatory leave",
  paternity: "Paternity Leave",
  sick: "Sick leave",
  fetus_checkup: "Fetus Checkup",
  special: "Special leave",
  official: "Official leave",
  childcare: "Child delivery and Nursing leave",
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

export function loadConfig(): Config {
  return {
    baseUrl: process.env.IPK_BASE_URL || "https://gw.ip-korea.org",
    username: process.env.IPK_USERNAME || "",
    password: process.env.IPK_PASSWORD || "",
    headless: process.env.BROWSER_HEADLESS !== "false",
    screenshotDir: process.env.SCREENSHOT_DIR || "/tmp/ipk-mcp-screenshots",
    screenshotTtlMinutes: parseInt(process.env.SCREENSHOT_TTL_MINUTES || "60", 10),
    navTimeoutMs: parseInt(process.env.NAV_TIMEOUT_MS || "30000", 10),
    storageStateDir: process.env.STORAGE_STATE_DIR || `${process.env.HOME}/.config/ipk-mcp/profiles`,
  };
}
