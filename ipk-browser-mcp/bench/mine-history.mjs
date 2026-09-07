#!/usr/bin/env node
/**
 * Retrospective baseline miner (read-only).
 *
 * Every IPK document carries a "Document Modify History" section. An empty history means
 * the document was accepted exactly as drafted; entries mean a person had to correct it
 * after the fact. Across the documents this account already has, that gives a per-form
 * "human had to touch it" rate to measure future runs against.
 *
 * Reads only. Never opens a form, never writes, never submits.
 *
 *   node bench/mine-history.mjs [--limit N] [--forms leave,expense]
 */
import { chromium } from "playwright";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "data");
const REGISTRY = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "src", "form-registry.json"), "utf8"));

const args = process.argv.slice(2);
const argOf = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const LIMIT = parseInt(argOf("--limit", "0"), 10);
const ONLY = argOf("--forms", "").split(",").filter(Boolean);

function loadEnv() {
  const p = path.join(process.env.HOME, ".config", "ipk-browser-mcp", ".env");
  const out = {};
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const [k, ...rest] = t.split("=");
    out[k.trim()] = rest.join("=").trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function main() {
  const env = loadEnv();
  const base = env.IPK_BASE_URL || "https://gw.ip-korea.org";
  // IPK_USER_NAME holds the login id ("kyuwon.shim") while the document list shows the
  // display name ("Kyuwon Shim"), so compare them on a normalised form.
  const norm = (v) => String(v || "").toLowerCase().replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
  const me = norm(env.IPK_USER_NAME || env.IPK_USERNAME || "");

  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, userAgent: UA })).newPage();

  await page.goto(base, { timeout: 30000 });
  await page.waitForLoadState("networkidle");
  await page.fill("input[name='Username']", env.IPK_USERNAME);
  await page.fill("input[name='Password']", env.IPK_PASSWORD);
  await page.evaluate(() => window.Check_Form());
  await page.waitForTimeout(3000);
  if (!page.url().includes("main.php")) {
    await page.goto(`${base}/main.php`, { timeout: 30000 });
    await page.waitForTimeout(1500);
  }
  const frame = page.frame("main_menu") || page.mainFrame();

  const forms = Object.entries(REGISTRY).filter(([k]) => ONLY.length === 0 || ONLY.includes(k));
  const records = [];

  for (const [formType, entry] of forms) {
    const code = entry.appFrmCode;
    if (!code) continue;
    const docs = [];
    for (let pg = 1; pg <= 12; pg++) {
      const url =
        `${base}/Document/document_list.php?type=approved&doc_form=${code}` +
        `&start_page=${pg}&s_date=2024-01-01&e_date=2026-12-31`;
      await frame.goto(url, { timeout: 30000 });
      await page.waitForTimeout(900);
      const rows = await frame.evaluate(() => {
        const out = [];
        document.querySelectorAll("tr").forEach((r) => {
          const a = r.querySelector("a[href*='document_view']");
          if (!a) return;
          const c = [...r.querySelectorAll("td")].map((t) => t.innerText.trim());
          out.push({ docNo: c[0], subject: c[1], writer: c[3], date: c[c.length - 1], href: a.getAttribute("href") });
        });
        return out;
      });
      const fresh = rows.filter((r) => !docs.some((d) => d.href === r.href));
      if (fresh.length === 0) break;
      docs.push(...fresh);
    }

    const mine = docs.filter((d) => !me || norm(d.writer) === me);
    const targets = LIMIT > 0 ? mine.slice(0, LIMIT) : mine;
    process.stderr.write(`${formType} (${code}): ${mine.length} authored by me, sampling ${targets.length}\n`);

    for (const d of targets) {
      await frame.goto(base + d.href, { timeout: 30000 });
      await page.waitForTimeout(700);
      const hist = await frame.evaluate(() => {
        const body = document.body.innerText;
        const i = body.indexOf("Document Modify History");
        if (i < 0) return null;
        let seg = body.slice(i + "Document Modify History".length);
        const stop = seg.indexOf("[ Document List]");
        if (stop >= 0) seg = seg.slice(0, stop);
        return seg
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l && l !== "[ Down ]")
          .map((l) => l.replace(/\s*\[ Down \]\s*$/, ""));
      });
      records.push({
        formType,
        appFrmCode: code,
        docNo: d.docNo,
        date: d.date,
        modifiedBy: hist || [],
        touched: (hist || []).length > 0,
      });
    }
  }

  await browser.close();

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, "history-baseline.json");
  fs.writeFileSync(outPath, JSON.stringify({ minedAt: new Date().toISOString(), records }, null, 2));

  const byForm = {};
  for (const r of records) {
    byForm[r.formType] ??= { n: 0, touched: 0 };
    byForm[r.formType].n++;
    if (r.touched) byForm[r.formType].touched++;
  }
  console.log("\nform            docs  human-corrected  rate");
  console.log("-".repeat(48));
  let tn = 0, tt = 0;
  for (const [f, s] of Object.entries(byForm).sort((a, b) => b[1].n - a[1].n)) {
    tn += s.n; tt += s.touched;
    console.log(`${f.padEnd(16)}${String(s.n).padStart(4)}${String(s.touched).padStart(17)}  ${((s.touched / s.n) * 100).toFixed(1)}%`);
  }
  console.log("-".repeat(48));
  console.log(`${"TOTAL".padEnd(16)}${String(tn).padStart(4)}${String(tt).padStart(17)}  ${tn ? ((tt / tn) * 100).toFixed(1) : "0.0"}%`);
  console.log(`\nwritten: ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
