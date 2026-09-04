import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("safety invariants", () => {
  it("lint-invariants passes", () => {
    // Runs the same checks CI does, so `npm test` alone is enough to catch a regression.
    const out = execFileSync("node", [join(ROOT, "scripts", "lint-invariants.mjs")], {
      encoding: "utf8",
    });
    expect(out).toContain("PASS");
  });

  it("no code path fabricates substitute identity fields", () => {
    const src = read("src/tools/ipk-submit.ts");
    expect(src).not.toContain("setFallbackSubstitute");
    // payroll/position/contact must never be typed from a default
    expect(src).not.toMatch(/substitute_payroll/);
    expect(src).not.toMatch(/IPK_SUBSTITUTE_POSITION/);
  });

  it("a missing substitute fails instead of writing 'N/A'", () => {
    const src = read("src/tools/ipk-submit.ts");
    expect(src).toContain("SUBSTITUTE_REQUIRED");
    expect(src).toContain("SUBSTITUTE_NOT_FOUND");
    expect(src).toContain("SUBSTITUTE_POPUP_FAILED");
  });

  it("time dropdowns select an existing option rather than rebuilding the list", () => {
    const src = read("src/tools/ipk-submit.ts");
    expect(src).toContain("selectExistingOption");
    expect(src).toContain("INVALID_OPTION");
  });

  it("every attachment upload is validated", () => {
    const src = read("src/tools/ipk-submit.ts");
    // exactly one setInputFiles call, inside attachFile()
    expect(src.match(/\.setInputFiles\(/g)?.length).toBe(1);
    expect(src).toContain("async function attachFile(");
    // the multi-file path validates before delegating
    const multi = src.slice(src.indexOf("attachmentHelper.attachFiles") - 600);
    expect(multi).toContain("validateAttachmentPath");
  });

  it("totals are checked against line items before submit", () => {
    const src = read("src/tools/ipk-submit.ts");
    expect(src).toContain("assertTotalMatchesItems");
    expect(src).toContain("TOTAL_MISMATCH");
  });

  it("shutdown is bounded and login is verified beyond the URL", () => {
    const src = read("src/browser/session.ts");
    expect(src).toContain("SHUTDOWN_TIMEOUT_MS");
    expect(src).toContain("shuttingDown");
    expect(src).toContain("hasAuthMarker");
    expect(src).toContain("getLoginState");
  });
});
