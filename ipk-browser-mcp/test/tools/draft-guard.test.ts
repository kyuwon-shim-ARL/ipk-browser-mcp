/**
 * A draft result may only say "draft" once the document is in the Drafts list.
 * doc 301323 (2026-10-08) was filed for approval while the tool said "draft saved".
 */
import { describe, it, expect, vi } from "vitest";
import { listHasDoc, classifyDocLocation, applyDraftGuard, confirmDraftResult, draftViewUrl } from "../../src/browser/draft-guard.js";
import { textResult } from "../../src/util.js";
import { noFinalSubmitNote } from "../../src/tools/ipk-submit.js";
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
  it("does not match parent_doc_id / ref_doc_id with the same number", () => {
    expect(listHasDoc(`<a href="view.php?parent_doc_id=123">`, "123")).toBe(false);
    expect(listHasDoc(`<a href="view.php?ref_doc_id='123'">`, "123")).toBe(false);
    expect(listHasDoc(`<a href="view.php?x=1&doc_id=123">`, "123")).toBe(true);
    expect(listHasDoc(`<a onclick="go('doc_id=\"123\"')">`, "123")).toBe(true);
    expect(listHasDoc(`<a onclick="go('doc_id='123')">`, "123")).toBe(true);
  });
  it("is false for an empty list or a non-numeric id", () => {
    expect(listHasDoc("<table></table>", "301323")).toBe(false);
    expect(listHasDoc(row("1"), ".*")).toBe(false);
  });
});

describe("draftViewUrl", () => {
  const O = "https://gw.ip-korea.org";
  it("ignores a viewUrl for another doc and omits approve_type when the list has none", () => {
    expect(draftViewUrl(O, "5", "", `${O}/Document/document_view.php?doc_id=55`)).toBe(`${O}/Document/document_view.php?doc_id=5&type=drafts`);
  });
  it("reads approve_type from an &amp;-escaped list href", () => {
    expect(draftViewUrl(O, "5", `<a href="./document_view.php?doc_id=5&amp;approve_type=AppFrm-074&amp;type=drafts">`)).toBe(
      `${O}/Document/document_view.php?doc_id=5&approve_type=AppFrm-074&type=drafts`
    );
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

  it("after confirming, the page is left on the draft's own view, not the home page", async () => {
    const page = pageWith({ drafts: row("301323") });
    await confirmDraftResult(page, BASE, "draft", draftResult());
    expect(page.goto).toHaveBeenLastCalledWith(
      `${BASE}/Document/document_view.php?doc_id=301323&approve_type=AppFrm-021&type=drafts`,
      expect.anything()
    );
  });

  it("prefers the handler's finalUrl for the landing page", async () => {
    const page = pageWith({ drafts: row("301323") });
    const finalUrl = `${BASE}/Document/document_view.php?doc_id=301323&approve_type=AppFrm-073&type=drafts`;
    const r = textResult({ error: false, data: { docId: "301323", mode: "draft", finalUrl, message: "m" } });
    await confirmDraftResult(page, BASE, "draft", r);
    expect(page.goto).toHaveBeenLastCalledWith(finalUrl, expect.anything());
  });

  it("a doc not in Drafts still lands on the origin (failure path unchanged)", async () => {
    const page = pageWith({ progress: row("301323") });
    await confirmDraftResult(page, BASE, "draft", draftResult());
    expect(page.goto).toHaveBeenLastCalledWith(BASE, expect.anything());
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
    // NO_FINAL_SUBMIT: every dispatch path also goes through noFinalSubmitNote.
    expect(dispatch.match(/noFinalSubmitNote\(/g)).toHaveLength(2);
  });

  it("NO_FINAL_SUBMIT: forces draft mode for any form type not in NO_DRAFT_STATE_FORMS, even with draft_only=false", () => {
    const src = readFileSync(join(__dirname, "..", "..", "src", "tools", "ipk-submit.ts"), "utf8");
    expect(src).toMatch(/const NO_DRAFT_STATE_FORMS = new Set\(\["card_expense_rd"\]\);/);
    expect(src).toMatch(
      /const mode: "draft" \| "request" = requestedSubmit && NO_DRAFT_STATE_FORMS\.has\(formType\) \? "request" : "draft";/
    );
  });
});

describe("noFinalSubmitNote", () => {
  it("leaves the result untouched when submission was not requested", () => {
    const r = textResult({ error: false, data: { docId: "123" } });
    expect(noFinalSubmitNote(r, false, "draft")).toBe(r);
  });

  it("leaves the result untouched for a real submission (mode request)", () => {
    const r = textResult({ error: false, data: { docId: "123" } });
    expect(noFinalSubmitNote(r, true, "request")).toBe(r);
  });

  it("adds the click-path note when submission was requested but the MCP only saved a draft", () => {
    const r = textResult({ error: false, data: { docId: "123", message: "Leave draft saved" } });
    const out = JSON.parse(noFinalSubmitNote(r, true, "draft").content[0].text);
    expect(out.data.no_final_submit).toMatch(/never submits a document for approval itself/);
    expect(out.data.no_final_submit).toMatch(/doc_id: 123/);
    expect(out.data.no_final_submit).toMatch(/\[Approval Request\]/);
  });
});
