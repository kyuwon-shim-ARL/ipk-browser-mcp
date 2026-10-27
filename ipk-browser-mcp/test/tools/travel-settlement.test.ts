/**
 * Travel settlement (AppFrm-054) save path - live-read 2026-10-27 of the real 054 write
 * page: the parent AppFrm-023 request is linked by opening document_write.php with
 * p_doc_id in the query string (not by writing sel_travel - on a bare page that is a plain
 * hidden input with no change handler, so it can never auto-populate). Check_Form_Request
 * always opens a budget_frame popup (budget_check_settle.php) and retargets the opener's
 * form at it; only the popup's own submit_form() actually files anything (confirmed live
 * 2026-09-18: doc 300391 only landed in Drafts after submit_form() ran in the popup).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("../../src/security/attachment-path.js", () => ({ validateAttachmentPath: () => null }));

const { setFormModeSpy, submitFormSpy, auditSpy } = vi.hoisted(() => ({
  setFormModeSpy: vi.fn(async () => undefined),
  submitFormSpy: vi.fn(async () => "99999"),
  auditSpy: vi.fn(),
}));

vi.mock("../../src/internal/audit.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/internal/audit.js")>("../../src/internal/audit.js");
  return { ...actual, audit: auditSpy };
});

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

const REQUEST_DOC_ID = "299953";

interface HarnessOpts {
  /** value read back from #p_doc_id on the write page */
  pDocIdOnPage?: string;
  /** whether start_date/budget_control_no come back non-empty (the form prefilled) */
  prefilled?: boolean;
  /** hrefs returned by the approved-request lookup list page (for non-numeric/omitted ref) */
  lookupHrefs?: string[];
  /** tr rows (href/docNo) returned by the doc-number lookup ($$eval("tr", ...)) */
  lookupRows?: { href: string; docNo: string }[];
  /** popup: null = never appears, otherwise its url + whether it carries a dialog */
  popup?: { url?: string; dialogMessage?: string } | null;
  /** mode1 value saveTravelSettlement reads back right before calling submit_form() in the
   *  popup - defaults to "draft" (setFormMode is mocked out below, so this harness stands
   *  in for "the mode it was set to actually stuck"). */
  mode1AtPopupCheck?: string;
  /** budget_check_settle popup body text (budgetPopupRefusals reads this right before submit_form()) */
  popupBodyText?: string;
  /** a dialog the OPENER itself raises (e.g. a Check_Form_Request alert) before any popup opens */
  openerDialogMessage?: string;
}

