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
});

describe("card_expense_rd submit path goes through Check_Form_Request", () => {
  // NO_FINAL_SUBMIT (src/policy/org-policy.ts): a real submission (draft_only=false) is
  // refused unless IPK_ALLOW_SUBMIT=1 is also set. card_expense_rd has no draft state, so
  // this is the one form type whose "submit" path these tests exercise directly.
  const prevAllowSubmit = process.env.IPK_ALLOW_SUBMIT;
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.IPK_ALLOW_SUBMIT = "1";
  });
  afterEach(() => {
    if (prevAllowSubmit === undefined) delete process.env.IPK_ALLOW_SUBMIT;
    else process.env.IPK_ALLOW_SUBMIT = prevAllowSubmit;
  });

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

// ── allow_card_er_save + first_live_save (plan v6 P0-pre item 3/v6.1) ──────

describe("card_expense_rd draft_only=true real-save gate", () => {
  const prevAllowSubmit = process.env.IPK_ALLOW_SUBMIT;
  const prevCardErSave = process.env.IPK_CARD_ER_SAVE;
  const prevHome = process.env.HOME;
  let tmpHome: string;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.IPK_ALLOW_SUBMIT; // draft_only stays true throughout this block
    delete process.env.IPK_CARD_ER_SAVE;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ipk-card-er-save-home-"));
    process.env.HOME = tmpHome; // never write the real cache dir from a test
  });
  afterEach(() => {
    if (prevAllowSubmit === undefined) delete process.env.IPK_ALLOW_SUBMIT; else process.env.IPK_ALLOW_SUBMIT = prevAllowSubmit;
    if (prevCardErSave === undefined) delete process.env.IPK_CARD_ER_SAVE; else process.env.IPK_CARD_ER_SAVE = prevCardErSave;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("first_live_save without allow_card_er_save -> refused, nothing saved", async () => {
    const h = makeHarness(okRun());
    const out = parse(await handleIpkSubmitForm(h.session, h.config, params({ first_live_save: true })));
    expect(out.error).toBe(false); // no allow_card_er_save: ordinary preview, not a refusal
    expect(out.data.mode).toBe("preview");
    expect(h.page.waitForEvent).not.toHaveBeenCalled(); // never reached the real-submit machinery
  });

  it("allow_card_er_save alone (no first_live_save) -> CARD_ER_SAVE_NO_FIXTURE_YET, nothing saved", async () => {
    const h = makeHarness(okRun());
    const out = parse(await handleIpkSubmitForm(h.session, h.config, params({ allow_card_er_save: true })));
    expect(out.error).toBe(true);
    expect(out.code).toBe("CARD_ER_SAVE_NO_FIXTURE_YET");
    expect(h.page.waitForEvent).not.toHaveBeenCalled();
  });

  it("IPK_CARD_ER_SAVE=0 refuses even with both flags set, nothing saved", async () => {
    process.env.IPK_CARD_ER_SAVE = "0";
    const h = makeHarness(okRun());
    const out = parse(await handleIpkSubmitForm(h.session, h.config, params({ allow_card_er_save: true, first_live_save: true })));
    expect(out.error).toBe(true);
    expect(out.code).toBe("CARD_ER_SAVE_DISABLED");
    expect(h.page.waitForEvent).not.toHaveBeenCalled();
  });

  /** Both flags set: the harness is wired so frame.evaluate's innerText-matching calls
   *  return `documentViewText` before frame.goto("...type=appr") runs and `waitingListText`
   *  after - mirroring the real call order (read document_view, then navigate, then read
   *  the waiting list). doc_id is read from frame.url(), overridden per test. */
  function harnessForRealSave(docId: string | null, documentViewText: string, waitingListIds: string[] | null) {
    const h = makeHarness(okRun(), async () => makePopup());
    h.session.getUserInfo = () => ({ name: "Kyuwon Shim" }); // matches the fixtures' drafter name
    h.frame.url = vi.fn(() => docId ? `https://gw.ip-korea.org/Document/document_view.php?doc_id=${docId}` : "https://gw.ip-korea.org/Document/document_write.php");
    let navigated = false;
    h.page.goto = vi.fn(async (url: string) => { if (String(url).includes("type=appr")) navigated = true; return null; });
    const baseEvaluate = h.frame.evaluate.getMockImplementation()!;
    h.frame.evaluate = vi.fn(async (fn: any, arg?: any) => {
      const src = String(fn);
      if (src.includes("innerText")) return navigated ? "" : documentViewText;
      if (src.includes("a[href*=")) {
        if (waitingListIds === null) throw new Error("list unreadable");
        return waitingListIds;
      }
      return baseEvaluate(fn, arg);
    });
    return h;
  }

  const SYNTHETIC_POSITIVE_TEXT = fs.readFileSync(
    path.join(__dirname, "..", "fixtures", "card-er-location", "document-view-synthetic-positive.rawtext.txt"), "utf8"
  );
  const NEGATIVE_TEXT = fs.readFileSync(
    path.join(__dirname, "..", "fixtures", "card-er-location", "document-view-301323-negative.rawtext.txt"), "utf8"
  );

  it("[SYNTHETIC fixture] AT_DRAFTER_TURN: doc in the waiting list + own action pending -> success, 'press [Approve]' wording, action draft_save", async () => {
    const h = harnessForRealSave("301999", SYNTHETIC_POSITIVE_TEXT, ["301999"]);
    const out = parse(await handleIpkSubmitForm(h.session, h.config, params({ allow_card_er_save: true, first_live_save: true })));
    expect(out.error).toBe(false);
    expect(out.data.outcome).toBe("AT_DRAFTER_TURN");
    expect(out.data.message).toMatch(/press \[Approve\]/);
    expect(out.data.docId).toBe("301999");
    // cache written outside the repo, under the overridden HOME
    const cacheDir = path.join(tmpHome, ".cache", "ipk-mcp", "card-er-location", "301999");
    expect(fs.existsSync(path.join(cacheDir, "document_view.rawtext.txt"))).toBe(true);
    expect(fs.existsSync(path.join(cacheDir, "waiting_list.rawtext.txt"))).toBe(true);
    expect(fs.readFileSync(path.join(cacheDir, "document_view.rawtext.txt"), "utf8")).toBe(SYNTHETIC_POSITIVE_TEXT);
  });

  it("[REAL fixture: 301323] DRAFT_WENT_TO_APPROVAL: not in waiting list + past-drafter approval line -> error, repossess steps", async () => {
    const h = harnessForRealSave("301323", NEGATIVE_TEXT, []);
    const out = parse(await handleIpkSubmitForm(h.session, h.config, params({ allow_card_er_save: true, first_live_save: true })));
    expect(out.error).toBe(true);
    expect(out.code).toBe("DRAFT_WENT_TO_APPROVAL");
    expect(out.message).toMatch(/Document Repossess/);
  });

  it("unreadable waiting list -> DRAFT_NOT_CONFIRMED, never a silent success", async () => {
    const h = harnessForRealSave("301999", SYNTHETIC_POSITIVE_TEXT, null);
    const out = parse(await handleIpkSubmitForm(h.session, h.config, params({ allow_card_er_save: true, first_live_save: true })));
    expect(out.error).toBe(true);
    expect(out.code).toBe("DRAFT_NOT_CONFIRMED");
  });

  it("no doc_id in the final URL -> DRAFT_NOT_CONFIRMED without ever reading the location", async () => {
    const h = harnessForRealSave(null, SYNTHETIC_POSITIVE_TEXT, ["301999"]);
    const out = parse(await handleIpkSubmitForm(h.session, h.config, params({ allow_card_er_save: true, first_live_save: true })));
    expect(out.error).toBe(true);
    expect(out.code).toBe("DRAFT_NOT_CONFIRMED");
    expect(h.page.goto).not.toHaveBeenCalledWith(expect.stringContaining("type=appr"));
  });

  it("the real-save path does call the request branch's popup/submit machinery (unlike the ordinary preview)", async () => {
    const h = harnessForRealSave("301999", SYNTHETIC_POSITIVE_TEXT, ["301999"]);
    await handleIpkSubmitForm(h.session, h.config, params({ allow_card_er_save: true, first_live_save: true }));
    expect(h.page.waitForEvent).toHaveBeenCalledWith("popup", expect.objectContaining({ timeout: 25000 }));
    expect(h.evaluated).toContain("runCheckFormRequest");
  });

  // A: if the location-check post-processing throws AFTER the form's own submit click
  // already ran (so the document may well have been filed), the outer SUBMIT_ERROR catch
  // must not lose the doc_id or the repossess hint - a bare "something broke" message
  // after a click that may have filed the document is exactly the wrong failure mode.
  it("a throw inside the post-save location check still returns doc_id and the repossess hint, not a bare SUBMIT_ERROR", async () => {
    const h = harnessForRealSave("301999", SYNTHETIC_POSITIVE_TEXT, ["301999"]);
    h.session.getUserInfo = () => { throw new Error("boom: profile lookup failed"); };
    const out = parse(await handleIpkSubmitForm(h.session, h.config, params({ allow_card_er_save: true, first_live_save: true })));
    expect(out.error).toBe(true);
    expect(out.docId).toBe("301999");
    expect(out.message).toMatch(/Document Repossess/i);
  });
});
