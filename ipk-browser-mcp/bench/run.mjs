#!/usr/bin/env node
/**
 * Benchmark runner.
 *
 * Drives the built MCP server over stdio, exactly as a client would, so what is measured
 * is the tool as it is actually called - not a re-implementation of it.
 *
 * Live scenarios create real drafts and delete them again. Nothing is ever submitted for
 * approval: draft_only stays true and confirm_submit is never sent.
 *
 *   node bench/run.mjs [--only id1,id2] [--keep]
 */
import { spawn } from "child_process";
import { chromium } from "playwright";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { score, format } from "./score.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "..", "dist", "ipk-browser-mcp.mjs");
const AUDIT = path.join(process.env.HOME, ".cache", "ipk-mcp", "audit.jsonl");
const DATA = path.join(__dirname, "data");

const args = process.argv.slice(2);
const ONLY = (args.includes("--only") ? args[args.indexOf("--only") + 1] : "").split(",").filter(Boolean);
const KEEP = args.includes("--keep");

function loadEnv() {
  const out = {};
  for (const line of fs.readFileSync(path.join(process.env.HOME, ".config/ipk-browser-mcp/.env"), "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const [k, ...r] = t.split("=");
    out[k.trim()] = r.join("=").trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/** Minimal MCP stdio client. */
function connect() {
  const proc = spawn("node", [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let id = 0;
  let buf = "";
  proc.stdout.on("data", (d) => {
    buf += d;
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p(msg); }
    }
  });
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const rid = ++id;
      pending.set(rid, resolve);
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: rid, method, params }) + "\n");
      setTimeout(() => { if (pending.delete(rid)) reject(new Error(`timeout: ${method}`)); }, 120000);
    });
  return { proc, call, close: () => proc.kill("SIGTERM") };
}

