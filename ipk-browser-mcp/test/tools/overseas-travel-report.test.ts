/**
 * submitTravel's overseas-report branch (report_kind: "overseas") - since 2026-11-09 this
 * writes onto the approved AppFrm-022 request at the SAME travel_report_write.php
 * endpoint as the domestic report, but WITHOUT &approve_type (exactly the URL the
 * AppFrm-026 settlement's own JS opens). Also covers H3's real-form-code resolution/
 * mismatch refusals and route/URL resolution across domestic/overseas/standalone.
 * Handler-level tests with a mocked page/frame (no real Playwright, no network). See
 * travel-report-submit.test.ts for the domestic branch and standalone-travel-report.test.ts
 * for report_kind: "standalone" (AppFrm-076).
 *
 * OPEN QUESTION (code review 2026-11-09): if a report is written onto the AppFrm-022
 * request before any AppFrm-026 settlement exists for the trip, it is unknown whether
 * that report later shows up when the settlement is eventually filed - colleagues'
 * reports were only ever observed via the settlement's own id
 * (travel_report_view.php?doc_id=<026>&pop=Y, dev/baseline_gate.py's
 * _fetch_overseas_report_texts), never via the request's id directly. Not something
 * this test suite can answer without a live write, which is out of scope here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("../../src/security/attachment-path.js", () => ({ validateAttachmentPath: () => null }));

import { handleIpkSubmitForm } from "../../src/tools/ipk-submit.js";

let tmpHome: string;
beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ipk-overseas-report-test-"));
  process.env.IPK_HOME_DIR = tmpHome;
});
afterEach(() => {
  delete process.env.IPK_HOME_DIR;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const parse = (r: any) => JSON.parse(r.content[0].text);

const REQUEST_DOC_ID = "400100";

/**
 * hasReportFields=false simulates a page with none of the expected report fields
 * (e.g. a permission-deny alert with no form behind it): the H1 availability check
 * (names.filter/hasCheckForm) reports everything missing and no Check_Form.
 */
function makeHarness(hasReportFields: boolean, existingReportFields: Record<string, string> = {}) {
  const gotoUrls: string[] = [];
  let checkFormDCalled = false;
  const written: Record<string, string> = {};
  let lastFrameUrl = `https://gw.ip-korea.org/Document/travel_report_write.php?doc_id=${REQUEST_DOC_ID}&pop=Y`;

  const frame: any = {
    goto: vi.fn(async (url: string) => { lastFrameUrl = url; return null; }),
    waitForLoadState: vi.fn(async () => undefined),
    waitForSelector: vi.fn(async () => ({})),
    waitForURL: vi.fn(async () => undefined),
    url: vi.fn(() => lastFrameUrl),
    content: vi.fn(async () => ""),
    locator: vi.fn(() => ({ click: vi.fn(async () => undefined) })),
    // H3's resolveTravelRequestFormCode default: request 400100 resolves to AppFrm-022
    // (overseas) - individual tests override this when they need a different form code.
    $$eval: vi.fn(async () => [`document_view.php?doc_id=${REQUEST_DOC_ID}&approve_type=AppFrm-022`]),
    evaluate: vi.fn(async (fn: any, arg?: any) => {
      const src = String(fn);
      // H1's fast presence check (submitTravelReportOnRequest).
      if (src.includes("names.filter")) {
        return hasReportFields ? { missing: [], hasCheckForm: true } : { missing: ["report_date", "purpose_field"], hasCheckForm: false };
      }
      if (src.includes("Check_Form(")) {
        checkFormDCalled = true;
        return undefined;
      }
      // readReportContentFields (travel-report.ts): pre-fill read / emptiness check.
      if (src.includes("out[names[i]]")) {
        const out: Record<string, string> = {};
        for (const n of (arg as string[]) ?? []) out[n] = existingReportFields[n] ?? "";
        return out;
      }
      // setFieldValue's own evaluate (iframe-helper.ts): records what was really written.
      if (arg && typeof arg === "object" && "sel" in arg && "val" in arg) {
        const m = /\[name="([^"]+)"\]/.exec((arg as { sel: string }).sel);
        if (m) written[m[1]] = (arg as { val: string }).val;
        return "ok";
      }
      // Post-save read-back: what was really written, "" for anything genericFillForm
      // skipped (an intentionally empty value, never touched) - not an arbitrary stub.
      if (src.includes("for (const n of names)")) {
        const out: Record<string, string> = {};
        for (const n of arg as string[]) out[n] = written[n] ?? "";
        return out;
      }
      if (src.includes("knownSet")) return { subject: "stub" };
      return [];
    }),
  };
  const page: any = {
    frame: vi.fn(() => frame),
    mainFrame: vi.fn(() => frame),
    frames: vi.fn(() => [frame]),
    goto: vi.fn(async (url: string) => { gotoUrls.push(url); return null; }),
    waitForTimeout: vi.fn(async () => undefined),
    waitForLoadState: vi.fn(async () => undefined),
    waitForNavigation: vi.fn(async () => undefined),
    url: vi.fn(() => "https://gw.ip-korea.org/"),
    content: vi.fn(async () => ""),
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
    screenshotDir: path.join(os.tmpdir(), "ipk-overseas-report-test-shots"),
    screenshotTtlMinutes: 1,
  };
  return { frame, page, session, config, gotoUrls, getCheckFormDCalled: () => checkFormDCalled };
}