function makeHarness(opts: HarnessOpts = {}) {
  const {
    pDocIdOnPage = REQUEST_DOC_ID,
    prefilled = true,
    lookupHrefs = [],
    lookupRows = [],
    popup: popupOpts = { url: "https://gw.ip-korea.org/Document/budget_check_settle.php" },
    mode1AtPopupCheck = "draft",
    popupBodyText = "ok",
    openerDialogMessage,
  } = opts;

  const fieldWrites: { sel: string; val: string }[] = [];
  const pageHandlers: Record<string, ((x: any) => void)[]> = {};

  const frame: any = {
    goto: vi.fn(async () => null),
    waitForLoadState: vi.fn(async () => undefined),
    waitForSelector: vi.fn(async () => ({})),
    waitForURL: vi.fn(async () => undefined),
    url: vi.fn(() => "https://gw.ip-korea.org/Document/document_view.php?doc_id=99999&approve_type=AppFrm-054"),
    evaluate: vi.fn(async (fn: any, arg?: any) => {
      const src = String(fn);
      // submitTravelSettlement's read-only p_doc_id link verification
      if (src.includes("p_doc_id")) {
        return { pDocId: pDocIdOnPage, prefilled };
      }
      // setFieldValue (iframe-helper.ts) - field writes, tracked by selector
      if (arg && typeof arg === "object" && "sel" in arg && "val" in arg) {
        fieldWrites.push({ sel: arg.sel, val: arg.val });
        return "ok";
      }
      // saveTravelSettlement's own Check_Form_Request('insert') trigger - the opener's own
      // alert (if any) fires right here, same order as production (watchDialogs(page) runs
      // before this call).
      if (src.includes("Check_Form_Request")) {
        if (openerDialogMessage) {
          for (const fn of pageHandlers["dialog"] ?? []) {
            fn({ message: () => openerDialogMessage, dismiss: async () => undefined });
          }
        }
        return undefined;
      }
      // saveTravelSettlement's own mode1 re-read right before submit_form() (setFormMode
      // itself is mocked out below - this is the harness's stand-in for its outcome).
      if (src.includes('getElementsByName("mode1")')) {
        return [mode1AtPopupCheck];
      }
      // field-rules.ts serializeFormFields
      if (src.includes("knownSet")) return { subject: "stub" };
      return [];
    }),
    $$eval: vi.fn(async (sel: string) => {
      if (sel === "tr") return lookupRows.map((r) => ({ href: r.href, docId: (r.href.match(/doc_id=(\d+)/) ?? [])[1] ?? "", docNo: r.docNo }));
      return lookupHrefs;
    }),
    mainFrame: vi.fn(),
  };
  frame.mainFrame.mockImplementation(() => frame);

  const handlers: Record<string, ((x: any) => void)[]> = {};
  const makePop = (body = popupBodyText) => {
    const pop: any = {
      url: () => popupOpts?.url ?? "https://gw.ip-korea.org/Document/budget_check_settle.php",
      on: vi.fn((ev: string, fn: (x: any) => void) => { (handlers[ev] ??= []).push(fn); }),
      waitForLoadState: vi.fn(async () => {
        if (popupOpts?.dialogMessage) {
          for (const fn of handlers["dialog"] ?? []) {
            fn({ message: () => popupOpts.dialogMessage, dismiss: async () => undefined });
          }
        }
      }),
      waitForTimeout: vi.fn(async () => undefined),
      evaluate: vi.fn(async () => body),
      close: vi.fn(async () => undefined),
    };
    return pop;
  };

  const ctx = { on: vi.fn(), off: vi.fn() };
  let lastPop: any = null;
  const waitForEventPage = vi.fn(async (ev: string) => {
    if (ev !== "popup") throw new Error(`unexpected waitForEvent(${ev})`);
    if (!popupOpts) throw new Error("Timeout 25000ms exceeded");
    lastPop = makePop();
    return lastPop;
  });

  const page: any = {
    frame: vi.fn(() => frame),
    mainFrame: vi.fn(() => frame),
    frames: vi.fn(() => [frame]),
    goto: vi.fn(async () => null),
    waitForTimeout: vi.fn(async () => undefined),
    waitForLoadState: vi.fn(async () => undefined),
    url: vi.fn(() => "https://gw.ip-korea.org/"),
    content: vi.fn(async () => '<a href="document_view.php?doc_id=99999">draft</a>'),
    context: vi.fn(() => ctx),
    on: vi.fn((ev: string, fn: (x: any) => void) => { (pageHandlers[ev] ??= []).push(fn); }),
    off: vi.fn((ev: string, fn: (x: any) => void) => {
      const list = pageHandlers[ev];
      if (!list) return;
      const i = list.indexOf(fn);
      if (i !== -1) list.splice(i, 1);
    }),
    waitForEvent: waitForEventPage,
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
    screenshotDir: path.join(os.tmpdir(), "ipk-travel-settlement-test-shots"),
    screenshotTtlMinutes: 1,
  };
  return { frame, page, session, config, fieldWrites, pageHandlers, get pop() { return lastPop; } };
}

const baseParams = (over: Record<string, unknown> = {}) => ({
  form_type: "travel_settlement",
  approved_doc_ref: REQUEST_DOC_ID,
  title: "Settlement for Boston trip",
  attachment_slot: "verification",
  draft_only: true,
  confirm_submit: false,
  ...over,
});

beforeEach(() => {
  setFormModeSpy.mockClear();
  submitFormSpy.mockClear();
  auditSpy.mockClear();
});

