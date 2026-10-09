/**
 * submitTravel's domestic-report branch (travel_report_write.php) - handler-level tests
 * with a mocked page/frame (no real Playwright, no network).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("../../src/security/attachment-path.js", () => ({ validateAttachmentPath: () => null }));

import { handleIpkSubmitForm } from "../../src/tools/ipk-submit.js";

// Isolate report_leader/report_post from this machine's real profile.json and shell env
// (loadProfile() and process.env are not otherwise mockable through this harness).
let tmpHome: string;
const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ipk-travel-report-test-"));
  process.env.IPK_HOME_DIR = tmpHome;
  for (const k of ["IPK_GROUP_LEADER", "IPK_USER_POSITION"]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  delete process.env.IPK_HOME_DIR;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const parse = (r: any) => JSON.parse(r.content[0].text);

function makeHarness(approvedListHrefs: string[], existingReportFields: Record<string, string> = {}) {
  const evaluated: string[] = [];
  const dialogsSeen: string[] = [];
  let checkFormDCalled = false;
  const gotoUrls: string[] = [];

  const frame: any = {
    goto: vi.fn(async () => null),
    waitForLoadState: vi.fn(async () => undefined),
    waitForSelector: vi.fn(async () => ({})),
    waitForURL: vi.fn(async () => undefined),
    url: vi.fn(() => "https://gw.ip-korea.org/Document/travel_report_write.php?doc_id=299953&approve_type=AppFrm-023&pop=Y"),
    locator: vi.fn(() => ({ click: vi.fn(async () => undefined) })),
    evaluate: vi.fn(async (fn: any, arg?: any) => {
      const src = String(fn);
      evaluated.push(src.slice(0, 200));
      if (src.includes("Check_Form(")) {
        checkFormDCalled = true;
        return undefined;
      }
      // readReportContentFields (travel-report.ts): the overwrite guard's pre-fill read,
      // and the auto-lookup's per-candidate emptiness check. Distinguished from the
      // post-save read-back below by its distinct loop/output shape.
      if (src.includes("out[names[i]]")) {
        const out: Record<string, string> = {};
        for (const n of (arg as string[]) ?? []) out[n] = existingReportFields[n] ?? "";
        return out;
      }
      // Post-save read-back (submitDomesticTravelReport's own evaluate, after Check_Form):
      // report every requested field as holding what was set, simulating a saved page.
      if (src.includes("for (const n of names)")) {
        const out: Record<string, string> = {};
        for (const n of arg as string[]) out[n] = "stub";
        return out;
      }
      if (src.includes("knownSet")) return { subject: "stub" }; // field-rules serializeFormFields, unused for travel
      // Generic default: satisfies the array-expecting callers (verifyIntendedValues,
      // verifySelectsHeld) setFieldValue's own evaluate returns a plain string outcome,
      // which this never interferes with since it's not awaited for length.
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
    on: vi.fn((_ev: string, _fn: any) => undefined),
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
    screenshotDir: path.join(os.tmpdir(), "ipk-travel-report-test-shots"),
    screenshotTtlMinutes: 1,
  };
  return { frame, page, session, config, evaluated, gotoUrls, getCheckFormDCalled: () => checkFormDCalled };
}

const GOOD_PARAMS = (over: Record<string, unknown> = {}) => ({
  form_type: "travel",
  request_doc_id: "299953",
  purpose: "x".repeat(100),
  schedule: "y".repeat(100),
  reason: "z".repeat(100),
  start_date: "2026-09-14",
  end_date: "2026-09-16", // 2 nights
  draft_only: true,
  confirm_submit: false,
  ...over,
});

describe("submitTravel - domestic report (explicit request_doc_id)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refuses a 0-night trip before touching the frame (NO_REPORT_FOR_DAY_TRIP, org-policy)", async () => {
    const h = makeHarness([]);
    const out = parse(await handleIpkSubmitForm(h.session, h.config, GOOD_PARAMS({ end_date: "2026-09-14" })));
    expect(out.error).toBe(true);
    expect(out.message).toMatch(/NO_REPORT_FOR_DAY_TRIP/);
    expect(h.frame.evaluate).not.toHaveBeenCalled();
  });

  it("refuses short purpose/agenda/result before touching the frame", async () => {
    const h = makeHarness([]);
    const out = parse(await handleIpkSubmitForm(h.session, h.config, GOOD_PARAMS({ purpose: "short" })));
    expect(out.error).toBe(true);
    expect(out.message).toMatch(/TRAVEL_REPORT_FIELDS_MIN_LENGTH/);
    expect(h.frame.evaluate).not.toHaveBeenCalled();
  });

  it("navigates straight to travel_report_write.php with the explicit request_doc_id, no lookup", async () => {
    const h = makeHarness([]);
    const out = parse(await handleIpkSubmitForm(h.session, h.config, GOOD_PARAMS()));
    expect(out.error).toBe(false);
    expect(out.data.attached_to_doc_id).toBe("299953");
    expect(out.data).not.toHaveProperty("docId"); // no new document - must not trip confirmDraftResult
    expect(h.getCheckFormDCalled()).toBe(true);
    // No lookup network call means page.goto was never pointed at document_list.php?type=approved.
    expect(h.gotoUrls.some((u) => u.includes("document_list.php"))).toBe(false);
  });
});

describe("submitTravel - domestic report (overwrite guard)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refuses with REPORT_ALREADY_EXISTS when the request already has a report, naming which fields", () => {
    return (async () => {
      const h = makeHarness([], { purpose_field: "x".repeat(120), result_field: "y".repeat(80) });
      const out = parse(await handleIpkSubmitForm(h.session, h.config, GOOD_PARAMS()));
      expect(out.error).toBe(true);
      expect(out.code).toBe("REPORT_ALREADY_EXISTS");
      expect(out.message).toMatch(/purpose_field \(120 chars\)/);
      expect(out.message).toMatch(/result_field \(80 chars\)/);
      expect(h.getCheckFormDCalled()).toBe(false); // never got to the save step
    })();
  });

  it("proceeds when overwrite_report: true is passed, and reports the old lengths", async () => {
    const h = makeHarness([], { purpose_field: "x".repeat(120) });
    const out = parse(await handleIpkSubmitForm(h.session, h.config, GOOD_PARAMS({ overwrite_report: true })));
    expect(out.error).toBe(false);
    expect(out.data.overwritten_old_lengths).toEqual(
      expect.objectContaining({ purpose_field: 120 })
    );
    expect(h.getCheckFormDCalled()).toBe(true);
  });

  it("does not report overwritten_old_lengths when the request had no prior report", async () => {
    const h = makeHarness([]); // existingReportFields defaults to {}
    const out = parse(await handleIpkSubmitForm(h.session, h.config, GOOD_PARAMS()));
    expect(out.error).toBe(false);
    expect(out.data.overwritten_old_lengths).toBeUndefined();
  });
});

describe("submitTravel - domestic report (person_field / warnings)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("warns when persons_met is omitted, and never fills person_field with the writer's own name", async () => {
    const h = makeHarness([]);
    const out = parse(await handleIpkSubmitForm(h.session, h.config, GOOD_PARAMS()));
    expect(out.error).toBe(false);
    expect(out.data.warning).toMatch(/person_field/);
    expect(out.data.warning).not.toMatch(/Tester/); // never silently filled with the writer's name
  });

  it("no warning for person_field when persons_met is given", async () => {
    const h = makeHarness([]);
    const out = parse(await handleIpkSubmitForm(h.session, h.config, GOOD_PARAMS({ persons_met: "Conference organizer" })));
    expect(out.error).toBe(false);
    expect(out.data.warning ?? "").not.toMatch(/person_field/);
  });

  it("warns for report_leader/report_post when neither profile nor env supplies them", async () => {
    const h = makeHarness([]);
    const out = parse(await handleIpkSubmitForm(h.session, h.config, GOOD_PARAMS()));
    expect(out.data.warning).toMatch(/report_leader/);
    expect(out.data.warning).toMatch(/report_post/);
  });
});

describe("submitTravel - domestic report (auto-lookup)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refuses when the approved-request lookup finds 0 matches, rather than guessing", async () => {
    const h = makeHarness([]);
    h.page.mainFrame = vi.fn(() => h.frame);
    h.frame.$$eval = vi.fn(async () => []);
    const out = parse(await handleIpkSubmitForm(h.session, h.config, GOOD_PARAMS({ request_doc_id: undefined })));
    expect(out.error).toBe(true);
    expect(out.code).toBe("TRAVEL_REQUEST_NOT_FOUND");
  });

  it("refuses when the lookup finds more than one match, rather than picking one", async () => {
    const h = makeHarness([]);
    h.frame.$$eval = vi.fn(async () => [
      "document_view.php?doc_id=1&approve_type=AppFrm-023",
      "document_view.php?doc_id=2&approve_type=AppFrm-023",
    ]);
    const out = parse(await handleIpkSubmitForm(h.session, h.config, GOOD_PARAMS({ request_doc_id: undefined })));
    expect(out.error).toBe(true);
    expect(out.code).toBe("TRAVEL_REQUEST_NOT_FOUND");
    expect(out.message).toMatch(/2 approved travel requests/);
  });

  it("auto-resolves and proceeds when the lookup finds exactly one match", async () => {
    const h = makeHarness([]);
    h.frame.$$eval = vi.fn(async () => ["document_view.php?doc_id=777&approve_type=AppFrm-023"]);
    const out = parse(await handleIpkSubmitForm(h.session, h.config, GOOD_PARAMS({ request_doc_id: undefined })));
    expect(out.error).toBe(false);
    expect(out.data.attached_to_doc_id).toBe("777");
  });
});