const auditSize = () => { try { return fs.statSync(AUDIT).size; } catch { return 0; } };
function auditSince(offset) {
  try {
    const fd = fs.openSync(AUDIT, "r");
    const len = fs.statSync(AUDIT).size - offset;
    if (len <= 0) { fs.closeSync(fd); return []; }
    const b = Buffer.alloc(len);
    fs.readSync(fd, b, 0, len, offset);
    fs.closeSync(fd);
    return b.toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

/** Parse the tool's textResult payload. */
function payload(res) {
  try { return JSON.parse(res.result.content[0].text); } catch { return null; }
}

/**
 * Automatic proxy for M2: compare what the scenario asked for against what the saved
 * draft actually shows. It is a proxy, not the real metric - the real one is how many
 * fields a person changes before submitting, which only the modify history reveals.
 */
async function countMismatches(frame, base, docId, params) {
  await frame.goto(`${base}/Document/document_view.php?doc_id=${docId}`, { timeout: 30000 });
  const text = await frame.evaluate(() => document.body.innerText);
  let bad = 0;
  for (const key of ["purpose", "destination", "substitute_name"]) {
    const want = params[key];
    if (want && !text.toLowerCase().includes(String(want).trim().toLowerCase())) bad++;
  }
  return bad;
}

async function main() {
  const env = loadEnv();
  const base = env.IPK_BASE_URL || "https://gw.ip-korea.org";
  const all = JSON.parse(fs.readFileSync(path.join(__dirname, "scenarios.json"), "utf8")).scenarios;
  const scenarios = ONLY.length ? all.filter((s) => ONLY.includes(s.id)) : all;

  const { call, close } = connect();
  await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "bench", version: "1" } });
  const login = payload(await call("tools/call", { name: "ipk_login", arguments: {} }));
  if (!login || login.error) { console.error("login failed:", login); close(); process.exit(1); }

  const runs = [];
  const createdDocs = [];

  for (const sc of scenarios) {
    const before = auditSize();
    const t0 = Date.now();
    let result;
    try {
      const res = await call("tools/call", {
        name: "ipk_submit_form",
        arguments: { form_type: sc.form_type, draft_only: true, ...sc.params },
      });
      const p = payload(res);
      // Handlers are not consistent about shape: errors come back flat, successes sometimes
      // under `data`, and the id is `docId` in some handlers and `doc_id` in others.
      const body = p && p.data ? { ...p, ...p.data } : p;
      const docId = body?.docId ?? body?.doc_id ?? null;
      if (body && body.error) {
        const serverRejected = /SUBMIT_REJECTED|SUBMIT_FAILED|SUBMIT_UNVERIFIED/.test(String(body.message || ""));
        result = { status: "refused", code: body.code, message: body.message, serverRejected };
      } else if (docId) {
        result = { status: "ok", docId };
        createdDocs.push({ id: docId, scenario: sc.id });
      } else {
        result = { status: "ok", docId: null, note: body?.message };
      }
    } catch (e) {
      result = { status: "error", message: String(e.message || e) };
    }
    const events = auditSince(before);
    result.toolCalls = events.length;
    result.retries = 0;
    result.ms = Date.now() - t0;
    runs.push({ id: sc.id, expected: sc.expected, result, events, humanEdits: null });
    console.error(`${sc.id.padEnd(30)} ${result.status.padEnd(8)} ${result.code || result.docId || ""}`);
  }

  close();

  // Measure the M2 proxy and clean the drafts up, in one browser session.
  if (createdDocs.length) {
    const browser = await chromium.launch({ headless: true });
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    page.on("dialog", (d) => d.accept());
    await page.goto(base, { timeout: 30000 });
    await page.waitForLoadState("networkidle");
    await page.fill("input[name='Username']", env.IPK_USERNAME);
    await page.fill("input[name='Password']", env.IPK_PASSWORD);
    await page.evaluate(() => window.Check_Form());
    await page.waitForTimeout(3000);
    if (!page.url().includes("main.php")) await page.goto(`${base}/main.php`);
    const frame = page.frame("main_menu") || page.mainFrame();

    for (const d of createdDocs) {
      const run = runs.find((r) => r.id === d.scenario);
      const sc = scenarios.find((s) => s.id === d.scenario);
      try { run.humanEdits = await countMismatches(frame, base, d.id, sc.params); } catch { /* leave null */ }
    }

    if (!KEEP) {
      await frame.goto(`${base}/Document/document_list.php?type=drafts`, { timeout: 30000 });
      await page.waitForTimeout(1500);
      const ids = createdDocs.map((d) => String(d.id));
      const checked = await frame.evaluate((wanted) => {
        let n = 0;
        document.querySelectorAll("tr").forEach((row) => {
          const a = row.querySelector("a[href*='doc_id=']");
          if (!a) return;
          const m = a.getAttribute("href").match(/doc_id=(\d+)/);
          if (!m || !wanted.includes(m[1])) return;
          const cb = row.querySelector('input[type="checkbox"]');
          if (cb) { cb.checked = true; n++; }
        });
        return n;
      }, ids);
      if (checked > 0) {
        await frame.evaluate(() => window.Delete_Doc());
        await page.waitForTimeout(2500);
      }
      const left = await frame.evaluate((wanted) => {
        let n = 0;
        document.querySelectorAll("a[href*='doc_id=']").forEach((a) => {
          const m = a.getAttribute("href").match(/doc_id=(\d+)/);
          if (m && wanted.includes(m[1])) n++;
        });
        return n;
      }, ids);
      console.error(`\ncleanup: selected ${checked}/${ids.length}, ${left} still present after delete`);
      if (left > 0) console.error(`WARNING: drafts left behind: ${ids.join(", ")} - delete them by hand`);
    } else {
      console.error(`\n--keep: left ${createdDocs.length} draft(s) in place: ${createdDocs.map((d) => d.id).join(", ")}`);
    }
    await browser.close();
  }

  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, "runs.json"), JSON.stringify(runs, null, 2));
  const s = score(runs);
  console.log(format(s));
  process.exit(s.gates.M3_silent_wrong === "pass" && s.gates.M6_policy_violations === "pass" ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
