/**
 * Structural guarantee for the plan v6 P2/P3 offline collectors: ipk_precedent_attachments
 * and ipk_reviewer_opinions are never reachable from a save path (ipk-submit.ts), and their
 * caches are local only.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const submitSrc = fs.readFileSync(path.join(__dirname, "..", "..", "src", "tools", "ipk-submit.ts"), "utf8");

describe("offline collectors are never called from a save path", () => {
  it("ipk-submit.ts never imports or calls the precedent-attachments / reviewer-opinions collectors", () => {
    expect(submitSrc).not.toMatch(/handleIpkPrecedentAttachments/);
    expect(submitSrc).not.toMatch(/handleIpkReviewerOpinions/);
    expect(submitSrc).not.toMatch(/ipk-precedent-attachments/);
    expect(submitSrc).not.toMatch(/ipk-reviewer-opinions/);
  });

  it("both tool files cache under ~/.cache/ipk-mcp/ (HOME-relative), never a repo-relative path", () => {
    for (const f of ["ipk-precedent-attachments.ts", "ipk-reviewer-opinions.ts"]) {
      const src = fs.readFileSync(path.join(__dirname, "..", "..", "src", "tools", f), "utf8");
      expect(src).toMatch(/process\.env\.HOME/);
      expect(src).toMatch(/\.cache.*ipk-mcp/);
    }
  });

  it("neither collector calls any save/draft/submit/attach helper", () => {
    for (const f of ["ipk-precedent-attachments.ts", "ipk-reviewer-opinions.ts"]) {
      const src = fs.readFileSync(path.join(__dirname, "..", "..", "src", "tools", f), "utf8");
      expect(src).not.toMatch(/setInputFiles/);
      expect(src).not.toMatch(/form1\.submit/);
      expect(src).not.toMatch(/attach_file_trans/);
      expect(src).not.toMatch(/Check_Form/);
    }
  });
});
