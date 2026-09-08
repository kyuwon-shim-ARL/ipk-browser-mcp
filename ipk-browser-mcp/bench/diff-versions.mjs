#!/usr/bin/env node
/**
 * What a person actually changed, per document.
 *
 * The groupware keeps a PDF of every saved version (pdfdown.php?seq=..&nm=<timestamp>,
 * linked from Document Modify History). Diffing the first version against the last gives
 * the real M2 - the fields a human had to correct - rather than the proxy the runner uses.
 *
 * Read-only. Downloads version PDFs to a temp dir and deletes them.
 *
 *   node bench/diff-versions.mjs [--form travel_request] [--limit 10]
 */
import { chromium } from "playwright";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = path.join(__dirname, "data", "history-baseline.json");
const args = process.argv.slice(2);
const argOf = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ONLY_FORM = argOf("--form", "");
const LIMIT = parseInt(argOf("--limit", "0"), 10);

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

// The rendered PDF is an approval form: signature blocks, column headers and page furniture
// shift between versions without anything meaningful changing. Drop them so what remains is
// the document's own content.
const FURNITURE =
  /^(\[?\s*S(ign|gin)\s*\]?|Approval|Cosigner|Takeover|A Person in Charge|Team Head|CEO|Budget Holder|Document No|Saving years|\(\s*\d\s*\)|Cate\s*N|Amoun|excl\.\s*V|Total Amou|Control|Payee\/Vendor|[A-Za-z]|\d{4}-\d{2}-\d{2})$/i;

function textOf(pdfPath) {
  const raw = execFileSync("pdftotext", ["-raw", pdfPath, "-"], { encoding: "utf8" });
  return raw
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 2 && !FURNITURE.test(l));
}

/** Lines present in one version and not the other, in both directions. */
function changedLines(a, b) {
  const setA = new Set(a), setB = new Set(b);
  return {
    removed: a.filter((l) => !setB.has(l)),
    added: b.filter((l) => !setA.has(l)),
  };
}

/** Bucket a change by what it looks like, so the report says where to aim. */
function classify(line) {
  if (/\[(EZ:)?[A-Z]{2,}\d{4}-\d{4}\]|\bNN\d|\bFS\d|\bNFS\d/.test(line)) return "budget code";
  if (/\d{1,3}(,\d{3})+|\bKRW\b/.test(line)) return "amount";
  if (/\d{4}-\d{2}-\d{2}|\d{2}:\d{2}/.test(line)) return "date or time";
  if (/\[\d{6}\]/.test(line)) return "account code";
  return "text";
}

async function main() {
  const env = loadEnv();
  const base = env.IPK_BASE_URL || "https://gw.ip-korea.org";
  if (!fs.existsSync(BASELINE)) {
    console.error("Run bench/mine-history.mjs first.");
    process.exit(1);
  }
  const records = JSON.parse(fs.readFileSync(BASELINE, "utf8")).records
    .filter((r) => r.edits > 1 && (!ONLY_FORM || r.formType === ONLY_FORM));
  const targets = LIMIT > 0 ? records.slice(0, LIMIT) : records;
  console.error(`${targets.length} document(s) with more than one saved version\n`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ipk-versions-"));
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, userAgent: UA });
  const page = await ctx.newPage();
  await page.goto(base, { timeout: 30000 });
  await page.waitForLoadState("networkidle");
  await page.fill("input[name='Username']", env.IPK_USERNAME);
  await page.fill("input[name='Password']", env.IPK_PASSWORD);
  await page.evaluate(() => window.Check_Form());
  await page.waitForTimeout(3000);
  if (!page.url().includes("main.php")) await page.goto(`${base}/main.php`);
  const frame = page.frame("main_menu") || page.mainFrame();

  const tally = {};
  const results = [];

  for (const rec of targets) {
    const listUrl =
      `${base}/Document/document_list.php?type=approved&doc_form=${rec.appFrmCode}` +
      `&s_date=2024-01-01&e_date=2026-12-31`;
    await frame.goto(listUrl, { timeout: 30000 });
    await page.waitForTimeout(800);
    const href = await frame.evaluate((no) => {
      for (const r of document.querySelectorAll("tr")) {
        if ((r.innerText || "").includes(no)) {
          const a = r.querySelector("a[href*='document_view']");
          if (a) return a.getAttribute("href");
        }
      }
      return null;
    }, rec.docNo);
    if (!href) { console.error(`${rec.docNo}: not found in list`); continue; }

    await frame.goto(base + href, { timeout: 30000 });
    await page.waitForTimeout(700);
    const downs = await frame.evaluate(() =>
      [...document.querySelectorAll("a")]
        .filter((a) => /Down/i.test(a.textContent || ""))
        .map((a) => a.getAttribute("href"))
        .filter(Boolean)
    );
    if (downs.length < 2) { console.error(`${rec.docNo}: ${downs.length} version(s), nothing to diff`); continue; }

    // The list is newest first, so the last entry is the original draft.
    const pick = [downs[downs.length - 1], downs[0]];
    const texts = [];
    for (const [i, rel] of pick.entries()) {
      const url = `${base}/Document/${rel.replace(/^\.\//, "")}`;
      const res = await page.request.get(url);
      const file = path.join(tmp, `${rec.docNo}-${i}.pdf`);
      fs.writeFileSync(file, await res.body());
      texts.push(textOf(file));
      fs.unlinkSync(file);
    }
    const { removed, added } = changedLines(texts[0], texts[1]);
    const kinds = {};
    for (const l of [...removed, ...added]) {
      const k = classify(l);
      kinds[k] = (kinds[k] || 0) + 1;
      tally[k] = (tally[k] || 0) + 1;
    }
    results.push({ docNo: rec.docNo, formType: rec.formType, versions: downs.length, removed, added, kinds });
    console.error(
      `${rec.docNo.padEnd(15)} ${rec.formType.padEnd(18)} ${downs.length} versions  ` +
        Object.entries(kinds).map(([k, v]) => `${k}:${v}`).join("  ")
    );
  }

  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.writeFileSync(path.join(__dirname, "data", "version-diffs.json"), JSON.stringify(results, null, 2));

  console.log("\nwhat people changed, across %d document(s)", results.length);
  console.log("-".repeat(40));
  for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    console.log(`${k.padEnd(16)}${String(v).padStart(6)} changed line(s)`);
  }
  console.log("\nfull diffs: bench/data/version-diffs.json");
}

main().catch((e) => { console.error(e); process.exit(1); });