describe("travel_settlement (AppFrm-054) parent-request navigation", () => {
  it("customUrl's p_doc_id carries the numeric approved_doc_ref directly, no lookup", async () => {
    const h = makeHarness();
    await handleIpkSubmitForm(h.session, h.config, baseParams());

    const url = h.frame.goto.mock.calls[0]?.[0] as string;
    expect(url).toContain("approve_type=AppFrm-054");
    expect(url).toContain(`p_doc_id=${REQUEST_DOC_ID}`);
    expect(h.frame.$$eval).not.toHaveBeenCalled();
  });

  it("a non-numeric approved_doc_ref is looked up by exact document-number match, not folded into a keyword search", async () => {
    const h = makeHarness({
      lookupRows: [
        { href: `document_view.php?doc_id=${REQUEST_DOC_ID}&approve_type=AppFrm-023`, docNo: "ARL-260101-01" },
      ],
    });
    const out = parse(await handleIpkSubmitForm(h.session, h.config, baseParams({ approved_doc_ref: "ARL-260101-01" })));

    expect(out.error).toBe(false);
    expect(h.frame.$$eval).toHaveBeenCalledWith("tr", expect.anything());
    const lookupUrl = h.page.goto.mock.calls.find((c: any[]) => String(c[0]).includes("document_list.php"))?.[0] as string;
    expect(lookupUrl).toContain("keyword=ARL-260101-01");
    expect(lookupUrl).toContain("doc_no=Y");
    const url = h.frame.goto.mock.calls.find((c: any[]) => String(c[0]).includes("AppFrm-054"))?.[0] as string;
    expect(url).toContain(`p_doc_id=${REQUEST_DOC_ID}`);
  });

  it("refuses PARENT_DOC_REQUIRED when a non-numeric approved_doc_ref matches no row by exact document number", async () => {
    const h = makeHarness({
      lookupRows: [
        { href: `document_view.php?doc_id=${REQUEST_DOC_ID}&approve_type=AppFrm-023`, docNo: "ARL-260101-99" },
      ],
    });
    const out = parse(await handleIpkSubmitForm(h.session, h.config, baseParams({ approved_doc_ref: "ARL-260101-01" })));

    expect(out.error).toBe(true);
    expect(out.code).toBe("PARENT_DOC_REQUIRED");
    expect(setFormModeSpy).not.toHaveBeenCalled();
    expect(h.pop).toBeNull();
  });

  it("refuses PARENT_DOC_REQUIRED when a non-numeric approved_doc_ref matches more than one row by exact document number", async () => {
    const h = makeHarness({
      lookupRows: [
        { href: "document_view.php?doc_id=1&approve_type=AppFrm-023", docNo: "ARL-260101-01" },
        { href: "document_view.php?doc_id=2&approve_type=AppFrm-023", docNo: "ARL-260101-01" },
      ],
    });
    const out = parse(await handleIpkSubmitForm(h.session, h.config, baseParams({ approved_doc_ref: "ARL-260101-01" })));

    expect(out.error).toBe(true);
    expect(out.code).toBe("PARENT_DOC_REQUIRED");
  });

  it("an omitted approved_doc_ref also triggers the auto-lookup", async () => {
    const h = makeHarness({ lookupHrefs: [`document_view.php?doc_id=${REQUEST_DOC_ID}&approve_type=AppFrm-023`] });
    const out = parse(await handleIpkSubmitForm(h.session, h.config, baseParams({ approved_doc_ref: undefined })));

    expect(h.frame.$$eval).toHaveBeenCalled();
    expect(out.error).toBe(false);
  });

  it("L3: refuses PARENT_DOC_REQUIRED without even navigating when request_keyword/title/destination are all empty", async () => {
    const h = makeHarness({ lookupHrefs: [`document_view.php?doc_id=${REQUEST_DOC_ID}&approve_type=AppFrm-023`] });
    const out = parse(await handleIpkSubmitForm(h.session, h.config, baseParams({ approved_doc_ref: undefined, title: "" })));

    expect(out.error).toBe(true);
    expect(out.code).toBe("PARENT_DOC_REQUIRED");
    expect(out.message).toMatch(/no keyword/);
    expect(h.page.goto.mock.calls.some((c: any[]) => String(c[0]).includes("document_list.php"))).toBe(false);
    expect(h.pop).toBeNull();
  });

  it("L3: refuses PARENT_DOC_REQUIRED when the approved-request list has a second page (start_page=2)", async () => {
    const h = makeHarness({
      lookupHrefs: [
        `document_view.php?doc_id=${REQUEST_DOC_ID}&approve_type=AppFrm-023`,
        `document_list.php?type=approved&start_page=2`,
      ],
    });
    const out = parse(await handleIpkSubmitForm(h.session, h.config, baseParams({ approved_doc_ref: undefined })));

    expect(out.error).toBe(true);
    expect(out.code).toBe("PARENT_DOC_REQUIRED");
    expect(out.message).toMatch(/more than one page/);
    expect(h.pop).toBeNull();
  });

  it("refuses PARENT_DOC_REQUIRED when the lookup matches zero approved requests", async () => {
    const h = makeHarness({ lookupHrefs: [] });
    const out = parse(await handleIpkSubmitForm(h.session, h.config, baseParams({ approved_doc_ref: undefined })));

    expect(out.error).toBe(true);
    expect(out.code).toBe("PARENT_DOC_REQUIRED");
    expect(setFormModeSpy).not.toHaveBeenCalled();
    expect(h.pop).toBeNull();
  });

  it("refuses PARENT_DOC_REQUIRED when the lookup matches more than one approved request", async () => {
    const h = makeHarness({
      lookupHrefs: [
        "document_view.php?doc_id=1&approve_type=AppFrm-023",
        "document_view.php?doc_id=2&approve_type=AppFrm-023",
      ],
    });
    const out = parse(await handleIpkSubmitForm(h.session, h.config, baseParams({ approved_doc_ref: undefined })));

    expect(out.error).toBe(true);
    expect(out.code).toBe("PARENT_DOC_REQUIRED");
    expect(setFormModeSpy).not.toHaveBeenCalled();
  });
});

