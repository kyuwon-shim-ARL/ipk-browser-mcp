#!/usr/bin/env node
/**
 * Per-field M2: what the tool wrote, against what the document ended up holding.
 *
 * The audit log records every value written and the document id the submit produced, so a
 * run can be joined to its document. Reading that document later and checking which of
 * those values are still in it turns "someone edited this document" into "budget_code was
 * changed in 2 of 3 documents" - which is the shape a fix can act on.
 *
 * Complements bench/diff-versions.mjs: that one works retrospectively from version PDFs and
 * reports line counts; this one is field-attributed, and only covers documents this tool
 * drafted.
 *
 * Read-only against the groupware.
 *
 *   node bench/reconcile.mjs [--since 2026-09-01] [--json]
 */
import { chromium } from "playwright";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIT = path.join(process.env.HOME, ".cache", "ipk-mcp", "audit.jsonl");
const args = process.argv.slice(2);
const argOf = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const SINCE = argOf("--since", "");
const AS_JSON = args.includes("--json");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

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

/** Field name out of a selector like 'input[name="purpose"], textarea[name="purpose"]'. */
function fieldName(selector) {
  const m = String(selector || "").match(/name="([^"]+)"/);
  return m ? m[1] : String(selector || "").slice(0, 40);
}

/** Group the audit log into one snapshot per document the tool actually created. */
function snapshots() {
  if (!fs.existsSync(AUDIT)) return [];
  const byRun = new Map();
  for (const line of fs.readFileSync(AUDIT, "utf8").split("\n").filter(Boolean)) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (SINCE && e.ts < SINCE) continue;
    if (!byRun.has(e.runId)) byRun.set(e.runId, []);
    byRun.get(e.runId).push(e);
  }
  const out = [];
  for (const [runId, events] of byRun) {
    const submitted = events.find((e) => e.action === "submit" && e.docId);
    if (!submitted) continue; // no document: nothing to reconcile against
    const fields = {};
    for (const e of events) {
      if ((e.action !== "field_write" && e.action !== "option_select") || e.ok === false) continue;
      const v = String(e.value ?? "").trim();
      if (!v) continue; // a blank we wrote tells us nothing about what a person changed
      fields[fieldName(e.field)] = v;
    }
    out.push({
      runId,
      docId: String(submitted.docId),
      at: events[0]?.ts,
      formType: events.find((e) => e.action === "navigate")?.field || "unknown",
      fields,
    });
  }
  return out;
}

async function main() {
  const snaps = snapshots();
  if (snaps.length === 0) {
    console.error(
      "No documents to reconcile.\n" +
        "This needs runs where the tool actually produced a document - the audit log has none" +
        (SINCE ? ` since ${SINCE}` : "") +
        ".\nIt fills up as the tool is used for real work; bench drafts are deleted, so they " +
        "only count if run with --keep."
    );
    process.exit(0);
  }

  const env = loadEnv();
  const base = env.IPK_BASE_URL || "https://gw.ip-korea.org";
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 }, userAgent: UA })).newPage();
  await page.goto(base, { timeout: 30000 });
  await page.waitForLoadState("networkidle");
  await page.fill("input[name='Username']", env.IPK_USERNAME);
  await page.fill("input[name='Password']", env.IPK_PASSWORD);
  await page.evaluate(() => window.Check_Form());
  await page.waitForTimeout(3000);

  const perField = {};
  const results = [];

  // document_view.php renders nothing from a doc_id alone - it needs the rest of the query
  // string the list page builds. So resolve each id to the href the groupware itself uses.
  const hrefCache = new Map();
  async function hrefFor(docId) {
    if (hrefCache.has(docId)) return hrefCache.get(docId);
    for (const type of ["approved", "progress", "drafts"]) {
      for (let pg = 1; pg <= 12; pg++) {
        await page.goto(
          `${base}/Document/document_list.php?type=${type}&start_page=${pg}&s_date=2024-01-01&e_date=2026-12-31`,
          { waitUntil: "domcontentloaded", timeout: 30000 }
        );
        await page.waitForTimeout(500);
        const found = await page.evaluate((wanted) => {
          const seen = [];
          for (const a of document.querySelectorAll("a[href*='doc_id=']")) {
            const m = a.getAttribute("href").match(/doc_id=(\d+)/);
            if (!m) continue;
            seen.push(m[1]);
            if (m[1] === wanted) return { href: a.getAttribute("href"), any: true };
          }
          return { href: null, any: seen.length > 0 };
        }, String(docId));
        if (found.href) { hrefCache.set(docId, found.href); return found.href; }
        if (!found.any) break; // empty page: no more results for this list type
      }
    }
    hrefCache.set(docId, null);
    return null;
  }

  for (const snap of snaps) {
    const href = await hrefFor(snap.docId);
    let text = "";
    if (href) {
      await page.goto(base + href, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(600);
      text = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ").toLowerCase();
    }
    // No href means the document is not in any list we can see: deleted, or not ours.
    const gone = !href || text.length < 500;

    const survived = [];
    const changed = [];
    for (const [name, value] of Object.entries(snap.fields)) {
      const needle = value.replace(/\s+/g, " ").toLowerCase();
      (text.includes(needle) ? survived : changed).push({ name, value });
      perField[name] ??= { written: 0, changed: 0 };
      perField[name].written++;
      if (!text.includes(needle)) perField[name].changed++;
    }
    results.push({ docId: snap.docId, formType: snap.formType, at: snap.at, gone, survived, changed });
    console.error(
      `doc ${snap.docId.padEnd(8)} ${String(snap.formType).padEnd(18)} ` +
        (gone ? "(deleted)" : `${survived.length} kept, ${changed.length} changed`)
    );
  }

  await browser.close();
  fs.writeFileSync(path.join(__dirname, "data", "reconcile.json"), JSON.stringify(results, null, 2));

  if (AS_JSON) { console.log(JSON.stringify({ perField, results }, null, 2)); return; }

  const live = results.filter((r) => !r.gone);
  const totalWritten = live.reduce((a, r) => a + r.survived.length + r.changed.length, 0);
  const totalChanged = live.reduce((a, r) => a + r.changed.length, 0);
  console.log(`\n${live.length} document(s) still present, ${totalWritten} field value(s) written`);
  console.log(`M2 (true): ${totalChanged} changed by a person` +
    (totalWritten ? ` — ${((totalChanged / totalWritten) * 100).toFixed(1)}% of what the tool wrote` : ""));
  const rows = Object.entries(perField).filter(([, v]) => v.changed > 0).sort((a, b) => b[1].changed - a[1].changed);
  if (rows.length) {
    console.log("\nfield                 written  changed");
    console.log("-".repeat(40));
    for (const [name, v] of rows) {
      console.log(`${name.padEnd(22)}${String(v.written).padStart(7)}${String(v.changed).padStart(9)}`);
    }
  } else {
    console.log("\nNo field the tool wrote was changed afterwards.");
  }
  console.log("\nA changed value is not automatically the tool's fault - a travel date can move");
  console.log("for reasons that have nothing to do with what was drafted. Use it to see where");
  console.log("corrections cluster, then judge each cluster.");
}

main().catch((e) => { console.error(e); process.exit(1); });
