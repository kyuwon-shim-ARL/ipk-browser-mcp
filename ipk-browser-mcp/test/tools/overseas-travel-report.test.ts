/**
 * Overseas travel report (AppFrm-076) save path - live-read 2026-10-27 of the real 076
 * write page: selecting #pdoc_id there reloads document_write.php (its own change
 * handler), and Check_Form_Request (not form1.submit()) is what checks .validate fields
 * are non-empty before saving. See submitOverseasTravelReport's comments for the fix
 * this guards: customUrl now opens the page with pdoc_id already in the query string,
 * the handler only verifies (never selects) it, and the save goes through
 * Check_Form_Request so an empty body is caught rather than silently saved.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("../../src/security/attachment-path.js", () => ({ validateAttachmentPath: () => null }));

const { setFormModeSpy, submitFormSpy } = vi.hoisted(() => ({
  setFormModeSpy: vi.fn(async () => undefined),
  submitFormSpy: vi.fn(async () => "400200"),
}));

vi.mock("../../src/browser/iframe-helper.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/browser/iframe-helper.js")>("../../src/browser/iframe-helper.js");
  return {
    ...actual,
    setFormMode: setFormModeSpy,
    submitForm: submitFormSpy,
  };
});

import { handleIpkSubmitForm } from "../../src/tools/ipk-submit.js";

const parse = (r: any) => JSON.parse(r.content[0].text);

const REQUEST_DOC_ID = "400100";

function makeHarness(pdocValueOnPage: string | null = REQUEST_DOC_ID, prefill: Record<string, string> = {}) {
  const fieldWrites: { sel: string; val: string }[] = [];
  const frame: any = {
    goto: vi.fn(async () => null),
    waitForLoadState: vi.fn(async () => undefined),
    waitForSelector: vi.fn(async () => ({})),
    waitForURL: vi.fn(async () => undefined),
    url: vi.fn(() => "https://gw.ip-korea.org/Document/document_write.php"),
    locator: vi.fn(() => ({ click: vi.fn(async () => undefined) })),
    evaluate: vi.fn(async (fn: any, arg?: any) => {
      const name = typeof fn === "function" ? fn.name : "";
      const src = String(fn);
      // submitOverseasTravelReport's read-only pdoc_id-linked check (never dispatches
      // change - that is the bug being fixed; a dispatchEvent here would be the regression).
      if (src.includes('select[name="pdoc_id"]')) {
        expect(src).not.toContain("dispatchEvent");
        return pdocValueOnPage;
      }
      // M3: the page's own prefilled values, read before genericFillForm.
      if (name === "readOverseasTravelReportPrefill") return prefill;
      // setFieldValue (iframe-helper.ts) - field writes, tracked by selector
      if (arg && typeof arg === "object" && "sel" in arg && "val" in arg) {
        fieldWrites.push({ sel: arg.sel, val: arg.val });
        return "ok";
      }
      // field-rules.ts serializeFormFields
      if (src.includes("knownSet")) return { subject: "stub" };
      return [];
    }),
  };
  const page: any = {
    frame: vi.fn(() => frame),
    mainFrame: vi.fn(() => frame),
    frames: vi.fn(() => [frame]),
    goto: vi.fn(async () => null),
    waitForTimeout: vi.fn(async () => undefined),
    waitForLoadState: vi.fn(async () => undefined),
    waitForNavigation: vi.fn(async () => undefined),
    url: vi.fn(() => "https://gw.ip-korea.org/"),
    content: vi.fn(async () => '<a href="document_view.php?doc_id=400200">draft</a>'),
    screenshot: vi.fn(async () => undefined),
    on: vi.fn(),
    off: vi.fn(),
  };
  const session: any = {
    isLoggedIn: () => true,
    getLoginState: () => "logged_in",
    getPage: () => page,
    getSessionRemainingMs: () => 60 * 60 * 1000,
    touchActivity: () => undefined,
    getUserInfo: () => ({ username: "tester", name: "Tester", dept: "ARL" }),
  };
  const config: any = {
    baseUrl: "https://gw.ip-korea.org",
    navTimeoutMs: 1000,
    screenshotDir: path.join(os.tmpdir(), "ipk-overseas-travel-test-shots"),
    screenshotTtlMinutes: 1,
  };
  return { frame, page, session, config, fieldWrites };
}

const baseParams = {
  form_type: "travel",
  request_doc_id: REQUEST_DOC_ID,
  report_kind: "overseas",
  title: "Conference trip",
  destination: "Boston",
  start_date: "2026-09-14",
  end_date: "2026-09-16",
  purpose: "x".repeat(100),
  schedule: "y".repeat(100),
  reason: "z".repeat(100),
  draft_only: true,
  confirm_submit: false,
};

beforeEach(() => {
  setFormModeSpy.mockClear();
  submitFormSpy.mockClear();
});

describe("overseas travel report (AppFrm-076)", () => {
  it("customUrl opens the page with pdoc_id already in the query string", async () => {
    const h = makeHarness();
    await handleIpkSubmitForm(h.session, h.config, baseParams);

    expect(h.frame.goto).toHaveBeenCalled();
    const url = h.frame.goto.mock.calls[0][0] as string;
    expect(url).toContain("approve_type=AppFrm-076");
    expect(url).toContain(`pdoc_id=${REQUEST_DOC_ID}`);
  });

  it("refuses PDOC_NOT_LINKED when the page's pdoc_id differs, and never saves", async () => {
    const h = makeHarness("some-other-doc-id");
    const out = parse(await handleIpkSubmitForm(h.session, h.config, baseParams));

    expect(out.error).toBe(true);
    expect(out.message).toContain("PDOC_NOT_LINKED");
    expect(setFormModeSpy).not.toHaveBeenCalled();
    expect(submitFormSpy).not.toHaveBeenCalled();
  });

  it("refuses PDOC_NOT_LINKED when the pdoc_id select is missing entirely", async () => {
    const h = makeHarness(null);
    const out = parse(await handleIpkSubmitForm(h.session, h.config, baseParams));

    expect(out.error).toBe(true);
    expect(out.message).toContain("PDOC_NOT_LINKED");
    expect(submitFormSpy).not.toHaveBeenCalled();
  });

  it("never dispatches change on pdoc_id (checked inside the evaluate mock above)", async () => {
    const h = makeHarness();
    const out = parse(await handleIpkSubmitForm(h.session, h.config, baseParams));
    expect(out.error).toBe(false);
  });

  it("saves via setFormMode + Check_Form_Request (submitForm), not form1.submit, mode set before save", async () => {
    const h = makeHarness();
    const out = parse(await handleIpkSubmitForm(h.session, h.config, baseParams));

    expect(out.error).toBe(false);
    expect(setFormModeSpy).toHaveBeenCalledTimes(1);
    expect(setFormModeSpy).toHaveBeenCalledWith(h.frame, "draft");
    expect(submitFormSpy).toHaveBeenCalledTimes(1);
    expect(submitFormSpy).toHaveBeenCalledWith(h.page, h.frame);
    // mode1 must already be set before the save call (ordering, not just call count)
    const modeOrder = setFormModeSpy.mock.invocationCallOrder[0];
    const submitOrder = submitFormSpy.mock.invocationCallOrder[0];
    expect(modeOrder).toBeLessThan(submitOrder);
  });
});

describe("overseas travel report (AppFrm-076) only overwrites fields the caller passed (M3)", () => {
  it("keeps a prefilled start_day when start_date was not passed, writing the fallback default when it was", async () => {
    const h = makeHarness(REQUEST_DOC_ID, { start_date: "2026-08-01" });
    const { start_date, ...withoutStartDate } = baseParams;
    const out = parse(await handleIpkSubmitForm(h.session, h.config, withoutStartDate));

    expect(out.error).toBe(false);
    const write = h.fieldWrites.find((w) => w.sel === '[name="start_day"]');
    expect(write?.val).toBe("2026-08-01");
  });

  it("overwrites a prefilled start_day with the caller's own start_date", async () => {
    const h = makeHarness(REQUEST_DOC_ID, { start_date: "2026-08-01" });
    const out = parse(await handleIpkSubmitForm(h.session, h.config, baseParams));

    expect(out.error).toBe(false);
    const write = h.fieldWrites.find((w) => w.sel === '[name="start_day"]');
    expect(write?.val).toBe(baseParams.start_date);
  });

  it("writes the computed default when the page has no prefilled value and the caller passed none", async () => {
    const h = makeHarness(REQUEST_DOC_ID, {});
    const { start_date, ...withoutStartDate } = baseParams;
    const out = parse(await handleIpkSubmitForm(h.session, h.config, withoutStartDate));

    expect(out.error).toBe(false);
    const write = h.fieldWrites.find((w) => w.sel === '[name="start_day"]');
    expect(write?.val).toBeTruthy(); // todayStr() fallback - not empty, not the prefill (there was none)
  });

  it("L4: an explicit empty string is treated as not passed - keeps a prefilled start_day instead of overwriting with the computed default", async () => {
    const h = makeHarness(REQUEST_DOC_ID, { start_date: "2026-08-01" });
    const out = parse(await handleIpkSubmitForm(h.session, h.config, { ...baseParams, start_date: "" }));

    expect(out.error).toBe(false);
    const write = h.fieldWrites.find((w) => w.sel === '[name="start_day"]');
    expect(write?.val).toBe("2026-08-01");
  });

  it("L4: an explicit empty string with no prefill still gets the computed default (not an empty write)", async () => {
    const h = makeHarness(REQUEST_DOC_ID, {});
    const out = parse(await handleIpkSubmitForm(h.session, h.config, { ...baseParams, start_date: "" }));

    expect(out.error).toBe(false);
    const write = h.fieldWrites.find((w) => w.sel === '[name="start_day"]');
    expect(write?.val).toBeTruthy();
  });
});
