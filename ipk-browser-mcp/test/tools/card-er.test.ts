/**
 * card_expense_rd (AppFrm-021, mker=Y) has no draft: the server files mode1='draft' for
 * approval (doc 301323, 2026-10-08). draft_only=true must be a preview that runs the
 * form's own Check_Form_Request with nothing able to leave the browser, and the submit
 * path must also go through Check_Form_Request.
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
import { normalizeCardSubject, isPreviewBlockedRequest, summarizeCapturedForm, isMeetingAccount, budgetPopupRefusals } from "../../src/forms/card-er.js";

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
    expect(out.data.message).toMatch(/cannot be saved as a draft/);
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

describe("card_expense_rd submit path goes through Check_Form_Request", () => {
  beforeEach(() => vi.clearAllMocks());

  it("stubs only $.confirm (no capture) and stops on the form's alerts", async () => {
    const run = { ...okRun(), alerts: ["Please insert meeting time"], pressed: null, submits: [] };
    const h = makeHarness(run);
    const out = parse(await handleIpkSubmitForm(h.session, h.config, params({ draft_only: false, confirm_submit: true })));
    expect(out.error).toBe(true);
    expect(out.code).toBe("SUBMIT_REJECTED");
    expect(out.validation_alerts).toEqual(["Please insert meeting time"]);
    expect(h.stubInstalls).toEqual([false]);
    expect(h.evaluated).toContain("runCheckFormRequest");
    expect(h.page.route).not.toHaveBeenCalled();
    // no free-standing popup listener; the context dialog watcher is removed
    expect(h.page.once).not.toHaveBeenCalled();
    expect(h.page.on).not.toHaveBeenCalledWith("popup", expect.anything());
    expect(h.page.waitForEvent).toHaveBeenCalledWith("popup", expect.objectContaining({ timeout: 25000 }));
    const watcher = h.ctx.on.mock.calls.find((c: any[]) => c[0] === "page")?.[1];
    expect(watcher).toBeTypeOf("function");
    expect(h.ctx.off).toHaveBeenCalledWith("page", watcher);
  });

  it("a popup that arrives after the tool returned is never filed", async () => {
    let deliver: (p: any) => void = () => {};
    const late = new Promise<any>((resolve) => { deliver = resolve; });
    const run = { ...okRun(), alerts: ["Please insert meeting time"], pressed: null, submits: [] };
    const h = makeHarness(run, () => late);
    const out = parse(await handleIpkSubmitForm(h.session, h.config, params({ draft_only: false, confirm_submit: true })));
    expect(out.code).toBe("SUBMIT_REJECTED");
    const pop = makePopup();
    deliver(pop);
    await new Promise((r) => setTimeout(r, 20));
    expect(pop.evaluate).not.toHaveBeenCalledWith("submit_form()");
    expect(pop.waitForLoadState).not.toHaveBeenCalled();
  });

  it("a popup wait that times out files nothing", async () => {
    const h = makeHarness(okRun());
    const out = parse(await handleIpkSubmitForm(h.session, h.config, params({ draft_only: false, confirm_submit: true })));
    expect(out.error).toBe(false);
    expect(out.data.success).toBe(false);
    expect(out.data.message).toMatch(/never filed the form/);
    expect(h.ctx.off).toHaveBeenCalledWith("page", expect.any(Function));
  });

  it("a clean budget check popup gets submit_form()", async () => {
    const pop = makePopup("Budget check\nRemaining: 1,000,000");
    const h = makeHarness(okRun(), async () => pop);
    const out = parse(await handleIpkSubmitForm(h.session, h.config, params({ draft_only: false, confirm_submit: true })));
    expect(pop.on).toHaveBeenCalledWith("dialog", expect.any(Function));
    expect(pop.evaluate).toHaveBeenCalledWith("submit_form()");
    expect(pop.close).not.toHaveBeenCalled();
    expect(out.code).not.toBe("BUDGET_CHECK_REFUSED");
  });

  it("'not enough budget' in the popup is refused: no submit_form(), popup closed, message returned", async () => {
    const pop = makePopup("Budget check\nThere is not enough budget for this item.\n[ Close ]");
    const h = makeHarness(okRun(), async () => pop);
    const out = parse(await handleIpkSubmitForm(h.session, h.config, params({ draft_only: false, confirm_submit: true })));
    expect(out.error).toBe(true);
    expect(out.code).toBe("BUDGET_CHECK_REFUSED");
    expect(out.budget_check_messages).toEqual(["There is not enough budget for this item."]);
    expect(pop.evaluate).not.toHaveBeenCalledWith("submit_form()");
    expect(pop.close).toHaveBeenCalled();
  });

  it("a native dialog on the popup is refused, dismissed, and its message returned", async () => {
    const pop = makePopup("Budget check", ["Budget code is closed."]);
    const h = makeHarness(okRun(), async () => pop);
    const out = parse(await handleIpkSubmitForm(h.session, h.config, params({ draft_only: false, confirm_submit: true })));
    expect(out.code).toBe("BUDGET_CHECK_REFUSED");
    expect(out.budget_check_messages).toEqual(["Budget code is closed."]);
    expect(pop.dismissed).toEqual(["Budget code is closed."]);
    expect(pop.evaluate).not.toHaveBeenCalledWith("submit_form()");
    expect(pop.close).toHaveBeenCalled();
  });

  it("the context page watcher catches dialogs on a page before the popup event resolves", async () => {
    const pop = makePopup("Budget check");
    const h = makeHarness(okRun(), async () => {
      // the context sees the page first; the dialog fires before waitForEvent resolves
      const watcher = h.ctx.on.mock.calls.find((c: any[]) => c[0] === "page")![1];
      watcher(pop);
      pop.fire("dialog", "Early alert");
      return pop;
    });
    const out = parse(await handleIpkSubmitForm(h.session, h.config, params({ draft_only: false, confirm_submit: true })));
    expect(out.code).toBe("BUDGET_CHECK_REFUSED");
    expect(out.budget_check_messages).toEqual(["Early alert"]);
    expect(pop.evaluate).not.toHaveBeenCalledWith("submit_form()");
  });

  it("never posts form1 by hand", async () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "..", "src", "tools", "ipk-submit.ts"), "utf8");
    const fn = src.slice(src.indexOf("async function submitCardExpenseRD("), src.indexOf("/** What one Check_Form_Request run"));
    expect(fn).not.toMatch(/budget_check_er\.php/);
    expect(fn).not.toMatch(/form\.submit\(\)/);
    expect(fn).not.toMatch(/mode1/);
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
