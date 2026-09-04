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
    find: /\.readOnly\s*=\s*false/g,
  },
  {
    name: "no-disabled-bypass",
    why: "Same as readOnly: re-enabling a disabled control submits a value the form withheld.",
    find: /\.disabled\s*=\s*false/g,
  },
  {
    name: "no-option-list-rewrite",
    why: "Wiping a <select>'s options lets an arbitrary value reach an approval document. Use selectExistingOption().",
    find: /(select|El|Element)\w*\.(textContent|innerHTML)\s*=\s*["'`]{2}/gi,
  },
  {
    name: "no-option-fabrication",
    why: "createElement('option') builds a choice the server never offered. Use selectExistingOption().",
    find: /createElement\(\s*["'`]option["'`]\s*\)/g,
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
for (const file of files) {
  const hits = [...file.text.matchAll(/\.setInputFiles\(/g)];
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

// Form-type branching must stay out of ipk-submit.ts (DR-006 Phase 4: schema-driven, not
// per-form if/else). Previously an npm-script grep whose `grep -c ... || echo 0` printed
// "0\n0" on a clean tree, so the gate reported FAIL precisely when it should have passed.
{
  const target = files.find((f) => rel(f.path) === "src/tools/ipk-submit.ts");
  const branchRe = /form_type\s*[=!]==|formType\s*[=!]==|switch\s*\([^)]*form_?[Tt]ype/g;
  const hits = target ? [...target.text.matchAll(branchRe)] : [];
  for (const m of hits) {
    const line = target.text.slice(0, m.index).split("\n").length;
    console.error(`FAIL no-form-type-branches: src/tools/ipk-submit.ts:${line}  ${m[0].trim()}`);
    failures++;
  }
}

if (failures > 0) {
  console.error(`\n${failures} safety invariant violation(s).`);
  process.exit(1);
}
console.log(`PASS: ${RULES.length + 2} safety invariants hold across ${files.length} files.`);
