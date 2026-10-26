/**
 * card_expense_rd (AppFrm-021, mker=Y) is never submitted by this tool (draft_only=false is
 * refused, CARD_ER_NO_SUBMIT), and draft_only=true is a no-save preview that runs the form's
 * own Check_Form_Request with nothing able to leave the browser. The only save is
 * allow_card_er_save with a one-time per-transaction authorization file: a save through the
 * form's own [Draft] flow submitted doc 302098 for approval on 2026-10-23 instead of saving
 * a draft, so each save needs a person's go-ahead and its outcome is read back.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

vi.mock("../../src/internal/primitives/account.js", () => ({
  fetchAccountCodes: vi.fn(async () => [{ seq: "77", code: "410318", label: "IT Software (IT Subscription)" }]),
}));
// The receipt path is never read: uploads are mocked, so the allowlist check is too.
vi.mock("../../src/security/attachment-path.js", () => ({ validateAttachmentPath: () => null }));
vi.mock("../../src/internal/primitives/attachment.js", () => ({
  attachFiles: vi.fn(async (_f: unknown, paths: string[]) => ({ attached: paths.length, skipped: [] })),
}));

import { handleIpkSubmitForm, installCardErStubs, runCheckFormRequest } from "../../src/tools/ipk-submit.js";
import { checkOrgPolicy } from "../../src/policy/org-policy.js";
import { normalizeCardSubject, isPreviewBlockedRequest, summarizeCapturedForm, isMeetingAccount, isOvertimeAccount, isOverseasItSubscription, budgetPopupRefusals } from "../../src/forms/card-er.js";

// ── pure helpers ───────────────────────────────────────────────────

describe("normalizeCardSubject", () => {
  it("adds the [Card] prefix the form's own Check_Form_Request adds", () => {
    expect(normalizeCardSubject("Google Cloud (Gemini API) usage fee")).toBe("[Card] Google Cloud (Gemini API) usage fee");
  });
  it("is idempotent and collapses a doubled prefix", () => {
    expect(normalizeCardSubject("[Card] RunPod usage fee")).toBe("[Card] RunPod usage fee");
    expect(normalizeCardSubject("[Card] [Card] RunPod usage fee")).toBe("[Card] RunPod usage fee");
    expect(normalizeCardSubject("  [card]RunPod usage fee ")).toBe("[Card] RunPod usage fee");
  });
  it("keeps other bracket tags after the prefix", () => {
    expect(normalizeCardSubject("[Software] Claude subscription")).toBe("[Card] [Software] Claude subscription");
  });
});

describe("isPreviewBlockedRequest", () => {
  const base = "https://gw.ip-korea.org/Document/";
  it("blocks every write and the filing endpoints", () => {
    expect(isPreviewBlockedRequest("POST", `${base}document_write.php`)).toBe(true);
    expect(isPreviewBlockedRequest("POST", `${base}budget_check_er.php`)).toBe(true);
    expect(isPreviewBlockedRequest("GET", `${base}budget_check_er.php?x=1`)).toBe(true);
    expect(isPreviewBlockedRequest("GET", `${base}document_write.php?approve_type=AppFrm-021`)).toBe(true);
    expect(isPreviewBlockedRequest("GET", `${base}doc_approve.php?doc_id=1`)).toBe(true);
    expect(isPreviewBlockedRequest("POST", "https://gw.ip-korea.org/anything.php")).toBe(true);
  });
  it("lets reads through", () => {
    expect(isPreviewBlockedRequest("GET", `${base}pr_account_sel.php`)).toBe(false);
    expect(isPreviewBlockedRequest("GET", "https://gw.ip-korea.org/js/jquery-confirm.js")).toBe(false);
  });
});

describe("summarizeCapturedForm", () => {
  it("keeps scalars and every row of the row fields", () => {
    const s = summarizeCapturedForm([
      ["subject", "[Card] Team lunch"],
      ["budget_code", "NN2606-0001"],
      ["account_code[]", ""],
      ["account_code[]", "412107"],
      ["venue[]", ""],
      ["venue[]", "Pangyo"],
      ["item_amount[]", "50000"],
      ["doc_attach_file[]", "file:receipt.pdf"],
      ["unrelated", "x"],
    ]);
    expect(s.subject).toBe("[Card] Team lunch");
    expect(s.budget_code).toBe("NN2606-0001");
    expect(s["account_code[]"]).toEqual(["", "412107"]);
    expect(s["venue[]"]).toEqual(["", "Pangyo"]);
    expect(s["item_amount[]"]).toEqual(["50000"]);
    expect(s["doc_attach_file[]"]).toEqual(["file:receipt.pdf"]);
    expect(s.unrelated).toBeUndefined();
    expect(s.p_reason).toBeNull();
  });
});

// ── handler paths, with mocked page/frame ──────────────────────────

const ATTACH = "/home/tester/Downloads/receipt.pdf";

interface Run {
  alerts: string[];
  confirms: string[];
  confirmButtons: string[];
  pressed: string | null;
  opens: string[];
  submits: { action: string; target: string; entries: [string, string][] }[];
  jquery: boolean;
  pageError: string | null;
}

const okRun = (): Run => ({
  alerts: [],
  confirms: [],
  confirmButtons: ["Next", "Cancel"],
  pressed: "Next",
  opens: ["budget_frame"],
  submits: [{
    action: "./budget_check_er.php",
    target: "budget_frame",
    entries: [["subject", "[Card] Google Cloud usage fee"], ["budget_code", "NN2606-0001"], ["account_code[]", "410318"]],
  }],
  jquery: true,
  pageError: null,
});

function makeHarness(run: Run, waitForPopup: () => Promise<any> = async () => { throw new Error("Timeout 25000ms exceeded"); }) {
  const stubInstalls: boolean[] = [];
  const evaluated: string[] = [];
  const frame: any = {
    goto: vi.fn(async () => null),
    waitForLoadState: vi.fn(async () => undefined),
    waitForSelector: vi.fn(async () => ({})),
    url: vi.fn(() => "https://gw.ip-korea.org/Document/document_write.php?approve_type=AppFrm-021&mker=Y"),
    evaluate: vi.fn(async (fn: any, arg?: any) => {
      const name = typeof fn === "function" ? fn.name : String(fn);
      evaluated.push(name);
      if (name === "installCardErStubs") { stubInstalls.push(arg); return undefined; }
      if (name === "runCheckFormRequest") return run;
      const src = String(fn);
      if (src.includes("vender_kor")) return { budget_type: "02", budget_code: "NN2606-0001", amount: "11000", vender_kor: "구글" };
      if (src.includes("__ipkCardEr")) return run;
      // serializeFormFields (iframe-helper.ts): this harness does not track real field
      // state, so return a minimal subject-only draft - enough to pass field-rules.ts's
      // own checks (not empty, so it is not the fail-closed "unreadable form" case) and
      // free of self-scope field names (budget_code, card_no, ...), which would block on
      // a profile this test environment does not set up. card-er.test.ts tests the
      // card_expense_rd submit flow around the form; field-rules.ts has its own tests
      // (field-rules.test.ts, field-rules-integration.test.ts).
      if (src.includes("knownSet")) return { subject: "[Card] test subject" };
      return undefined;
    }),
  };
  const ctx = { route: vi.fn(async () => undefined), unroute: vi.fn(async () => undefined), on: vi.fn(), off: vi.fn() };
  const page: any = {
    frame: vi.fn(() => frame),
    mainFrame: vi.fn(() => frame),
    frames: vi.fn(() => [frame]),
    goto: vi.fn(async () => null),
    waitForTimeout: vi.fn(async () => undefined),
    waitForLoadState: vi.fn(async () => undefined),
    url: vi.fn(() => "https://gw.ip-korea.org/"),
    route: vi.fn(async () => undefined),
    unroute: vi.fn(async () => undefined),
    context: vi.fn(() => ctx),
    screenshot: vi.fn(async () => Buffer.from("")),
    viewportSize: vi.fn(() => ({ width: 1280, height: 800 })),
    setViewportSize: vi.fn(async () => undefined),
    once: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    waitForEvent: vi.fn(waitForPopup),
  };
  const session: any = {
    isLoggedIn: () => true,
    getLoginState: () => "logged_in",
    getPage: () => page,
    getSessionRemainingMs: () => 60 * 60 * 1000,
    touchActivity: () => undefined,
    getUserInfo: () => ({ name: "Tester" }),
  };
  const config: any = {
    baseUrl: "https://gw.ip-korea.org",
    navTimeoutMs: 1000,
    screenshotDir: path.join(os.tmpdir(), "ipk-card-er-test-shots"),
    screenshotTtlMinutes: 1,
  };
  return { frame, page, ctx, session, config, stubInstalls, evaluated };
}

const params = (over: Record<string, unknown> = {}) => ({
  form_type: "card_expense_rd",
  trseq: "26040417102",
  appr_no: "19984403",
  subject: "Google Cloud usage fee",
  item_name: "Google Cloud Gemini API service",
  seller_en: "Google Cloud Korea LLC",
  p_reason: "Cloud compute for molecular embedding",
  item_account_code: "410318",
  attachment_paths: [ATTACH],
  draft_only: true,
  confirm_submit: false,
  ...over,
});

const parse = (r: any) => JSON.parse(r.content[0].text);

/** A budget_check_er popup: body text, and dialogs it raises while loading. */
function makePopup(body = "Budget check", dialogsOnLoad: string[] = []) {
  const handlers: Record<string, ((x: any) => void)[]> = {};
  const pop: any = {
    url: () => "https://gw.ip-korea.org/Document/budget_check_er.php",
    dismissed: [] as string[],
    on: vi.fn((ev: string, fn: (x: any) => void) => { (handlers[ev] ??= []).push(fn); }),
    fire(ev: string, message: string) {
      for (const fn of handlers[ev] ?? []) fn({ message: () => message, dismiss: async () => { pop.dismissed.push(message); } });
    },
    waitForLoadState: vi.fn(async () => { for (const m of dialogsOnLoad) pop.fire("dialog", m); }),
    waitForTimeout: vi.fn(async () => undefined),
    evaluate: vi.fn(async (fn: any) => (typeof fn === "function" ? body : undefined)),
    close: vi.fn(async () => undefined),
  };
  return pop;
}