describe("travel_settlement (AppFrm-054) parent-link verification", () => {
  it("refuses PARENT_DOC_NOT_ACCEPTED when #p_doc_id does not match the requested id, no save attempted", async () => {
    const h = makeHarness({ pDocIdOnPage: "some-other-doc" });
    const out = parse(await handleIpkSubmitForm(h.session, h.config, baseParams()));

    expect(out.error).toBe(true);
    expect(out.message).toContain("PARENT_DOC_NOT_ACCEPTED");
    expect(setFormModeSpy).not.toHaveBeenCalled();
    expect(h.pop).toBeNull();
  });

  it("refuses PARENT_DOC_NOT_ACCEPTED when p_doc_id matches but the form never prefilled, no save attempted", async () => {
    const h = makeHarness({ prefilled: false });
    const out = parse(await handleIpkSubmitForm(h.session, h.config, baseParams()));

    expect(out.error).toBe(true);
    expect(out.message).toContain("PARENT_DOC_NOT_ACCEPTED");
    expect(setFormModeSpy).not.toHaveBeenCalled();
  });
});

describe("travel_settlement (AppFrm-054) only writes fields the caller passed", () => {
  it("writes subject but no amount fields when none were passed", async () => {
    const h = makeHarness();
    const out = parse(await handleIpkSubmitForm(h.session, h.config, baseParams({ dry_run: true })));

    expect(out.error).toBe(false);
    const names = h.fieldWrites.map((w) => w.sel);
    expect(names.some((s) => s.includes("subject"))).toBe(true);
    expect(names.some((s) => s.includes("daily_fee_total"))).toBe(false);
    expect(names.some((s) => s.includes("ocar_pay"))).toBe(false);
    expect(names.some((s) => s.includes("accommodation_fee_total"))).toBe(false);
    expect(names.some((s) => s.includes("food_fee_total"))).toBe(false);
    expect(names.some((s) => s.includes("budget_control_no"))).toBe(false);
  });

  it("writes only the amount fields explicitly passed", async () => {
    const h = makeHarness();
    const out = parse(await handleIpkSubmitForm(h.session, h.config, baseParams({ dry_run: true, daily_expense: 30000 })));

    expect(out.error).toBe(false);
    const names = h.fieldWrites.map((w) => w.sel);
    expect(names.some((s) => s.includes("daily_fee_total"))).toBe(true);
    expect(names.some((s) => s.includes("ocar_pay"))).toBe(false);
    expect(names.some((s) => s.includes("accommodation_fee_total"))).toBe(false);
    expect(names.some((s) => s.includes("food_fee_total"))).toBe(false);
  });
});

