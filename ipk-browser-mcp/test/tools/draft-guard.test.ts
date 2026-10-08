/**
 * A draft result may only say "draft" once the document is in the Drafts list.
 * doc 301323 (2026-10-08) was filed for approval while the tool said "draft saved".
 */
import { describe, it, expect, vi } from "vitest";
import { listHasDoc, classifyDocLocation, applyDraftGuard, confirmDraftResult } from "../../src/browser/draft-guard.js";
import { textResult } from "../../src/util.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const row = (id: string) => `<tr><td>No</td><td><a href="./document_view.php?doc_id=${id}&approve_type=AppFrm-021&type=drafts">[Card] x</a></td></tr>`;

describe("listHasDoc", () => {
  it("finds a doc by href and by quoted onclick", () => {
    expect(listHasDoc(`<table>${row("301323")}</table>`, "301323")).toBe(true);
    expect(listHasDoc(`<a onclick="go('document_view.php?doc_id='301323')">`, "301323")).toBe(true);
  });
  it("does not match a longer id that starts with the same digits", () => {
    expect(listHasDoc(row("3013230"), "301323")).toBe(false);
  });
  it("is false for an empty list or a non-numeric id", () => {
    expect(listHasDoc("<table></table>", "301323")).toBe(false);
    expect(listHasDoc(row("1"), ".*")).toBe(false);
  });
});

describe("classifyDocLocation", () => {
  it("drafts wins, then progress, else neither", () => {
    expect(classifyDocLocation(true, false)).toBe("drafts");
    expect(classifyDocLocation(true, true)).toBe("drafts");
    expect(classifyDocLocation(false, true)).toBe("progress");
    expect(classifyDocLocation(false, false)).toBe("neither");
  });
});

describe("applyDraftGuard", () => {
  const payload = { error: false, data: { success: true, docId: "301323", mode: "draft", message: "Leave draft saved (doc_id: 301323)" } };

  it("confirmed in Drafts keeps the result and says so", () => {
    const r = applyDraftGuard(payload, "301323", "drafts");
    expect(r.error).toBe(false);
    expect(r.data.draft_confirmed).toBe(true);
    expect(r.data.message).toMatch(/confirmed in Drafts/);
  });
  it("found In Progress is a loud SUBMITTED_NOT_DRAFT error", () => {
    const r = applyDraftGuard(payload, "301323", "progress");
    expect(r.error).toBe(true);
    expect(r.code).toBe("SUBMITTED_NOT_DRAFT");
    expect(r.message).toMatch(/SUBMITTED for approval/);
    expect(r.message).toMatch(/Document Repossess/);
    expect(r.data.draft_confirmed).toBe(false);
    expect(r.message).not.toMatch(/draft saved/);
  });
  it("found nowhere is DRAFT_NOT_CONFIRMED, with the reason", () => {
    const r = applyDraftGuard(payload, "301323", "neither", "timeout");
    expect(r.error).toBe(true);
    expect(r.code).toBe("DRAFT_NOT_CONFIRMED");
    expect(r.message).toMatch(/timeout/);
  });
});

describe("confirmDraftResult", () => {
  function pageWith(lists: Record<string, string>) {
    let current = "";
    return {
      goto: vi.fn(async (url: string) => { current = url; }),
      waitForTimeout: vi.fn(async () => undefined),
      content: vi.fn(async () => {
        const type = new URL(current).searchParams.get("type") ?? "";
        return lists[type] ?? "<html></html>";
      }),
    };
  }
  const draftResult = () => textResult({ error: false, data: { docId: "301323", mode: "draft", message: "Card expense draft saved (doc_id: 301323)" } });
  const parse = (r: any) => JSON.parse(r.content[0].text);
  const BASE = "https://gw.ip-korea.org";

  it("a doc in Drafts passes, and the lists are read from the origin", async () => {
    const page = pageWith({ drafts: row("301323") });
    const out = parse(await confirmDraftResult(page, BASE, "draft", draftResult()));
    expect(out.error).toBe(false);
    expect(out.data.draft_confirmed).toBe(true);
    expect(page.goto).toHaveBeenCalledWith(`${BASE}/Document/document_list.php?type=drafts`, expect.anything());
    expect(page.goto).not.toHaveBeenCalledWith(`${BASE}/Document/document_list.php?type=progress`, expect.anything());
  });

  it("a doc In Progress becomes SUBMITTED_NOT_DRAFT (the doc 301323 case)", async () => {
    const page = pageWith({ drafts: row("299999"), progress: row("301323") });
    const out = parse(await confirmDraftResult(page, BASE, "draft", draftResult()));
    expect(out.error).toBe(true);
    expect(out.code).toBe("SUBMITTED_NOT_DRAFT");
  });

  it("a doc in neither list becomes DRAFT_NOT_CONFIRMED", async () => {
    const page = pageWith({});
    const out = parse(await confirmDraftResult(page, BASE, "draft", draftResult()));
    expect(out.code).toBe("DRAFT_NOT_CONFIRMED");
  });

  it("a list that cannot be read is DRAFT_NOT_CONFIRMED, never a pass", async () => {
    const page = pageWith({});
    page.goto.mockRejectedValueOnce(new Error("net::ERR_ABORTED"));
    const out = parse(await confirmDraftResult(page, BASE, "draft", draftResult()));
    expect(out.code).toBe("DRAFT_NOT_CONFIRMED");
    expect(out.message).toMatch(/ERR_ABORTED/);
  });

  it("request mode, errors, and results without a docId pass through untouched", async () => {
    const page = pageWith({});
    const req = draftResult();
    expect(await confirmDraftResult(page, BASE, "request", req)).toBe(req);
    const err = textResult({ error: true, code: "X", message: "m" });
    expect(await confirmDraftResult(page, BASE, "draft", err)).toBe(err);
    const preview = textResult({ error: false, data: { mode: "preview", saved: false, docId: null } });
    expect(await confirmDraftResult(page, BASE, "draft", preview)).toBe(preview);
    expect(page.goto).not.toHaveBeenCalled();
  });
});

describe("ipk_submit_form dispatch", () => {
  it("runs the guard on both the per-form handlers and the generic handler", () => {
    const src = readFileSync(join(__dirname, "..", "..", "src", "tools", "ipk-submit.ts"), "utf8");
    const dispatch = src.slice(src.indexOf("export async function handleIpkSubmitForm("), src.indexOf("async function submitLeave("));
    expect(dispatch.match(/confirmDraftResult\(page, config\.baseUrl, mode, result/g)).toHaveLength(2);
    expect(dispatch).not.toMatch(/return await handler\(/);
    expect(dispatch).not.toMatch(/return await submitGeneric\(/);
  });
});