describe("card_expense_rd with draft_only=true is a no-save preview", () => {
  beforeEach(() => vi.clearAllMocks());

  it("the test params pass org policy, so the handler is what is under test", () => {
    expect(checkOrgPolicy(params())).toEqual([]);
  });

  it("runs the form's own Check_Form_Request with submit captured, and saves nothing", async () => {
    const h = makeHarness(okRun());
    const out = parse(await handleIpkSubmitForm(h.session, h.config, params()));

    expect(out.error).toBe(false);
    expect(out.data.mode).toBe("preview");
    expect(out.data.saved).toBe(false);
    expect(out.data.docId).toBeNull();
    expect(out.data.would_submit).toBe(true);
    expect(out.data.message).toMatch(/preview-only/);
    expect(out.data.message).toMatch(/Nothing was saved/);
    expect(out.data.message).not.toMatch(/draft saved/);
    expect(out.data.captured.subject).toBe("[Card] Google Cloud usage fee");
    expect(out.data.captured_action).toBe("./budget_check_er.php");

    // In-frame stubs installed in capture mode, then the page's own handler ran.
    expect(h.stubInstalls).toEqual([true]);
    expect(h.evaluated).toContain("runCheckFormRequest");
    // No popup orchestration: nothing waits to call submit_form().
    expect(h.page.once).not.toHaveBeenCalled();
    expect(h.page.on).not.toHaveBeenCalledWith("popup", expect.anything());

    // Network cut on page and context, and always lifted.
    expect(h.page.route).toHaveBeenCalledWith("**/*", expect.any(Function));
    expect(h.ctx.route).toHaveBeenCalledWith("**/*", expect.any(Function));
    expect(h.page.unroute).toHaveBeenCalledWith("**/*", expect.any(Function));
    expect(h.ctx.unroute).toHaveBeenCalledWith("**/*", expect.any(Function));
  });

  it("unloads the form to about:blank after the screenshot and before lifting the cut", async () => {
    const h = makeHarness(okRun());
    await handleIpkSubmitForm(h.session, h.config, params());
    const blank = h.page.goto.mock.invocationCallOrder[h.page.goto.mock.calls.findIndex((c: any[]) => c[0] === "about:blank")];
    expect(blank).toBeGreaterThan(h.page.screenshot.mock.invocationCallOrder[0]);
    expect(blank).toBeLessThan(h.page.unroute.mock.invocationCallOrder[0]);
    expect(blank).toBeLessThan(h.ctx.unroute.mock.invocationCallOrder[0]);
  });

  it("a route registration that throws still unroutes what was registered", async () => {
    const h = makeHarness(okRun());
    h.ctx.route.mockRejectedValueOnce(new Error("context closed"));
    await handleIpkSubmitForm(h.session, h.config, params()).catch(() => null);
    expect(h.page.route).toHaveBeenCalled();
    expect(h.page.unroute).toHaveBeenCalledWith("**/*", expect.any(Function));
    expect(h.ctx.unroute).not.toHaveBeenCalled();
    expect(h.evaluated).not.toContain("runCheckFormRequest");
  });

  it("the route handler aborts writes and lets reads through", async () => {
    const h = makeHarness(okRun());
    await handleIpkSubmitForm(h.session, h.config, params());
    const onRoute = h.page.route.mock.calls[0][1];
    const mkRoute = (method: string, url: string) => ({
      request: () => ({ method: () => method, url: () => url }),
      abort: vi.fn(async () => undefined),
      fallback: vi.fn(async () => undefined),
    });
    const post = mkRoute("POST", "https://gw.ip-korea.org/Document/document_write.php");
    await onRoute(post);
    expect(post.abort).toHaveBeenCalled();
    expect(post.fallback).not.toHaveBeenCalled();
    const get = mkRoute("GET", "https://gw.ip-korea.org/Document/pr_account_sel.php");
    await onRoute(get);
    expect(get.abort).not.toHaveBeenCalled();
    expect(get.fallback).toHaveBeenCalled();
  });

  it("the form's validation alerts mean would_submit=false and are surfaced", async () => {
    const run = { ...okRun(), alerts: ["insert venue"], pressed: null, submits: [] };
    const h = makeHarness(run);
    const out = parse(await handleIpkSubmitForm(h.session, h.config, params()));
    expect(out.error).toBe(false);
    expect(out.data.saved).toBe(false);
    expect(out.data.would_submit).toBe(false);
    expect(out.data.validation_alerts).toEqual(["insert venue"]);
    expect(out.data.message).toMatch(/insert venue/);
  });

  it("fills the subject with the [Card] prefix", async () => {
    const h = makeHarness(okRun());
    await handleIpkSubmitForm(h.session, h.config, params({ subject: "Google Cloud usage fee" }));
    const fill = h.frame.evaluate.mock.calls.find((c: any[]) => c[1] && typeof c[1] === "object" && "subject" in c[1] && "itemName" in c[1]);
    expect(fill[1].subject).toBe("[Card] Google Cloud usage fee");
  });
});

