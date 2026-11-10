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
  // Tracks every field setFieldValue actually wrote (by DOM name, stripped from its
  // `[name="x"]` selector) so the post-save read-back mock below can report what was
  // REALLY set, instead of an unconditional stub that would always fail M3's
  // saved_confirmed check (code review 2026-11-09).
  const written: Record<string, string> = {};
  // H1's REPORT_PAGE_UNAVAILABLE check reads frame.url() and expects it to reflect
  // whatever customUrl actually navigated to (varies by requestDocId per test) - tracked
  // live from frame.goto, rather than a fixed string that only matched doc_id=299953.
  let lastFrameUrl = "https://gw.ip-korea.org/Document/travel_report_write.php?doc_id=299953&approve_type=AppFrm-023&pop=Y";

  const frame: any = {
    goto: vi.fn(async (url: string) => { lastFrameUrl = url; return null; }),
    waitForLoadState: vi.fn(async () => undefined),
    waitForSelector: vi.fn(async () => ({})),
    waitForURL: vi.fn(async () => undefined),
    url: vi.fn(() => lastFrameUrl),
    content: vi.fn(async () => ""), // resolveTravelRequestFormCode's document_view.php fallback read
    locator: vi.fn(() => ({ click: vi.fn(async () => undefined) })),
    evaluate: vi.fn(async (fn: any, arg?: any) => {
      const src = String(fn);
      evaluated.push(src.slice(0, 200));
      if (src.includes("Check_Form(")) {
        checkFormDCalled = true;
        return undefined;
      }
      // REPORT_PAGE_UNAVAILABLE's fast presence check (submitTravelReportOnRequest): every
      // required field is present and Check_Form exists, by default - individual tests
      // override this via a custom frame.evaluate when they need to simulate the opposite.
      if (src.includes("names.filter")) {
        return { missing: [], hasCheckForm: true };
      }
      // readReportContentFields (travel-report.ts): the overwrite guard's pre-fill read,
      // and the auto-lookup's per-candidate emptiness check. Distinguished from the
      // post-save read-back below by its distinct loop/output shape.
      if (src.includes("out[names[i]]")) {
        const out: Record<string, string> = {};
        for (const n of (arg as string[]) ?? []) out[n] = existingReportFields[n] ?? "";
        return out;
      }
      // setFieldValue's own evaluate (iframe-helper.ts): records what was actually written.
      if (arg && typeof arg === "object" && "sel" in arg && "val" in arg) {
        const m = /\[name="([^"]+)"\]/.exec((arg as { sel: string }).sel);
        if (m) written[m[1]] = (arg as { val: string }).val;
        return "ok";
      }
      // Post-save read-back (submitTravelReportOnRequest's own evaluate, after Check_Form):
      // reports what was really written above. A field genericFillForm SKIPPED (its value
      // was "" - never touched) falls back to "", matching an untouched DOM field, not an
      // arbitrary "stub" that would never equal an intentionally empty fields[k].
      if (src.includes("for (const n of names)")) {
        const out: Record<string, string> = {};
        for (const n of arg as string[]) out[n] = written[n] ?? "";
        return out;
      }
      if (src.includes("knownSet")) return { subject: "stub" }; // field-rules serializeFormFields, unused for travel
      // Generic default: satisfies the array-expecting callers (verifyIntendedValues,
      // verifySelectsHeld) setFieldValue's own evaluate returns a plain string outcome,
      // which this never interferes with since it's not awaited for length.
      return [];
    }),
  };
  // H3 (code review 2026-11-09): an explicit request_doc_id's real approve_type is now
  // resolved via the network (resolveTravelRequestFormCode, ipk-submit.ts), not guessed
  // from report_kind - this default matches GOOD_PARAMS' request_doc_id (299953) to
  // AppFrm-023 (domestic). Auto-lookup tests below override frame.$$eval themselves.
  frame.$$eval = vi.fn(async () => ["document_view.php?doc_id=299953&approve_type=AppFrm-023"]);

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

  it("resolves the explicit request_doc_id's real form code (H3), then navigates to travel_report_write.php", async () => {
    const h = makeHarness([]);
    const out = parse(await handleIpkSubmitForm(h.session, h.config, GOOD_PARAMS()));
    expect(out.error).toBe(false);
    expect(out.data.attached_to_doc_id).toBe("299953");
    expect(out.data).not.toHaveProperty("docId"); // no new document - must not trip confirmDraftResult
    expect(h.getCheckFormDCalled()).toBe(true);
    // An explicit request_doc_id is resolved against the unfiltered approved list (H3's
    // resolveTravelRequestFormCode) - it is never keyword-searched (the auto-lookup
    // path's own request_keyword/title/destination narrowing never runs for it).
    expect(h.gotoUrls.some((u) => u.includes("document_list.php") && !/keyword=(&|$)/.test(u))).toBe(false);
  });

  it("refuses REQUEST_FORM_CODE_UNRESOLVED when the explicit request_doc_id cannot be found on the approved list or its own view page", async () => {
    const h = makeHarness([]);
    h.frame.$$eval = vi.fn(async () => []); // not on the list, and (M-4) not found on its own view page either
    const out = parse(await handleIpkSubmitForm(h.session, h.config, GOOD_PARAMS()));
    expect(out.error).toBe(true);
    expect(out.code).toBe("REQUEST_FORM_CODE_UNRESOLVED");
    expect(h.getCheckFormDCalled()).toBe(false);
  });

  it("refuses REQUEST_FORM_CODE_UNRESOLVED when the resolved form code is neither AppFrm-023 nor AppFrm-022", async () => {
    const h = makeHarness([]);
    h.frame.$$eval = vi.fn(async () => ["document_view.php?doc_id=299953&approve_type=AppFrm-073"]); // a leave request, not a travel request
    const out = parse(await handleIpkSubmitForm(h.session, h.config, GOOD_PARAMS()));
    expect(out.error).toBe(true);
    expect(out.code).toBe("REQUEST_FORM_CODE_UNRESOLVED");
    expect(out.message).toMatch(/AppFrm-073/);
  });

  it("H-1: resolves an Appfrm-022 href (lowercase f) via explicit request_doc_id, normalized to AppFrm-022", async () => {
    const h = makeHarness([]);
    h.frame.$$eval = vi.fn(async () => ["document_view.php?doc_id=299953&approve_type=Appfrm-022"]);
    const out = parse(await handleIpkSubmitForm(h.session, h.config, GOOD_PARAMS({ report_kind: "overseas", end_date: "2026-09-14" })));
    expect(out.error).toBe(false);
    expect(out.data.report_kind).toBe("overseas");
  });

  it("M-4: the view-page fallback reads the code from the anchor whose href contains THIS doc_id, not the first approve_type on the page (which belongs to another doc)", async () => {
    const h = makeHarness([]);
    let call = 0;
    h.frame.$$eval = vi.fn(async () => {
      call++;
      if (call === 1) return []; // not on the approved list - triggers the view-page fallback
      // view page: first anchor is a DIFFERENT document (e.g. a related settlement),
      // the correct self-referencing anchor for doc 299953 comes second.
      return [
        "document_view.php?doc_id=555555&approve_type=AppFrm-026",
        "document_view.php?doc_id=299953&approve_type=AppFrm-022",
      ];
    });
    const out = parse(await handleIpkSubmitForm(h.session, h.config, GOOD_PARAMS({ report_kind: "overseas", end_date: "2026-09-14" })));
    expect(out.error).toBe(false);
    expect(out.data.report_kind).toBe("overseas"); // not AppFrm-026/"domestic" from the other doc's anchor
  });

  it("refuses REPORT_KIND_MISMATCH when report_kind: 'overseas' is claimed for a request that resolves to AppFrm-023 (domestic)", async () => {
    const h = makeHarness([]);
    const out = parse(await handleIpkSubmitForm(h.session, h.config, GOOD_PARAMS({ report_kind: "overseas" })));
    expect(out.error).toBe(true);
    expect(out.code).toBe("REPORT_KIND_MISMATCH");
    expect(h.getCheckFormDCalled()).toBe(false);
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

  it("H-1: auto-lookup recognizes an Appfrm-022 href (lowercase f) and auto-detects 'overseas'", async () => {
    const h = makeHarness([]);
    h.frame.$$eval = vi.fn(async () => ["document_view.php?doc_id=777&approve_type=Appfrm-022"]);
    const out = parse(await handleIpkSubmitForm(h.session, h.config, GOOD_PARAMS({ request_doc_id: undefined, end_date: "2026-09-14" })));
    expect(out.error).toBe(false);
    expect(out.data.attached_to_doc_id).toBe("777");
    expect(out.data.report_kind).toBe("overseas");
  });
});
