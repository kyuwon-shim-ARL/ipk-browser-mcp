/**
 * submitWorking (AppFrm-074) - handler-level tests with a mocked page/frame (no real
 * Playwright, no network). B0: this form used to target AppFrm-027 by mistake.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("../../src/security/attachment-path.js", () => ({ validateAttachmentPath: () => null }));

import { handleIpkSubmitForm } from "../../src/tools/ipk-submit.js";

const parse = (r: any) => JSON.parse(r.content[0].text);

function makeHarness() {
  const evaluated: string[] = [];
  const addRowClicks: { calls: number } = { calls: 0 };
  const frame: any = {
    goto: vi.fn(async () => null),
    waitForLoadState: vi.fn(async () => undefined),
    waitForSelector: vi.fn(async () => ({})),
    waitForURL: vi.fn(async () => undefined),
    // Returned as-is throughout: submitForm reads this to extract doc_id once the save
    // click is simulated, and this test never performs a real navigation.
    url: vi.fn(() => "https://gw.ip-korea.org/Document/document_view.php?doc_id=12345"),
    locator: vi.fn((sel: string) => ({
      click: vi.fn(async () => {
        if (sel === ".btnAdd") addRowClicks.calls++;
      }),
    })),
    evaluate: vi.fn(async (fn: any, arg?: any) => {
      const src = String(fn);
      evaluated.push(src.slice(0, 200));
      // fillWorkingRow: returns "ok" for any row index when working_time[] offers the
      // requested HH:00 (the real select offers 01:00-12:00 - accept anything in range).
      if (src.includes("getElementsByName(\"app_dt[]\")")) {
        const hh = Number(arg.hhmm.slice(0, 2));
        if (hh < 1 || hh > 12) return "no_option";
        return "ok";
      }
      // serializeFormFields (iframe-helper.ts, field-rules.ts's checkFieldRulesAgainstForm):
      // a minimal non-empty DOM snapshot, enough to not trip the "unreadable form"
      // fail-closed check; unmapped fields just warn (unknownFields: "warn").
      if (src.includes("knownSet")) return { subject: "Application for Working on 2026-11-07, Tester" };
      // Generic default: satisfies the array-expecting callers (verifyIntendedValues,
      // verifySelectsHeld) this harness does not otherwise script per form.
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
    content: vi.fn(async () => '<a href="document_view.php?doc_id=12345&approve_type=AppFrm-074">draft</a>'),
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
    screenshotDir: path.join(os.tmpdir(), "ipk-working-test-shots"),
    screenshotTtlMinutes: 1,
  };
  return { frame, page, session, config, addRowClicks, evaluated };
}

const params = (over: Record<string, unknown> = {}) => ({
  form_type: "working",
  reason: "Nextflow based urban metagenomic surveillance pipeline optimization",
  rows: [{ date: "2026-11-07", hours: 2 }], // Saturday
  draft_only: true,
  confirm_submit: false,
  ...over,
});

describe("submitWorking (AppFrm-074)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refuses without reason, before touching the frame", async () => {
    const h = makeHarness();
    const out = parse(await handleIpkSubmitForm(h.session, h.config, params({ reason: undefined })));
    expect(out.error).toBe(true);
    expect(out.code).toBe("MISSING_REASON");
    expect(h.frame.evaluate).not.toHaveBeenCalled();
  });

  it("refuses hours out of 1-12 range as a FORM_RULE_VIOLATION, before touching the frame", async () => {
    const h = makeHarness();
    const out = parse(await handleIpkSubmitForm(h.session, h.config, params({ rows: [{ date: "2026-11-07", hours: 13 }] })));
    expect(out.error).toBe(true);
    expect(out.code).toBe("FORM_RULE_VIOLATION");
    expect(out.message).toMatch(/HOURS_OUT_OF_RANGE/);
    expect(h.frame.evaluate).not.toHaveBeenCalled();
  });

  it("refuses a weekly total over 12 hours", async () => {
    const h = makeHarness();
    const out = parse(await handleIpkSubmitForm(h.session, h.config, params({
      rows: [{ date: "2026-11-07", hours: 7 }, { date: "2026-11-08", hours: 6 }],
    })));
    expect(out.error).toBe(true);
    expect(out.message).toMatch(/WEEKLY_CAP_EXCEEDED/);
  });

  it("a weekday date warns but does not block, and the draft still goes through", async () => {
    const h = makeHarness();
    const out = parse(await handleIpkSubmitForm(h.session, h.config, params({ rows: [{ date: "2026-11-09", hours: 2 }] }))); // Monday
    expect(out.error).toBe(false);
    expect(out.data.warning).toMatch(/WEEKDAY_DATE|weekday/i);
  });

  it("clicks the form's own add-row control once per extra row, never builds the row itself", async () => {
    const h = makeHarness();
    const out = parse(await handleIpkSubmitForm(h.session, h.config, params({
      rows: [{ date: "2026-11-07", hours: 2 }, { date: "2026-11-08", hours: 3 }],
    })));
    expect(out.error).toBe(false);
    expect(h.addRowClicks.calls).toBe(1); // 2 rows - 1 (the page starts with one row already)
  });

  it("a valid draft fills the row, runs the field-rules check, and reaches the save step", async () => {
    const h = makeHarness();
    const out = parse(await handleIpkSubmitForm(h.session, h.config, params()));
    expect(out.error).toBe(false);
    expect(out.data.formType).toBe("working");
    expect(out.data.docId).toBe("12345");
    // The row-fill evaluate (getElementsByName) actually ran, and more evaluate calls
    // followed it (field-rules serialization, setFormMode, submitForm's own JS call) -
    // i.e. the save path was reached, not short-circuited by an earlier refusal.
    expect(h.evaluated.some((s) => s.includes('getElementsByName("app_dt[]")'))).toBe(true);
    expect(h.frame.evaluate.mock.calls.length).toBeGreaterThan(1);
  });
});