describe("card_expense_rd with dry_run=true", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the same no-network preview path as draft_only=true, tagged dry_run:true, and never reaches the real submit's popup orchestration", async () => {
    const h = makeHarness(okRun());
    const out = parse(await handleIpkSubmitForm(h.session, h.config, params({ dry_run: true })));

    expect(out.error).toBe(false);
    expect(out.data.dry_run).toBe(true);
    expect(out.data.mode).toBe("preview");
    expect(out.data.saved).toBe(false);
    expect(out.data.docId).toBeNull();

    // Never reached the real-submit popup machinery (page.waitForEvent/once/on("popup")).
    expect(h.page.waitForEvent).not.toHaveBeenCalled();
    expect(h.page.once).not.toHaveBeenCalled();
    expect(h.page.on).not.toHaveBeenCalledWith("popup", expect.anything());

    // Still network-cut, like the ordinary preview (nothing could have been written).
    expect(h.page.route).toHaveBeenCalledWith("**/*", expect.any(Function));
    expect(h.page.unroute).toHaveBeenCalledWith("**/*", expect.any(Function));
  });

  // 2026-10-23: a dry_run looked clean while the same values were blocked on the very
  // next (non-dry_run) call, because dry_run returned via previewCardExpenseRD before
  // checkFieldRulesAgainstForm ever ran. item_desc[] must be "none" (rules/public/AppFrm-021.json,
  // all 28 precedent card-row docs show "none"); simulate the form carrying a non-"none"
  // value there and assert dry_run now surfaces that as a block, not silently.
  it("carries field_rule_result with a block when a rule is violated, before the preview runs", async () => {
    const h = makeHarness(okRun());
    const baseEvaluate = h.frame.evaluate.getMockImplementation()!;
    // previewCardExpenseRD unloads the form to about:blank (page.goto) once it has run
    // (see its own finally block). Make the mocked serialization go empty only AFTER
    // that happens, so this test actually fails if checkFieldRulesRaw is ever moved to
    // run after the preview instead of before it - the exact regression it guards.
    let previewRan = false;
    h.page.goto = vi.fn(async (url: string) => {
      if (url === "about:blank") previewRan = true;
      return null;
    });
    h.frame.evaluate = vi.fn(async (fn: any, arg?: any) => {
      const src = String(fn);
      if (src.includes("knownSet")) {
        return previewRan ? {} : { subject: "[Card] test subject", "item_desc[]": "Kyuwon Shim" };
      }
      return baseEvaluate(fn, arg);
    });

    const out = parse(await handleIpkSubmitForm(h.session, h.config, params({ dry_run: true })));

    expect(out.error).toBe(false);
    expect(out.data.dry_run).toBe(true);
    expect(out.data.field_rule_result).toBeDefined();
    expect(out.data.field_rule_result.blocks.length).toBeGreaterThan(0);
    expect(out.data.field_rule_result.blocks.some((b: any) => b.field === "item_desc[]")).toBe(true);
  });
});