describe("travel_settlement (AppFrm-054) save via budget_check_settle popup", () => {
  it("sets mode1='draft' via Check_Form_Request, then calls submit_form() in the budget_check_settle popup", async () => {
    const h = makeHarness();
    const out = parse(await handleIpkSubmitForm(h.session, h.config, baseParams()));

    expect(out.error).toBe(false);
    expect(out.data.docId).toBe("99999");
    expect(out.data.mode).toBe("draft");
    expect(out.data.formType).toBe("travel_settlement");
    expect(out.data.parent_doc_id).toBe(REQUEST_DOC_ID);

    // Order: the popup is awaited before Check_Form_Request triggers it, which in turn
    // runs before submit_form() is called inside it.
    const popupWaitOrder = h.page.waitForEvent.mock.invocationCallOrder[0];
    const triggerOrder = h.frame.evaluate.mock.calls.findIndex((c: any[]) => String(c[0]).includes("Check_Form_Request"));
    const triggerCallOrder = h.frame.evaluate.mock.invocationCallOrder[triggerOrder];
    const submitCallIdx = h.pop.evaluate.mock.calls.findIndex((c: any[]) => c[0] === "submit_form()");
    const submitCallOrder = h.pop.evaluate.mock.invocationCallOrder[submitCallIdx];
    expect(popupWaitOrder).toBeLessThan(triggerCallOrder);
    expect(triggerCallOrder).toBeLessThan(submitCallOrder);
  });

  it("L5: the success audit only claims a doc_id came back (action 'submit', no 'mode'/'draft' claim) - there is no Drafts-list check here to claim ahead of", async () => {
    const h = makeHarness();
    const out = parse(await handleIpkSubmitForm(h.session, h.config, baseParams()));

    expect(out.error).toBe(false);
    const submitCalls = auditSpy.mock.calls.map((c: any[]) => c[0]).filter((e: any) => e.action === "submit");
    expect(submitCalls).toHaveLength(1);
    expect(submitCalls[0]).toEqual({ action: "submit", docId: "99999", ok: true });
    expect(submitCalls[0]).not.toHaveProperty("mode");
  });

  it("M-A: removes its 'dialog' listener from the shared session page afterward (page.off), so a later form's own dialog is not dismissed by it", async () => {
    const h = makeHarness();
    await handleIpkSubmitForm(h.session, h.config, baseParams());

    expect(h.pageHandlers["dialog"] ?? []).toEqual([]);
    // The context "page" listener (for a popup appearing later) is also removed.
    expect(h.page.off).toHaveBeenCalled();
  });

  it("M-A: still removes the page dialog listener when the save is refused", async () => {
    const h = makeHarness({ popup: { url: "https://gw.ip-korea.org/Document/some_other_popup.php" } });
    const out = parse(await handleIpkSubmitForm(h.session, h.config, baseParams()));

    expect(out.error).toBe(true);
    expect(h.pageHandlers["dialog"] ?? []).toEqual([]);
  });

  it("refuses and never calls submit_form() when the popup URL does not match budget_check_settle", async () => {
    const h = makeHarness({ popup: { url: "https://gw.ip-korea.org/Document/some_other_popup.php" } });
    const out = parse(await handleIpkSubmitForm(h.session, h.config, baseParams()));

    expect(out.error).toBe(true);
    expect(out.code).toBe("BUDGET_CHECK_REFUSED");
  });

  it("refuses and never calls submit_form() when the popup raises a dialog", async () => {
    const h = makeHarness({ popup: { dialogMessage: "Insufficient budget" } });
    const out = parse(await handleIpkSubmitForm(h.session, h.config, baseParams()));

    expect(out.error).toBe(true);
    expect(out.code).toBe("BUDGET_CHECK_REFUSED");
    expect(out.budget_check_messages?.join(" ")).toContain("Insufficient budget");
  });

  it("refuses with a 'nothing was saved' message when no popup ever appears", async () => {
    const h = makeHarness({ popup: null });
    const out = parse(await handleIpkSubmitForm(h.session, h.config, baseParams()));

    expect(out.error).toBe(true);
    expect(out.code).toBe("SUBMIT_UNVERIFIED");
  });

  it("refuses and never calls submit_form() when the popup's own body text says the budget is insufficient", async () => {
    const h = makeHarness({ popupBodyText: "Budget check\nNot enough budget." });
    const out = parse(await handleIpkSubmitForm(h.session, h.config, baseParams()));

    expect(out.error).toBe(true);
    expect(out.code).toBe("BUDGET_CHECK_REFUSED");
    expect(out.budget_check_messages?.join(" ")).toContain("Not enough budget");
    expect(h.pop.evaluate).not.toHaveBeenCalledWith("submit_form()");
  });

  it("reports SUBMIT_REJECTED (not a 25s 'no popup' timeout) when the opener itself raises an alert before any popup opens", async () => {
    const h = makeHarness({ popup: null, openerDialogMessage: "Please fill in all required fields." });
    const out = parse(await handleIpkSubmitForm(h.session, h.config, baseParams()));

    expect(out.error).toBe(true);
    expect(out.code).toBe("SUBMIT_REJECTED");
    expect(out.message).toContain("Please fill in all required fields.");
    expect(h.pop).toBeNull();
  });

  it("refuses and never calls submit_form() when mode1 changed before the popup's re-read", async () => {
    const h = makeHarness({ mode1AtPopupCheck: "request" });
    const out = parse(await handleIpkSubmitForm(h.session, h.config, baseParams()));

    expect(out.error).toBe(true);
    expect(out.code).toBe("DRAFT_MODE_NOT_SET");
    expect(out.mode1).toEqual(["request"]);
  });
});
