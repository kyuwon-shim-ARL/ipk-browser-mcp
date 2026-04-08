#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_PATH = path.resolve(__dirname, "../../.omc/ipk-live-log.jsonl");

if (!fs.existsSync(LOG_PATH)) {
  console.log("No live log found at", LOG_PATH);
  console.log("Run IPK_LIVE=1 tests to populate.");
  process.exit(0);
}

const lines = fs.readFileSync(LOG_PATH, "utf-8").trim().split("\n").filter(Boolean);
const entries = lines.map((l) => JSON.parse(l));

console.log("\n=== IPK Live Run Report ===\n");
console.log(`Total runs: ${entries.length}`);
console.log(`Log: ${LOG_PATH}\n`);

const header = ["timestamp", "form_type", "doc_id", "cleanup_status", "mode", "user"].join(" | ");
console.log(header);
console.log("-".repeat(header.length));

for (const e of entries) {
  const row = [
    e.timestamp?.slice(0, 19) ?? "?",
    (e.form_type ?? "?").padEnd(20),
    (e.doc_id ?? "null").padEnd(10),
    (e.cleanup_status ?? "?").padEnd(8),
    e.mode ?? "?",
    e.masked_user ?? "?",
  ].join(" | ");
  console.log(row);
}

const failed = entries.filter(
  (e) =>
    e.cleanup_status !== "ok" &&
    e.cleanup_status !== "skipped" &&
    e.cleanup_status !== "n/a"
);
if (failed.length > 0) {
  console.log(`\n${failed.length} entries with non-ok cleanup_status`);
} else {
  console.log("\nAll cleanup statuses are ok/skipped/n/a");
}