describe("card_expense_rd with draft_only=false is refused outright (CARD_ER_NO_SUBMIT)", () => {
  // org-policy.ts's CARD_ER_NO_SUBMIT rule refuses this before the handler is ever reached,
  // whatever confirm_submit/IPK_ALLOW_SUBMIT are set to - see test/tools/org-policy.test.ts
  // for the policy-layer coverage. These confirm the full handler path agrees.
  const prevAllowSubmit = process.env.IPK_ALLOW_SUBMIT;
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.IPK_ALLOW_SUBMIT = "1";
  });
  afterEach(() => {
    if (prevAllowSubmit === undefined) delete process.env.IPK_ALLOW_SUBMIT;
    else process.env.IPK_ALLOW_SUBMIT = prevAllowSubmit;
  });

  it("refuses draft_only=false even with confirm_submit=true and IPK_ALLOW_SUBMIT=1, nothing touched", async () => {
    const h = makeHarness(okRun());
    const out = parse(await handleIpkSubmitForm(h.session, h.config, params({ draft_only: false, confirm_submit: true })));
    expect(out.error).toBe(true);
    expect(out.message).toMatch(/CARD_ER_NO_SUBMIT/);
    expect(h.page.waitForEvent).not.toHaveBeenCalled();
    expect(h.evaluated).not.toContain("runCheckFormRequest");
  });

  it("never posts form1 by hand", async () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "..", "src", "tools", "ipk-submit.ts"), "utf8");
    const fn = src.slice(src.indexOf("async function submitCardExpenseRD("), src.indexOf("/** What one Check_Form_Request run"));
    expect(fn).not.toMatch(/budget_check_er\.php/);
    expect(fn).not.toMatch(/form\.submit\(\)/);
    // submitCardExpenseRD itself never touches mode1 on the DOM: the authorized [Draft]
    // save does that in setCardErDraftMode1/readCardErMode1 (saveCardExpenseRDDraft).
    expect(fn).not.toMatch(/getElementsByName\(['"]mode1['"]\)/);
    expect(fn).not.toMatch(/readFormMode1/);
  });
});

// ── the in-frame stubs, against a fake page shaped like AppFrm-021 ──

