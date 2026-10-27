/**
 * dry_run=true, structural guarantee: for every wired form type, the shared save
 * helpers (setFormMode/submitForm/submitTravelReportDraft) are spied and asserted
 * never-called, and the response carries dry_run:true with serialized fields instead of
 * a saved document. card_expense_rd is tested separately (it has no draft state at
 * all - its own preview is the dry_run path; the thing to prove there is that the real
 * submit branch, the popup/network-write machinery, is never reached).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("../../src/security/attachment-path.js", () => ({ validateAttachmentPath: () => null }));

const { setFormModeSpy, submitFormSpy, submitTravelReportDraftSpy } = vi.hoisted(() => ({
  setFormModeSpy: vi.fn(async () => undefined),
  submitFormSpy: vi.fn(async () => "99999"),
  submitTravelReportDraftSpy: vi.fn(async () => ({ dialogs: [] })),
}));

vi.mock("../../src/browser/iframe-helper.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/browser/iframe-helper.js")>("../../src/browser/iframe-helper.js");
  return {
    ...actual,
    setFormMode: setFormModeSpy,
    submitForm: submitFormSpy,
    submitTravelReportDraft: submitTravelReportDraftSpy,
  };
});

import { handleIpkSubmitForm } from "../../src/tools/ipk-submit.js";

const parse = (r: any) => JSON.parse(r.content[0].text);

function makeHarness() {
  const frame: any = {
    goto: vi.fn(async () => null),
    waitForLoadState: vi.fn(async () => undefined),
    waitForSelector: vi.fn(async () => ({})),
    waitForURL: vi.fn(async () => undefined),
    url: vi.fn(() => "https://gw.ip-korea.org/Document/document_write.php"),
    locator: vi.fn(() => ({ click: vi.fn(async () => undefined) })),
    evaluate: vi.fn(async (fn: any, arg?: any) => {
      const src = String(fn);
      // working: fillWorkingRow
      if (src.includes('getElementsByName("app_dt[]")')) {
        const hh = Number((arg?.hhmm ?? "02:00").slice(0, 2));
        return hh >= 1 && hh <= 12 ? "ok" : "no_option";
      }
      // travel_settlement: read-only p_doc_id link verification - simulate the parent
      // request's prefill having taken, matching whatever doc_id the test case passed.
      if (src.includes("p_doc_id")) return { pDocId: "299953", prefilled: true };
      // field-rules.ts serializeFormFields
      if (src.includes("knownSet")) return { subject: "stub" };
      // expense/card_expense: assertTotalMatchesItems - no comparable line items in this
      // minimal mock DOM, so "nothing to assert" (null) is the correct simulated result.
      if (src.includes('getElementsByName("total_amt")')) return null;
      // selectExistingOption (ipk-submit.ts, used by other forms' option selects):
      // "ok" on the first poll, so its retry loop doesn't spin for its full
      // real-wall-clock timeout (Date.now()-based, not mocked).
      if (src.includes("no_option") && src.includes("reverted")) {
        return { status: "ok", options: [], label: "x", hidden: false };
      }
      // submitOverseasTravelReport's read-only pdoc_id-linked check: the customUrl
      // already opened the page with pdoc_id selected, so simulate that it landed.
      if (src.includes('select[name="pdoc_id"]')) return "400100";
      // travel-report.ts readReportContentFields / post-save readback
      if (src.includes("out[names[i]]") || src.includes("for (const n of names)")) {
        const out: Record<string, string> = {};
        for (const n of (arg as string[]) ?? []) out[n] = "";
        return out;
      }
      return [];
    }),
  };
  // leave: the substitute popup (mandatory, no fallback - see submitLeave's own comment).
  // Always "found" so the popup path completes without needing a realistic row DOM.
  const popup: any = {
    waitForLoadState: vi.fn(async () => undefined),
    waitForSelector: vi.fn(async () => null),
    waitForTimeout: vi.fn(async () => undefined),
    evaluate: vi.fn(async () => ({ found: true, ambiguous: false, candidates: [] })),
    click: vi.fn(async () => undefined),
  };
  const page: any = {
    frame: vi.fn(() => frame),
    mainFrame: vi.fn(() => frame),
    frames: vi.fn(() => [frame]),
    goto: vi.fn(async () => null),
    waitForTimeout: vi.fn(async () => undefined),
    waitForLoadState: vi.fn(async () => undefined),
    waitForNavigation: vi.fn(async () => undefined),
    waitForEvent: vi.fn(async () => popup),
    url: vi.fn(() => "https://gw.ip-korea.org/"),
    // Satisfies confirmDraftResult's Drafts-list check for the one non-dry-run sanity
    // test below; dry_run itself never reaches this (no docId in its response).
    content: vi.fn(async () => '<a href="document_view.php?doc_id=99999">draft</a>'),
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
    screenshotDir: path.join(os.tmpdir(), "ipk-dry-run-test-shots"),
    screenshotTtlMinutes: 1,
  };
  return { frame, page, session, config };
}

beforeEach(() => {
  setFormModeSpy.mockClear();
  submitFormSpy.mockClear();
  submitTravelReportDraftSpy.mockClear();
});

const CASES: { name: string; params: Record<string, unknown> }[] = [
  { name: "leave", params: { form_type: "leave", leave_type: "annual", start_date: "2026-11-07", end_date: "2026-11-07", substitute_name: "Synthetic Colleague" } },
  {
    name: "working",
    params: { form_type: "working", reason: "Nextflow based urban metagenomic surveillance pipeline optimization", rows: [{ date: "2026-11-07", hours: 2 }] },
  },
  { name: "travel_request", params: { form_type: "travel_request", budget_code: "NN2606-0001", destination: "Daejeon KRISS", purpose: "Vendor technical meeting" } },
  { name: "travel (domestic report)", params: { form_type: "travel", request_doc_id: "299953", purpose: "x".repeat(100), schedule: "y".repeat(100), reason: "z".repeat(100), start_date: "2026-09-14", end_date: "2026-09-16" } },
  {
    name: "travel (overseas report)",
    params: {
      form_type: "travel", request_doc_id: "400100", report_kind: "overseas", title: "Conference trip", destination: "Boston",
      start_date: "2026-09-14", end_date: "2026-09-16",
      purpose: "x".repeat(100), schedule: "y".repeat(100), reason: "z".repeat(100), // TRAVEL_REPORT_FIELDS_MIN_LENGTH applies to both report paths
    },
  },
  { name: "travel_settlement", params: { form_type: "travel_settlement", approved_doc_ref: "299953" } },
  { name: "budget_transfer", params: { form_type: "budget_transfer" } },
  { name: "expense", params: { form_type: "expense", budget_code: "NN2606-0001" } },
  { name: "card_expense", params: { form_type: "card_expense", budget_code: "NN2606-0001" } },
];

describe("dry_run=true never calls the save helpers, for every wired form type", () => {
  for (const { name, params } of CASES) {
    it(`${name}: setFormMode/submitForm/submitTravelReportDraft are never called`, async () => {
      const h = makeHarness();
      const out = parse(await handleIpkSubmitForm(h.session, h.config, { ...params, dry_run: true, draft_only: true, confirm_submit: false }));

      expect(out.error).toBe(false);
      expect(out.data.dry_run).toBe(true);
      expect(setFormModeSpy).not.toHaveBeenCalled();
      expect(submitFormSpy).not.toHaveBeenCalled();
      expect(submitTravelReportDraftSpy).not.toHaveBeenCalled();
    });
  }

  it("the non-dry-run path for the same params DOES reach a save helper (sanity check that the spies work)", async () => {
    const h = makeHarness();
    const out = parse(await handleIpkSubmitForm(h.session, h.config, {
      form_type: "budget_transfer", draft_only: true, confirm_submit: false,
    }));
    expect(out.error).toBe(false);
    expect(setFormModeSpy).toHaveBeenCalledTimes(1);
    expect(submitFormSpy).toHaveBeenCalledTimes(1);
  });
});

describe("dry_run response shape", () => {
  it("returns fields (serialized DOM) and field_rule_result, never a docId", async () => {
    const h = makeHarness();
    const out = parse(await handleIpkSubmitForm(h.session, h.config, {
      form_type: "leave", leave_type: "annual", start_date: "2026-11-07", end_date: "2026-11-07", substitute_name: "Synthetic Colleague",
      dry_run: true, draft_only: true,
    }));
    expect(out.data.form).toBe("leave");
    expect(out.data.fields).toBeDefined();
    expect(out.data.field_rule_result).toHaveProperty("blocks");
    expect(out.data.field_rule_result).toHaveProperty("warnings");
    expect(out.data).not.toHaveProperty("docId");
  });

  it("domestic travel report: reports existing_report_lengths and never REPORT_ALREADY_EXISTS under dry_run", async () => {
    const h = makeHarness();
    h.frame.evaluate = vi.fn(async (fn: any, arg?: any) => {
      const src = String(fn);
      if (src.includes("out[names[i]]")) {
        // Simulate a request that already has a report.
        const out: Record<string, string> = {};
        for (const n of (arg as string[]) ?? []) out[n] = n === "purpose_field" ? "x".repeat(150) : "";
        return out;
      }
      if (src.includes("knownSet")) return { subject: "stub" };
      return [];
    });
    const out = parse(await handleIpkSubmitForm(h.session, h.config, {
      form_type: "travel", request_doc_id: "299953",
      purpose: "x".repeat(100), schedule: "y".repeat(100), reason: "z".repeat(100),
      start_date: "2026-09-14", end_date: "2026-09-16",
      dry_run: true, draft_only: true,
    }));
    expect(out.error).toBe(false);
    expect(out.code).not.toBe("REPORT_ALREADY_EXISTS");
    expect(out.data.existing_report_lengths).toEqual(expect.objectContaining({ purpose_field: 150 }));
    expect(submitTravelReportDraftSpy).not.toHaveBeenCalled();
  });
});
