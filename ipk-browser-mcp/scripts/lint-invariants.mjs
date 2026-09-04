#!/usr/bin/env node
/**
 * Safety invariants that must hold in src/.
 * These encode decisions that cost real incidents; a grep is cheap insurance against
 * quietly reintroducing them. Wired into `npm test` (see safety-invariants.test.ts).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
  });
}

const files = walk(SRC).map((path) => ({ path, text: readFileSync(path, "utf8") }));
const rel = (p) => p.slice(p.indexOf("/src/") + 1);

const RULES = [
  {
    name: "no-readonly-bypass",
    why: "readOnly marks a field the form computes or validates. Clearing it writes values the form never agreed to.",
    // covers el.readOnly=false, el["readOnly"]=false, removeAttribute('readonly'),
    // toggleAttribute('readonly', false) and Object.assign(el, { readOnly: false }).
    find: /\.readOnly\s*=\s*false|\[\s*["'`]readOnly["'`]\s*\]\s*=\s*false|removeAttribute\(\s*["'`]readonly["'`]|toggleAttribute\(\s*["'`]readonly["'`]\s*,\s*false|readOnly\s*:\s*false/gi,
  },
  {
    name: "no-disabled-bypass",
    why: "A disabled control is omitted from the submitted payload; re-enabling one submits a value the form withheld.",
    find: /\.disabled\s*=\s*false|\[\s*["'`]disabled["'`]\s*\]\s*=\s*false|removeAttribute\(\s*["'`]disabled["'`]|toggleAttribute\(\s*["'`]disabled["'`]\s*,\s*false|disabled\s*:\s*false/gi,
  },
  {
    name: "no-option-list-rewrite",
    why: "Emptying a <select> lets an arbitrary value reach an approval document. Use selectExistingOption().",
    // textContent/innerHTML = "" on any identifier, replaceChildren(), options.length = 0
    find: /\w+\.(textContent|innerHTML)\s*=\s*(["'`]{2}|null)|\.replaceChildren\(\s*\)|\.options\.length\s*=\s*0/g,
  },
  {
    name: "no-option-fabrication",
    why: "Building a choice the server never offered. Use selectExistingOption().",
    // createElement('option') in any case, new Option(...), select.add(...)
    find: /createElement\(\s*["'`]option["'`]\s*\)|new\s+Option\s*\(|\.add\(\s*new\s+Option/gi,
  },
];


let failures = 0;

for (const rule of RULES) {
  for (const file of files) {
    for (const m of file.text.matchAll(rule.find)) {
      const line = file.text.slice(0, m.index).split("\n").length;
      console.error(`FAIL ${rule.name}: ${rel(file.path)}:${line}  ${m[0].trim()}`);
      console.error(`     ${rule.why}`);
      failures++;
    }
  }
}

// setInputFiles must be funnelled through the two audited helpers, so that
// validateAttachmentPath cannot be bypassed by a new upload site.
const UPLOAD_ALLOWLIST = new Set(["src/tools/ipk-submit.ts", "src/internal/primitives/attachment.ts"]);
const UPLOAD_CALL = /setInputFiles\s*\(|\[\s*["'`]setInputFiles["'`]\s*\]\s*\(/g;
for (const file of files) {
  const hits = [...file.text.matchAll(UPLOAD_CALL)];
  if (hits.length === 0) continue;
  const r = rel(file.path);
  if (!UPLOAD_ALLOWLIST.has(r)) {
    console.error(`FAIL single-upload-path: ${r} calls setInputFiles outside the audited helpers.`);
    failures++;
  } else if (hits.length > 1) {
    console.error(`FAIL single-upload-path: ${r} has ${hits.length} setInputFiles calls; expected exactly 1.`);
    failures++;
  }
}

// The one call inside ipk-submit.ts must live in attachFile(), the function that validates.
{
  const submit = files.find((f) => rel(f.path) === "src/tools/ipk-submit.ts");
  if (submit) {
    const fnStart = submit.text.indexOf("async function attachFile(");
    const callAt = submit.text.search(UPLOAD_CALL);
    const fnEnd = fnStart >= 0 ? submit.text.indexOf("\n}", fnStart) : -1;
    if (fnStart < 0 || callAt < fnStart || callAt > fnEnd) {
      console.error("FAIL upload-inside-attachFile: setInputFiles is not inside attachFile() in src/tools/ipk-submit.ts.");
      failures++;
    } else if (!submit.text.slice(fnStart, callAt).includes("validateAttachmentPath(")) {
      console.error("FAIL upload-inside-attachFile: attachFile() uploads without calling validateAttachmentPath() first.");
      failures++;
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} safety invariant violation(s).`);
  process.exit(1);
}
console.log(`PASS: ${RULES.length + 4} safety invariants hold across ${files.length} files.`);
