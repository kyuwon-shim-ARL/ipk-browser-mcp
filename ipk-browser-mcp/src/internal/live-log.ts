import * as fs from "fs";
import * as path from "path";
import { maskKoreanName } from "../security/masking.js";

export interface LiveLogEntry {
  timestamp: string;
  form_type: string;
  doc_id: string | null;
  cleanup_status: "ok" | "failed" | "skipped" | "n/a";
  masked_user: string;
  mode: "draft" | "request";
}

const LOG_PATH = path.resolve(
  process.env.OMC_LOG_DIR ||
    path.join(process.env.HOME || "/tmp", "projects/ipk-browser-mcp/.omc"),
  "ipk-live-log.jsonl"
);

export function appendLiveLog(entry: LiveLogEntry): void {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // Non-fatal: log failure should not block form submission
  }
}

export function maskUser(name: string): string {
  return maskKoreanName(name);
}