describe("installCardErStubs + runCheckFormRequest (fake page globals)", () => {
  const g = globalThis as any;
  const saved: Record<string, any> = {};
  const KEYS = ["window", "document", "HTMLFormElement", "FormData"];

  function fakePage(checkFormRequest: (w: any) => void) {
    for (const k of KEYS) saved[k] = g[k];
    const sent: string[] = [];
    class FakeForm {
      attrs: Record<string, string> = {};
      entries: [string, string][] = [["subject", "[Card] Google Cloud usage fee"], ["budget_code", "NN2606-0001"]];
      getAttribute(n: string) { return this.attrs[n] ?? null; }
      set action(v: string) { this.attrs.action = v; }
      set target(v: string) { this.attrs.target = v; }
      submit() { sent.push("NETWORK"); }
      requestSubmit() { sent.push("NETWORK"); }
    }
    const form1 = new FakeForm();
    const opened: string[] = [];
    const w: any = {
      open: () => { opened.push("REAL_POPUP"); return null; },
      alert: () => { throw new Error("real alert"); },
      confirm: () => false,
    };
    const jq: any = () => undefined;
    jq.confirm = () => { throw new Error("real modal"); };
    w.jQuery = jq;
    w.$ = jq;
    w.Check_Form_Request = () => checkFormRequest(w);
    g.window = w;
    g.document = { form1, addEventListener: () => undefined };
    g.HTMLFormElement = FakeForm;
    g.FormData = class { constructor(private f: any) {} forEach(cb: (v: string, k: string) => void) { for (const [k, v] of this.f.entries) cb(v, k); } };
    return { w, form1, sent, opened };
  }
  afterEach(() => { for (const k of KEYS) g[k] = saved[k]; });

  // Shape of the page's own handler (extracted JS, 2026-10-08).
  const pageHandler = (w: any) => {
    const doc = g.document;
    w.$.confirm({
      title: "Notice! Evidence Check!",
      buttons: {
        Next: function () {
          w.open("", "budget_frame");
          doc.form1.target = "budget_frame";
          doc.form1.action = "./budget_check_er.php";
          doc.form1.submit();
        },
        Cancel: function () {},
      },
    });
  };

  it("preview: presses Next, captures the submit, sends nothing", () => {
    const p = fakePage(pageHandler);
    installCardErStubs(true);
    const run = runCheckFormRequest();
    expect(run.pressed).toBe("Next");
    expect(run.confirmButtons).toEqual(["Next", "Cancel"]);
    expect(p.sent).toEqual([]);
    expect(p.opened).toEqual([]);
    expect(run.opens).toEqual(["budget_frame"]);
    expect(run.submits).toHaveLength(1);
    expect(run.submits[0].action).toBe("./budget_check_er.php");
    expect(run.submits[0].entries[0]).toEqual(["subject", "[Card] Google Cloud usage fee"]);
    expect(run.pageError).toBeNull();
  });

  it("save mode: presses only the Evidence Check modal, never another $.confirm (review 2026-10-26)", () => {
    let pressed = "";
    fakePage((w) => {
      w.$.confirm({ title: "Request approval?", buttons: { Request: () => { pressed = "request"; }, Cancel: () => {} } });
    });
    installCardErStubs(false);
    const run = runCheckFormRequest();
    expect(pressed).toBe("");
    expect(run.pressed).toBeNull();
    expect(run.confirmButtons).toEqual(["Request", "Cancel"]);
  });

  it("save mode: still presses Next on the Evidence Check modal", () => {
    const p = fakePage(pageHandler);
    installCardErStubs(false);
    const run = runCheckFormRequest();
    expect(run.pressed).toBe("Next");
    expect(p.opened).toEqual(["REAL_POPUP"]);
  });

  it("preview: validation alerts are recorded and nothing is submitted", () => {
    fakePage((w) => { w.alert("insert venue"); });
    installCardErStubs(true);
    const run = runCheckFormRequest();
    expect(run.alerts).toEqual(["insert venue"]);
    expect(run.submits).toEqual([]);
    expect(run.pressed).toBeNull();
  });

  it("presses an {text, action} button and skips Cancel", () => {
    let pressed = "";
    fakePage((w) => {
      w.$.confirm({ buttons: { cancel: { text: "Cancel", action: () => { pressed = "cancel"; } }, ok: { text: "Next", action: () => { pressed = "next"; } } } });
    });
    installCardErStubs(true);
    const run = runCheckFormRequest();
    expect(pressed).toBe("next");
    expect(run.pressed).toBe("Next");
  });

  it("submit mode: answers the modal but leaves submit and window.open to the page", () => {
    const p = fakePage(pageHandler);
    installCardErStubs(false);
    const run = runCheckFormRequest();
    expect(run.pressed).toBe("Next");
    expect(p.sent).toEqual(["NETWORK"]);
    expect(p.opened).toEqual(["REAL_POPUP"]);
    expect(run.submits).toEqual([]);
  });

  it("a page without Check_Form_Request is reported, not thrown", () => {
    const p = fakePage(pageHandler);
    delete p.w.Check_Form_Request;
    installCardErStubs(true);
    const run = runCheckFormRequest();
    expect(run.pageError).toMatch(/Check_Form_Request/);
    expect(run.submits).toEqual([]);
  });
});

describe("budgetPopupRefusals", () => {
  it("finds the live 'not enough budget' wording and its variants", () => {
    expect(budgetPopupRefusals("Budget check\nNot enough budget.\nClose")).toEqual(["Not enough budget."]);
    expect(budgetPopupRefusals("Insufficient budget for NN2606-0001")).toEqual(["Insufficient budget for NN2606-0001"]);
    expect(budgetPopupRefusals("The amount exceeds the budget")).toHaveLength(1);
  });
  it("passes a normal budget check page", () => {
    expect(budgetPopupRefusals("Budget check\nBudget: 1,000,000\nRemaining: 500,000\n[ Submit ]")).toEqual([]);
    expect(budgetPopupRefusals("")).toEqual([]);
  });
});

describe("isMeetingAccount", () => {
  it("treats Team Activities 412107 and the other picker meeting codes as meetings", () => {
    for (const c of ["412107", "420421", "420420", "410310"]) expect(isMeetingAccount(c)).toBe(true);
  });
  it("does not treat IT subscriptions or empty as meetings", () => {
    for (const c of ["410318", "", null, undefined]) expect(isMeetingAccount(c as any)).toBe(false);
  });
});