const GOOD_PARAMS = (over: Record<string, unknown> = {}) => ({
  form_type: "travel",
  report_kind: "overseas",
  request_doc_id: REQUEST_DOC_ID,
  purpose: "x".repeat(100),
  schedule: "y".repeat(100),
  reason: "z".repeat(100),
  start_date: "2026-09-14",
  end_date: "2026-09-15", // 1 night - would be refused for a domestic report
  draft_only: true,
  confirm_submit: false,
  ...over,
});

describe("submitTravel - overseas report (AppFrm-022 request, travel_report_write.php without approve_type)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("navigates to travel_report_write.php with doc_id and pop=Y, but no approve_type", async () => {
    const h = makeHarness(true);
    const out = parse(await handleIpkSubmitForm(h.session, h.config, GOOD_PARAMS()));
    expect(out.error).toBe(false);
    const navigated = [...h.gotoUrls, ...h.frame.goto.mock.calls.map((c: any[]) => c[0])];
    expect(navigated.some((u) => u.includes("travel_report_write.php") && u.includes(`doc_id=${REQUEST_DOC_ID}`) && u.includes("pop=Y"))).toBe(true);
    expect(navigated.some((u) => u.includes("approve_type"))).toBe(false);
    expect(out.data.report_kind).toBe("overseas");
    expect(out.data.attached_to_doc_id).toBe(REQUEST_DOC_ID);
    expect(out.data.saved_confirmed).toBe(true);
    expect(h.getCheckFormDCalled()).toBe(true);
    // L6: the H2 permission-dialog listener is always removed after the customUrl
    // navigation, success or not - it must never leak into a later navigation.
    expect(h.page.on).toHaveBeenCalledWith("dialog", expect.any(Function));
    expect(h.page.off).toHaveBeenCalledWith("dialog", expect.any(Function));
  });

  it("does NOT refuse a 0-night trip the way the domestic report would (M1: day-trip rule is domestic-only)", async () => {
    const h = makeHarness(true);
    const out = parse(await handleIpkSubmitForm(h.session, h.config, GOOD_PARAMS({ end_date: "2026-09-14" }))); // same-day
    expect(out.error).toBe(false);
  });

  it("refuses REPORT_PAGE_UNAVAILABLE when the page has none of the expected report fields (permission-deny), naming what's missing, and never saves", async () => {
    const h = makeHarness(false);
    const out = parse(await handleIpkSubmitForm(h.session, h.config, GOOD_PARAMS()));
    expect(out.error).toBe(true);
    expect(out.code).toBe("REPORT_PAGE_UNAVAILABLE");
    expect(out.message).toMatch(/report_date/);
    expect(out.message).toMatch(/Check_Form is not a function/);
    expect(h.getCheckFormDCalled()).toBe(false);
  });

  // L6 (code review 2026-11-09): H1's three checks (missing fields / Check_Form / URL)
  // tested in isolation, not only in the combined permission-deny case above.
  describe("H1 availability check: each of its three conditions refuses on its own", () => {
    it("refuses REPORT_PAGE_UNAVAILABLE on a missing field alone (Check_Form present, URL correct)", async () => {
      const h = makeHarness(true);
      h.frame.evaluate = vi.fn(async (fn: any, arg?: any) => {
        const src = String(fn);
        if (src.includes("names.filter")) return { missing: ["purpose_field"], hasCheckForm: true };
        if (src.includes("Check_Form(")) return undefined;
        if (src.includes("out[names[i]]")) return {};
        if (src.includes("for (const n of names)")) return {};
        return [];
      });
      const out = parse(await handleIpkSubmitForm(h.session, h.config, GOOD_PARAMS()));
      expect(out.error).toBe(true);
      expect(out.code).toBe("REPORT_PAGE_UNAVAILABLE");
      expect(out.message).toMatch(/purpose_field/);
      expect(out.message).not.toMatch(/Check_Form is not a function/);
    });

    it("refuses REPORT_PAGE_UNAVAILABLE on Check_Form missing alone (no missing fields, URL correct)", async () => {
      const h = makeHarness(true);
      h.frame.evaluate = vi.fn(async (fn: any, arg?: any) => {
        const src = String(fn);
        if (src.includes("names.filter")) return { missing: [], hasCheckForm: false };
        if (src.includes("out[names[i]]")) return {};
        if (src.includes("for (const n of names)")) return {};
        return [];
      });
      const out = parse(await handleIpkSubmitForm(h.session, h.config, GOOD_PARAMS()));
      expect(out.error).toBe(true);
      expect(out.code).toBe("REPORT_PAGE_UNAVAILABLE");
      expect(out.message).toMatch(/Check_Form is not a function/);
      expect(out.message).not.toMatch(/missing field/);
    });

    it("refuses REPORT_PAGE_UNAVAILABLE on a URL mismatch alone (no missing fields, Check_Form present)", async () => {
      const h = makeHarness(true);
      // The frame landed somewhere else entirely - e.g. a redirect back to the frameset.
      h.frame.url = vi.fn(() => "https://gw.ip-korea.org/main.php");
      const out = parse(await handleIpkSubmitForm(h.session, h.config, GOOD_PARAMS()));
      expect(out.error).toBe(true);
      expect(out.code).toBe("REPORT_PAGE_UNAVAILABLE");
      expect(out.message).toMatch(/is not travel_report_write\.php\?doc_id=400100/);
      expect(out.message).not.toMatch(/missing field|Check_Form is not a function/);
    });
  });

  it("refuses REPORT_KIND_MISMATCH when report_kind: 'overseas' is claimed for a request that resolves to AppFrm-023 (domestic)", async () => {
    const h = makeHarness(true);
    h.frame.$$eval = vi.fn(async () => [`document_view.php?doc_id=${REQUEST_DOC_ID}&approve_type=AppFrm-023`]);
    const out = parse(await handleIpkSubmitForm(h.session, h.config, GOOD_PARAMS()));
    expect(out.error).toBe(true);
    expect(out.code).toBe("REPORT_KIND_MISMATCH");
    expect(h.getCheckFormDCalled()).toBe(false);
  });

  it("auto-detects 'overseas' (no report_kind given) when the looked-up request resolves to AppFrm-022", async () => {
    const h = makeHarness(true);
    h.frame.$$eval = vi.fn(async () => [`document_view.php?doc_id=${REQUEST_DOC_ID}&approve_type=AppFrm-022`]);
    const { report_kind, ...withoutKind } = GOOD_PARAMS();
    const out = parse(await handleIpkSubmitForm(h.session, h.config, withoutKind));
    expect(out.error).toBe(false);
    expect(out.data.report_kind).toBe("overseas");
    // Proof it really is the overseas route, not merely the label: no &approve_type.
    const navigated = [...h.gotoUrls, ...h.frame.goto.mock.calls.map((c: any[]) => c[0])];
    expect(navigated.some((u) => u.includes("travel_report_write.php") && !u.includes("approve_type"))).toBe(true);
  });

  it("DRAFT_NOT_CONFIRMED (M3) when the post-save re-read does not show the written values", async () => {
    const h = makeHarness(true);
    // Simulate a save whose read-back never reflects what was written: every post-save
    // field read returns empty regardless of what setFieldValue wrote.
    const baseEvaluate = h.frame.evaluate.getMockImplementation()!;
    h.frame.evaluate = vi.fn(async (fn: any, arg?: any) => {
      const src = String(fn);
      if (src.includes("for (const n of names)")) {
        const out: Record<string, string> = {};
        for (const n of arg as string[]) out[n] = "never-matches";
        return out;
      }
      return baseEvaluate(fn, arg);
    });
    const out = parse(await handleIpkSubmitForm(h.session, h.config, GOOD_PARAMS()));
    expect(out.error).toBe(true);
    expect(out.code).toBe("DRAFT_NOT_CONFIRMED");
  });
});