describe("isOvertimeAccount", () => {
  it("treats Overtime Meals 412103 as overtime", () => {
    expect(isOvertimeAccount("412103")).toBe(true);
  });
  it("does not treat other accounts or empty as overtime", () => {
    for (const c of ["410318", "412107", "", null, undefined]) expect(isOvertimeAccount(c as any)).toBe(false);
  });
});


// ── allow_card_er_save: one-time per-transaction authorization ─────

describe("card_expense_rd allow_card_er_save needs a one-time authorization", () => {
  const prevHome = process.env.IPK_HOME_DIR;
  let home: string;
  let authFile: string;
  const DOC = "302200";
  const fixture302098 = fs.readFileSync(
    path.join(__dirname, "..", "fixtures", "card-er-location", "document-view-302098-submitted.rawtext.txt"),
    "utf8"
  );
  const writeAuth = (entries: Record<string, unknown>) => {
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, JSON.stringify(entries));
  };
  const authFor = (trseq = "26040417102") => ({ "19984403": { trseq, authorized_at: "2026-10-26T10:00:00+09:00", note: "test" } });
  const readAuth = () => JSON.parse(fs.readFileSync(authFile, "utf8"));

  beforeEach(() => {
    vi.clearAllMocks();
    // Never the real ~/.config: a real authorization must not be consumable by a test.
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ipk-card-er-home-"));
    process.env.IPK_HOME_DIR = home;
    authFile = path.join(home, ".config", "ipk-browser-mcp", "card-er-draft-authorizations.json");
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.IPK_HOME_DIR;
    else process.env.IPK_HOME_DIR = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  /**
   * The harness for a real [Draft] save: mode1 helpers, a budget popup, and - once
   * submit_form() was called - a frame on document_view and document lists.
   */
  function saveHarness(opts: {
    run?: Run;
    mode1AtSet?: string[];
    mode1AtPopup?: string[];
    viewText?: string;
    lists?: Record<string, string>;
  } = {}) {
    const pop = makePopup();
    const h = makeHarness(opts.run ?? okRun(), async () => pop);
    let saved = false;
    pop.evaluate = vi.fn(async (fn: any) => {
      if (fn === "submit_form()") { saved = true; return undefined; }
      return typeof fn === "function" ? "Budget check\nRemaining: 500,000" : undefined;
    });
    h.frame.url = vi.fn(() => saved
      ? `https://gw.ip-korea.org/Document/document_view.php?doc_id=${DOC}&approve_type=AppFrm-021`
      : "https://gw.ip-korea.org/Document/document_write.php?approve_type=AppFrm-021&mker=Y");
    const baseEvaluate = h.frame.evaluate.getMockImplementation()!;
    h.frame.evaluate = vi.fn(async (fn: any, arg?: any) => {
      const name = typeof fn === "function" ? fn.name : String(fn);
      if (name === "setCardErDraftMode1") { h.evaluated.push(name); return opts.mode1AtSet ?? ["draft"]; }
      if (name === "readCardErMode1") { h.evaluated.push(name); return opts.mode1AtPopup ?? ["draft"]; }
      if (saved && String(fn).includes("innerText")) return opts.viewText ?? "Approval > Drafts\nR&D Expense Request (ER)\n[ Edit ] [ Delete ]";
      return baseEvaluate(fn, arg);
    });
    let lastUrl = "";
    h.page.goto = vi.fn(async (url: string) => { lastUrl = url; return null; });
    h.page.content = vi.fn(async () => {
      const type = (lastUrl.match(/type=(\w+)/) || [])[1] ?? "";
      return (opts.lists ?? {})[type] ?? "<table></table>";
    });
    return { ...h, pop, isSaved: () => saved };
  }

  it("refuses without an authorization file, naming the file and doc 302098, nothing clicked", async () => {
    const h = saveHarness();
    const out = parse(await handleIpkSubmitForm(h.session, h.config, params({ allow_card_er_save: true })));
    expect(out.error).toBe(true);
    expect(out.code).toBe("CARD_ER_SAVE_REFUSED");
    expect(out.message).toMatch(/card-er-draft-authorizations\.json/);
    expect(out.message).toMatch(/302098/);
    expect(out.message).toMatch(/dry_run/);
    expect(out.message).toMatch(/Nothing was saved/);
    expect(h.page.waitForEvent).not.toHaveBeenCalled();
    expect(h.evaluated).not.toContain("runCheckFormRequest");
    expect(h.evaluated).not.toContain("setCardErDraftMode1");
  });

  it("refuses when the authorization's trseq does not match, and leaves it in place", async () => {
    writeAuth(authFor("26040417999"));
    const h = saveHarness();
    const out = parse(await handleIpkSubmitForm(h.session, h.config, params({ allow_card_er_save: true })));
    expect(out.code).toBe("CARD_ER_SAVE_REFUSED");
    expect(h.evaluated).not.toContain("runCheckFormRequest");
    expect(readAuth()).toEqual(authFor("26040417999"));
  });

  it("is not unlocked by any env variable", async () => {
    const prev = process.env.IPK_CARD_ER_DRAFT_VERIFIED;
    process.env.IPK_CARD_ER_DRAFT_VERIFIED = "1"; // the old opt-in, meaningless
    try {
      const h = saveHarness();
      const out = parse(await handleIpkSubmitForm(h.session, h.config, params({ allow_card_er_save: true })));
      expect(out.code).toBe("CARD_ER_SAVE_REFUSED");
      expect(h.page.waitForEvent).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.IPK_CARD_ER_DRAFT_VERIFIED;
      else process.env.IPK_CARD_ER_DRAFT_VERIFIED = prev;
    }
  });

  it("an authorization does not unlock draft_only=false (CARD_ER_NO_SUBMIT) and is not consumed by it", async () => {
    writeAuth(authFor());
    const prev = process.env.IPK_ALLOW_SUBMIT;
    process.env.IPK_ALLOW_SUBMIT = "1";
    try {
      const h = saveHarness();
      const out = parse(await handleIpkSubmitForm(h.session, h.config, params({ allow_card_er_save: true, draft_only: false, confirm_submit: true })));
      expect(out.error).toBe(true);
      expect(out.message).toMatch(/CARD_ER_NO_SUBMIT/);
      expect(h.evaluated).not.toContain("runCheckFormRequest");
      expect(readAuth()).toEqual(authFor());
    } finally {
      if (prev === undefined) delete process.env.IPK_ALLOW_SUBMIT;
      else process.env.IPK_ALLOW_SUBMIT = prev;
    }
  });

  it("with an authorization: consumes it, sets mode1='draft' before Check_Form_Request, and reports DRAFT_SAVED when the doc is in Drafts", async () => {
    writeAuth(authFor());
    const h = saveHarness({ lists: { drafts: `<a href="document_view.php?doc_id=${DOC}&approve_type=AppFrm-021">x</a>` } });
    const out = parse(await handleIpkSubmitForm(h.session, h.config, params({ allow_card_er_save: true })));

    expect(out.error).toBe(false);
    expect(out.data.outcome).toBe("DRAFT_SAVED");
    expect(out.data.docId).toBe(DOC);
    expect(out.data.found_in).toEqual(["drafts"]);
    expect(readAuth()).toEqual({});

    // The page's own submit/window.open (stubs in non-preview mode), mode1 set first,
    // re-read right before submit_form().
    expect(h.stubInstalls).toEqual([false]);
    const order = h.evaluated.filter((n) => ["setCardErDraftMode1", "runCheckFormRequest", "readCardErMode1"].includes(n));
    expect(order).toEqual(["setCardErDraftMode1", "runCheckFormRequest", "readCardErMode1"]);
    expect(h.pop.evaluate).toHaveBeenCalledWith("submit_form()");
    // No network cut on this path.
    expect(h.page.route).not.toHaveBeenCalled();
    // document_view was read for the saved doc.
    expect(h.frame.goto).toHaveBeenCalledWith(
      `https://gw.ip-korea.org/Document/document_view.php?doc_id=${DOC}&approve_type=AppFrm-021`,
      expect.anything()
    );
  });

  it("a second call with the same (consumed) authorization is refused", async () => {
    writeAuth(authFor());
    const h1 = saveHarness({ lists: { drafts: `doc_id=${DOC}` } });
    await handleIpkSubmitForm(h1.session, h1.config, params({ allow_card_er_save: true }));
    const h2 = saveHarness();
    const out = parse(await handleIpkSubmitForm(h2.session, h2.config, params({ allow_card_er_save: true })));
    expect(out.code).toBe("CARD_ER_SAVE_REFUSED");
    expect(h2.evaluated).not.toContain("runCheckFormRequest");
  });

  it("the authorization is consumed before the click: a failing Check_Form_Request still leaves it consumed", async () => {
    writeAuth(authFor());
    const h = saveHarness({ run: { ...okRun(), pressed: null, pageError: "Check_Form_Request is not defined on this page" } });
    const out = parse(await handleIpkSubmitForm(h.session, h.config, params({ allow_card_er_save: true })));
    expect(out.error).toBe(true);
    expect(out.code).toBe("SUBMIT_FAILED");
    expect(out.message).toMatch(/consumed/);
    expect(readAuth()).toEqual({});
    expect(h.pop.evaluate).not.toHaveBeenCalledWith("submit_form()");
  });

  it("mode1 that cannot be set to exactly one 'draft' stops before Check_Form_Request", async () => {
    writeAuth(authFor());
    const h = saveHarness({ mode1AtSet: ["", ""] });
    const out = parse(await handleIpkSubmitForm(h.session, h.config, params({ allow_card_er_save: true })));
    expect(out.code).toBe("DRAFT_MODE_NOT_SET");
    expect(out.message).toMatch(/Nothing was filed/);
    expect(h.evaluated).not.toContain("runCheckFormRequest");
    expect(h.page.waitForEvent).toHaveBeenCalledTimes(0);
  });

  it("mode1 guard before submit_form(): a mode1 that is no longer 'draft' closes the popup, submit_form() never called", async () => {
    writeAuth(authFor());
    const h = saveHarness({ mode1AtPopup: [""] });
    const out = parse(await handleIpkSubmitForm(h.session, h.config, params({ allow_card_er_save: true })));
    expect(out.error).toBe(true);
    expect(out.code).toBe("DRAFT_MODE_NOT_SET");
    expect(out.message).toMatch(/Nothing was filed/);
    expect(h.pop.evaluate).not.toHaveBeenCalledWith("submit_form()");
    expect(h.pop.close).toHaveBeenCalled();
    expect(h.isSaved()).toBe(false);
  });

  it("a budget refusal in the popup closes it without submit_form()", async () => {
    writeAuth(authFor());
    const h = saveHarness();
    h.pop.evaluate = vi.fn(async (fn: any) => (typeof fn === "function" ? "Budget check\nNot enough budget." : undefined));
    const out = parse(await handleIpkSubmitForm(h.session, h.config, params({ allow_card_er_save: true })));
    expect(out.code).toBe("BUDGET_CHECK_REFUSED");
    expect(h.pop.evaluate).not.toHaveBeenCalledWith("submit_form()");
  });

  it("SUBMITTED_NOT_DRAFT when document_view looks like doc 302098 (filed for approval) - no retry, no repossess", async () => {
    writeAuth(authFor());
    const h = saveHarness({ viewText: fixture302098, lists: { drafts: `doc_id=${DOC}` } });
    const out = parse(await handleIpkSubmitForm(h.session, h.config, params({ allow_card_er_save: true })));
    expect(out.error).toBe(true);
    expect(out.code).toBe("SUBMITTED_NOT_DRAFT");
    expect(out.docId).toBe(DOC);
    expect(out.submitted_markers).toEqual(["Approval > Progress", "Document Repossess"]);
    expect(out.message).toMatch(/FILED FOR APPROVAL/);
    expect(out.message).not.toMatch(/nothing (was )?filed/i);
    expect(h.pop.evaluate.mock.calls.filter((c: any[]) => c[0] === "submit_form()")).toHaveLength(1);
    // Never looked at the lists to second-guess the markers.
    expect(h.page.goto).not.toHaveBeenCalledWith(expect.stringContaining("document_list.php"), expect.anything());
  });

  it("DRAFT_NOT_CONFIRMED (may have been filed) when the doc is in neither list", async () => {
    writeAuth(authFor());
    const h = saveHarness();
    const out = parse(await handleIpkSubmitForm(h.session, h.config, params({ allow_card_er_save: true })));
    expect(out.error).toBe(true);
    expect(out.code).toBe("DRAFT_NOT_CONFIRMED");
    expect(out.docId).toBe(DOC);
    expect(out.message).toMatch(/may have been filed/);
    expect(h.page.goto).toHaveBeenCalledWith(expect.stringContaining("document_list.php?type=drafts"), expect.anything());
    expect(h.page.goto).toHaveBeenCalledWith(expect.stringContaining("document_list.php?type=myapprove"), expect.anything());
  });

  it("DRAFT_SAVED via the drafter's-turn list (type=myapprove)", async () => {
    writeAuth(authFor());
    const h = saveHarness({ lists: { myapprove: `onclick="view('doc_id=${DOC}')"` } });
    const out = parse(await handleIpkSubmitForm(h.session, h.config, params({ allow_card_er_save: true })));
    expect(out.data.outcome).toBe("DRAFT_SAVED");
    expect(out.data.found_in).toEqual(["myapprove"]);
  });

  it("an unreadable document_view after submit_form() is DRAFT_NOT_CONFIRMED, never 'nothing filed'", async () => {
    writeAuth(authFor());
    const h = saveHarness({ viewText: "", lists: { drafts: `doc_id=${DOC}` } });
    const out = parse(await handleIpkSubmitForm(h.session, h.config, params({ allow_card_er_save: true })));
    expect(out.code).toBe("DRAFT_NOT_CONFIRMED");
    expect(out.message).toMatch(/may have been filed/);
    expect(out.message).not.toMatch(/nothing (was )?filed/i);
  });

  it("without allow_card_er_save, draft_only=true is still the ordinary no-save preview and an authorization is untouched", async () => {
    writeAuth(authFor());
    const h = makeHarness(okRun());
    const out = parse(await handleIpkSubmitForm(h.session, h.config, params()));
    expect(out.error).toBe(false);
    expect(out.data.mode).toBe("preview");
    expect(readAuth()).toEqual(authFor());
  });

  it("dry_run with allow_card_er_save stays a preview and does not consume the authorization", async () => {
    writeAuth(authFor());
    const h = makeHarness(okRun());
    const out = parse(await handleIpkSubmitForm(h.session, h.config, params({ dry_run: true, allow_card_er_save: true })));
    expect(out.error).toBe(false);
    expect(out.data.dry_run).toBe(true);
    expect(readAuth()).toEqual(authFor());
  });
});

describe("isOverseasItSubscription (VAT 0 - rules/public/AppFrm-021.json conditional)", () => {
  it("matches the overseas IT vendors the rulebook names", () => {
    for (const n of ["claude ai_max", "RunPod GPU Compute Credits (2026-10-16)", "Google Cloud Gemini API", "ChatGPT Plus"]) {
      expect(isOverseasItSubscription(n)).toBe(true);
    }
  });
  it("does not match domestic or other items", () => {
    for (const n of ["Kyuwon Shim", "Microsoft 365", "FedEx shipping", ""]) {
      expect(isOverseasItSubscription(n)).toBe(false);
    }
  });
});

describe("budget popup identity (review 2026-10-26)", () => {
  it("a popup that is not budget_check_er is closed and never filed from", async () => {
    const src = (await import("node:fs")).readFileSync(new URL("../../src/tools/ipk-submit.ts", import.meta.url), "utf-8");
    const i = src.indexOf("budget_check_er/i.test(String(pop.url()))");
    const j = src.indexOf('await pop.evaluate("submit_form()")');
    expect(i).toBeGreaterThan(0);
    expect(j).toBeGreaterThan(i);
  });
});