describe("INVALID_REQUEST_DOC_ID (re-review 2026-11-09): request_doc_id must be plain digits", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refuses a non-numeric request_doc_id before any navigation or lookup", async () => {
    const h = makeHarness(true);
    const out = parse(await handleIpkSubmitForm(h.session, h.config, GOOD_PARAMS({ request_doc_id: "400100; DROP" })));
    expect(out.error).toBe(true);
    expect(out.code).toBe("INVALID_REQUEST_DOC_ID");
    expect(h.gotoUrls).toHaveLength(0);
    expect(h.getCheckFormDCalled()).toBe(false);
  });
});

describe("route/URL resolution: domestic vs overseas vs standalone", () => {
  beforeEach(() => vi.clearAllMocks());

  it("domestic (explicit) resolves against AppFrm-023 and still includes &approve_type=AppFrm-023", async () => {
    const h = makeHarness(true);
    h.frame.$$eval = vi.fn(async () => [`document_view.php?doc_id=${REQUEST_DOC_ID}&approve_type=AppFrm-023`]);
    const out = parse(await handleIpkSubmitForm(h.session, h.config, GOOD_PARAMS({ report_kind: "domestic", end_date: "2026-09-16" })));
    expect(out.error).toBe(false);
    const navigated = [...h.gotoUrls, ...h.frame.goto.mock.calls.map((c: any[]) => c[0])];
    expect(navigated.some((u) => u.includes("approve_type=AppFrm-023"))).toBe(true);
  });

  it("standalone routes to document_write.php?approve_type=AppFrm-076, not travel_report_write.php, regardless of the resolved request's real form code", async () => {
    const h = makeHarness(true);
    const out = parse(await handleIpkSubmitForm(h.session, h.config, GOOD_PARAMS({ report_kind: "standalone", title: "Conf", destination: "Boston" })));
    const navigated = [...h.gotoUrls, ...h.frame.goto.mock.calls.map((c: any[]) => c[0])];
    expect(navigated.some((u) => u.includes("document_write.php") && u.includes("approve_type=AppFrm-076"))).toBe(true);
    expect(navigated.some((u) => u.includes("travel_report_write.php"))).toBe(false);
    // L5 (code review 2026-11-09): this harness is generic (not standalone-travel-report.test.ts's
    // dedicated pdoc_id/prefill mock), so submitStandaloneTravelReport's own pdoc_id-linked
    // check deterministically reads a non-matching value here (the generic evaluate mock's
    // `[]` fallback, not REQUEST_DOC_ID) and refuses PDOC_NOT_LINKED before any save - proof
    // that URL resolution alone (asserted above) is never mistaken for a successful save on
    // the wrong page.
    expect(out.error).toBe(true);
    expect(out.message).toContain("PDOC_NOT_LINKED");
    expect(h.getCheckFormDCalled()).toBe(false);
  });

  it("refuses REQUEST_FORM_CODE_UNRESOLVED when the request resolves to neither AppFrm-023 nor AppFrm-022", async () => {
    const h = makeHarness(true);
    h.frame.$$eval = vi.fn(async () => [`document_view.php?doc_id=${REQUEST_DOC_ID}&approve_type=AppFrm-073`]); // a leave request
    const out = parse(await handleIpkSubmitForm(h.session, h.config, GOOD_PARAMS()));
    expect(out.error).toBe(true);
    expect(out.code).toBe("REQUEST_FORM_CODE_UNRESOLVED");
  });
});

describe("PERMISSION_DENIED (H2): a permission dialog on the customUrl navigation itself", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refuses PERMISSION_DENIED when the groupware shows a permission dialog while navigating, before any field is read", async () => {
    const h = makeHarness(true);
    h.page.on = vi.fn((event: string, handler: (d: any) => void) => {
      if (event === "dialog") {
        // Fire synchronously-ish right after registration, simulating a dialog that
        // appears as the page loads (the frame.goto below still "succeeds" in this mock).
        handler({ message: () => "Permission denied: you may not view this document.", accept: () => Promise.resolve() });
      }
    });
    const out = parse(await handleIpkSubmitForm(h.session, h.config, GOOD_PARAMS()));
    expect(out.error).toBe(true);
    expect(out.code).toBe("PERMISSION_DENIED");
    expect(h.getCheckFormDCalled()).toBe(false);
    // L6: cleaned up even on this refusal path, not only on success.
    expect(h.page.off).toHaveBeenCalledWith("dialog", expect.any(Function));
  });

  // Re-review (2026-11-09):
  // (a) a permission dialog's own goto catch path - the dialog can interrupt the
  //     navigation's own promise and make it reject, not merely "succeed anyway" like the
  //     test above. That rejection must still surface as PERMISSION_DENIED, never as an
  //     uncaught throw/SUBMIT_ERROR, as long as a permission-dialog message was captured.
  it("refuses PERMISSION_DENIED (not a thrown error) when the dialog fires AND the frame's own goto rejects", async () => {
    const h = makeHarness(true);
    h.page.on = vi.fn((event: string, handler: (d: any) => void) => {
      if (event === "dialog") {
        handler({ message: () => "Permission denied: you may not view this document.", accept: () => Promise.resolve() });
      }
    });
    h.frame.goto = vi.fn(async () => {
      throw new Error("Navigation interrupted by dialog");
    });
    const out = parse(await handleIpkSubmitForm(h.session, h.config, GOOD_PARAMS()));
    expect(out.error).toBe(true);
    expect(out.code).toBe("PERMISSION_DENIED");
    expect(out.code).not.toBe("SUBMIT_ERROR");
    expect(h.getCheckFormDCalled()).toBe(false);
    expect(h.page.off).toHaveBeenCalledWith("dialog", expect.any(Function));
  });

  // (b) a non-permission dialog must still be dismissed (preserving the old no-listener
  //     auto-dismiss behavior) but must NOT be treated as a refusal - the submit proceeds.
  it("dismisses a non-permission dialog without refusing, and the submit still succeeds", async () => {
    const h = makeHarness(true);
    const dismiss = vi.fn(async () => undefined);
    h.page.on = vi.fn((event: string, handler: (d: any) => void) => {
      if (event === "dialog") {
        // A real Playwright Dialog always exposes both methods; this mock does too (like
        // submitForm's own later dialog listener in iframe-helper.ts, which calls accept()
        // unconditionally during the save flow) - only `dismiss` is asserted on below.
        handler({ message: () => "Are you sure you want to leave this page?", dismiss, accept: vi.fn(async () => undefined) });
      }
    });
    const out = parse(await handleIpkSubmitForm(h.session, h.config, GOOD_PARAMS()));
    expect(dismiss).toHaveBeenCalled();
    expect(out.error).toBe(false);
    expect(out.code).not.toBe("PERMISSION_DENIED");
  });

  // (c) the permission-dialog listener is opt-in per form (FormNavConfig.listenForPermissionDialog),
  //     never a blanket formType check - travel_settlement's own customUrl path must not
  //     register a 'dialog' listener at all, same invariant travel-settlement.test.ts locks
  //     for its own form, re-asserted here alongside the "travel" form's positive case.
  it("travel_settlement's customUrl navigation registers no 'dialog' listener", async () => {
    const h = makeHarness(true);
    const dialogHandlers: any[] = [];
    h.page.on = vi.fn((event: string, handler: any) => {
      if (event === "dialog") dialogHandlers.push(handler);
    });
    await handleIpkSubmitForm(h.session, h.config, {
      form_type: "travel_settlement",
      request_doc_id: REQUEST_DOC_ID,
      budget_code: "NN2602-0002",
      draft_only: true,
      confirm_submit: false,
    });
    expect(dialogHandlers).toHaveLength(0);
  });
});
