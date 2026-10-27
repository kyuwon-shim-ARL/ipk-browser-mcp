/**
 * ipk_card_er_fix_vat: corrects VAT/excl. VAT on one existing overseas-IT card ER draft
 * through the Edit page's own [ Save ] (fn_Edit_Check('update','drafts'), mode1='drafts'),
 * behind a one-time "doc:<doc_id>" authorization. Page facts from the 2026-10-26 read-only
 * inspection of drafts 302242-302244.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

const attachFilesSpy = vi.hoisted(() => vi.fn());
vi.mock("../../src/security/attachment-path.js", async (orig) => ({
  ...(await orig<typeof import("../../src/security/attachment-path.js")>()),
  validateAttachmentPath: () => null,
}));
vi.mock("../../src/internal/primitives/attachment.js", () => ({ attachFiles: attachFilesSpy }));

import { handleIpkCardErFixVat, runEditSaveFlow } from "../../src/tools/ipk-card-er-fix-vat.js";
import { EVIDENCE_DIR } from "../../src/security/attachment-path.js";

const DOC = "302242";
const ROW_BEFORE = "IT Software (IT Subscription)\tclaude ai_max\t1\t247,394\t0\t272,133\tN/N\t-01\tANTHROPIC* CLAUDE SUB\t-";
const ROW_AFTER = "IT Software (IT Subscription)\tclaude ai_max\t1\t272,133\t0\t272,133\tN/N\t-01\tANTHROPIC* CLAUDE SUB\t-";
const FILE_NAMES = ["261019_Claude_CC_sales_slip.pdf", "261019_Claude-invoice.pdf"];
const SIGNED = "261019_Claude-invoice_signed.pdf";
const fileList = (names: string[]) => `File Attachment List\t${names.map((n) => `${n} [34195Bytes] [Delete]`).join("\n")}\n`;
const DRAFTS_HEAD = "\tApproval > Drafts\n[ Edit Approval Line ] [ Edit ] [ Document List] [ Print ]";
const view = (row: string, head = DRAFTS_HEAD, files: string[] = FILE_NAMES) =>
  `${head}\nR&D Expense Request (ER)\nNo\tDate of\n1\t2026-10-19\t[410318]\n${row}\nTotal\t\n272,133 KRW\n\n${fileList(files)}\nOpinion of approval\t`;
const EDIT_HREF = `./document_write.php?start_page=&type=drafts&approve_type=AppFrm-021&doc_id=${DOC}&proxy_id=`;
const LIST_WITH_DOC = `<a href="document_view.php?doc_id=${DOC}&approve_type=AppFrm-021&type=drafts">x</a>`;

const okRun = () => ({
  alerts: [], confirms: [], confirmButtons: ["Next", "Cancel"], pressed: "Next", opens: ["budget_frame"],
  submits: [], jquery: true, pageError: null,
});

interface Opts {
  viewBefore?: string;
  viewAfter?: string;
  listBefore?: string;
  listAfter?: string;
  state?: Record<string, unknown>;
  filled?: Record<string, string>;
  mode1AtSet?: string[];
  mode1AtPopup?: string[];
  run?: ReturnType<typeof okRun>;
}

function harness(o: Opts = {}) {
  const evaluated: string[] = [];
  const mode1Args: unknown[] = [];
  let saved = false;
  const pop: any = {
    url: () => "https://gw.ip-korea.org/Document/budget_check_er.php",
    on: vi.fn(),
    waitForLoadState: vi.fn(async () => undefined),
    waitForTimeout: vi.fn(async () => undefined),
    evaluate: vi.fn(async (fn: any) => {
      if (fn === "submit_form()") { saved = true; return undefined; }
      return typeof fn === "function" ? "Budget check\nRemaining: 500,000" : undefined;
    }),
    close: vi.fn(async () => undefined),
  };
  const state = {
    rows: "1", item_name: "claude ai_max", total_attr: "272133", total_value: "247394", vat: "0", excl: "247394",
    subject: "[Card] Claude AI subscription_max", has_process_money: true, has_edit_check: true, mod_reasons: false,
    del_no: "", mode: "", attachments: FILE_NAMES,
    ...(o.state ?? {}),
  };
  const frame: any = {
    goto: vi.fn(async () => null),
    url: vi.fn(() => `https://gw.ip-korea.org/Document/document_write.php?type=drafts&doc_id=${DOC}`),
    content: vi.fn(async () => (saved ? (o.listAfter ?? LIST_WITH_DOC) : (o.listBefore ?? LIST_WITH_DOC))),
    evaluate: vi.fn(async (fn: any, arg?: any) => {
      const name = typeof fn === "function" ? fn.name : String(fn);
      evaluated.push(name);
      switch (name) {
        case "readBodyText": return saved ? (o.viewAfter ?? view(ROW_AFTER)) : (o.viewBefore ?? view(ROW_BEFORE));
        case "readEditHref": return [EDIT_HREF];
        case "readEditRowState": return state;
        case "applyOverseasVatZero": return o.filled ?? { total_value: arg, total_amt: arg, vat: "0", excl: arg };
        case "setCardErDraftMode1": mode1Args.push(arg); return o.mode1AtSet ?? [arg];
        case "readCardErMode1": return o.mode1AtPopup ?? ["drafts"];
        case "installCardErStubs": return undefined;
        case "runEditSaveFlow": return o.run ?? okRun();
        default: return "[Card] Claude AI subscription_max";
      }
    }),
  };
  const ctx = { on: vi.fn(), off: vi.fn() };
  const page: any = {
    frame: vi.fn(() => frame),
    goto: vi.fn(async () => null),
    url: vi.fn(() => "https://gw.ip-korea.org/"),
    waitForTimeout: vi.fn(async () => undefined),
    waitForLoadState: vi.fn(async () => undefined),
    context: vi.fn(() => ctx),
    waitForEvent: vi.fn(async () => pop),
  };
  const session: any = { isLoggedIn: () => true, getLoginState: () => "logged_in", getPage: () => page };
  const config: any = { baseUrl: "https://gw.ip-korea.org", navTimeoutMs: 1000 };
  return { frame, page, pop, session, config, evaluated, mode1Args, isSaved: () => saved };
}

const parse = (r: any) => JSON.parse(r.content[0].text);

describe("ipk_card_er_fix_vat", () => {
  const prevHome = process.env.IPK_HOME_DIR;
  let home: string;
  let authFile: string;
  const writeAuth = (entries: Record<string, unknown>) => {
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, JSON.stringify(entries));
  };
  const auth = { [`doc:${DOC}`]: { doc_id: DOC, authorized_at: "2026-10-26T13:00:00+09:00", note: "test" } };
  const readAuth = () => JSON.parse(fs.readFileSync(authFile, "utf8"));
  const run = (h: ReturnType<typeof harness>, p: Record<string, unknown> = {}) =>
    handleIpkCardErFixVat(h.session, h.config, { doc_id: DOC, dry_run: false, ...p }).then(parse);

  beforeEach(() => {
    attachFilesSpy.mockReset();
    attachFilesSpy.mockImplementation(async (_f: unknown, paths: string[]) => ({ attached: paths.length, skipped: [] }));
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ipk-fix-vat-home-"));
    process.env.IPK_HOME_DIR = home;
    authFile = path.join(home, ".config", "ipk-browser-mcp", "card-er-draft-authorizations.json");
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.IPK_HOME_DIR;
    else process.env.IPK_HOME_DIR = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("dry_run (default) fills the server total into excl. VAT, saves nothing and needs no authorization", async () => {
    const h = harness();
    const out = parse(await handleIpkCardErFixVat(h.session, h.config, { doc_id: DOC }));
    expect(out.error).toBe(false);
    expect(out.data.dry_run).toBe(true);
    expect(out.data.before).toEqual({ item_name: "claude ai_max", qty: 1, excl: 247394, vat: 0, total: 272133 });
    expect(out.data.would_set).toEqual({ excl: 272133, vat: 0, total: 272133 });
    expect(h.evaluated).toContain("applyOverseasVatZero");
    expect(h.evaluated).not.toContain("runEditSaveFlow");
    expect(h.evaluated).not.toContain("setCardErDraftMode1");
    expect(h.page.waitForEvent).not.toHaveBeenCalled();
  });

  it("uses the server-rendered total, not the DOM total process_money() already rewrote on load", async () => {
    const h = harness();
    await run(h, { dry_run: true });
    const call = h.frame.evaluate.mock.calls.find((c: any[]) => c[0].name === "applyOverseasVatZero");
    expect(call[1]).toBe("272133");
  });

  it("refuses a save without a doc:<id> authorization - nothing clicked, nothing filled", async () => {
    const h = harness();
    const out = await run(h);
    expect(out.code).toBe("CARD_ER_EDIT_REFUSED");
    expect(out.message).toMatch(/card-er-draft-authorizations\.json/);
    expect(out.message).toMatch(new RegExp(`doc:${DOC}`));
    expect(h.evaluated).not.toContain("applyOverseasVatZero");
    expect(h.evaluated).not.toContain("runEditSaveFlow");
    expect(h.page.waitForEvent).not.toHaveBeenCalled();
  });

  it("a transaction (appr_no) authorization does not unlock a doc edit", async () => {
    writeAuth({ [DOC]: { trseq: "1" }, "19984403": { trseq: DOC } });
    const h = harness();
    expect((await run(h)).code).toBe("CARD_ER_EDIT_REFUSED");
    expect(h.evaluated).not.toContain("runEditSaveFlow");
  });

  it("with an authorization: consumes it, saves via [ Save ] with mode1='drafts', reports DRAFT_UPDATED with read-back values", async () => {
    writeAuth(auth);
    const h = harness();
    const out = await run(h);
    expect(out.error).toBe(false);
    expect(out.data.outcome).toBe("DRAFT_UPDATED");
    expect(out.data.after).toEqual({ item_name: "claude ai_max", qty: 1, excl: 272133, vat: 0, total: 272133 });
    expect(out.data.in_drafts).toBe(true);
    expect(out.data.attachments_after).toEqual(out.data.attachments_before);
    expect(readAuth()).toEqual({});
    expect(h.mode1Args).toEqual(["drafts"]);
    const order = h.evaluated.filter((n) => ["applyOverseasVatZero", "setCardErDraftMode1", "runEditSaveFlow", "readCardErMode1"].includes(n));
    expect(order).toEqual(["applyOverseasVatZero", "setCardErDraftMode1", "runEditSaveFlow", "readCardErMode1"]);
    expect(h.pop.evaluate).toHaveBeenCalledWith("submit_form()");
  });

  it("the authorization is consumed before the click: a second call is refused", async () => {
    writeAuth(auth);
    await run(harness());
    const h2 = harness();
    expect((await run(h2)).code).toBe("CARD_ER_EDIT_REFUSED");
    expect(h2.evaluated).not.toContain("runEditSaveFlow");
  });

  it("refuses a non-overseas item before anything else, and leaves the authorization", async () => {
    writeAuth(auth);
    const row = "Office Supplies\tA4 paper\t1\t10,000\t1,000\t11,000\tN/N\t-01\tSTATIONERY\t-";
    const h = harness({ viewBefore: view(row) });
    const out = await run(h);
    expect(out.code).toBe("NOT_OVERSEAS_IT_SUBSCRIPTION");
    expect(readAuth()).toEqual(auth);
    expect(h.evaluated).not.toContain("readEditRowState");
  });

  it("refuses a doc not in type=drafts", async () => {
    writeAuth(auth);
    const h = harness({ listBefore: "<table></table>" });
    expect((await run(h)).code).toBe("NOT_IN_DRAFTS");
    expect(readAuth()).toEqual(auth);
  });

  it("refuses a doc whose view shows it is filed (302098 markers)", async () => {
    writeAuth(auth);
    const h = harness({ viewBefore: view(ROW_BEFORE, "Approval > Progress\n[ Document Repossess ]") });
    const out = await run(h);
    expect(out.code).toBe("NOT_A_DRAFT");
    expect(readAuth()).toEqual(auth);
  });

  it("refuses when the Edit page's server total disagrees with document_view", async () => {
    writeAuth(auth);
    const h = harness({ state: { total_attr: "247394" } });
    expect((await run(h)).code).toBe("EDIT_PAGE_UNEXPECTED");
    expect(readAuth()).toEqual(auth);
    expect(h.evaluated).not.toContain("applyOverseasVatZero");
  });

  it("nothing to fix when VAT is 0 and excl. VAT already equals the total", async () => {
    const h = harness({ viewBefore: view(ROW_AFTER) });
    const out = parse(await handleIpkCardErFixVat(h.session, h.config, { doc_id: DOC, dry_run: false }));
    expect(out.data.outcome).toBe("NOTHING_TO_FIX");
    expect(h.evaluated).not.toContain("readEditRowState");
  });

  it("mode1 guard before the click: mode1 not exactly ['drafts'] stops before the [ Save ] handler", async () => {
    writeAuth(auth);
    const h = harness({ mode1AtSet: ["", ""] });
    const out = await run(h);
    expect(out.code).toBe("DRAFT_MODE_NOT_SET");
    expect(h.evaluated).not.toContain("runEditSaveFlow");
  });

  it("mode1 guard inside the popup: mode1 changed to 'request' closes the popup, submit_form() never called", async () => {
    writeAuth(auth);
    const h = harness({ mode1AtPopup: ["request"] });
    const out = await run(h);
    expect(out.code).toBe("DRAFT_MODE_NOT_SET");
    expect(h.pop.evaluate).not.toHaveBeenCalledWith("submit_form()");
    expect(h.pop.close).toHaveBeenCalled();
  });

  it("SUBMITTED_NOT_DRAFT when document_view after the save shows filed markers", async () => {
    writeAuth(auth);
    const h = harness({ viewAfter: view(ROW_AFTER, "Approval > Progress\n[ Document Repossess ]") });
    const out = await run(h);
    expect(out.code).toBe("SUBMITTED_NOT_DRAFT");
    expect(out.submitted_markers).toEqual(["Approval > Progress", "Document Repossess"]);
  });

  it("DRAFT_NOT_CONFIRMED when the doc left type=drafts", async () => {
    writeAuth(auth);
    const h = harness({ listAfter: "<table></table>" });
    expect((await run(h)).code).toBe("DRAFT_NOT_CONFIRMED");
  });

  it("VALUES_NOT_UPDATED when the view still shows the old split", async () => {
    writeAuth(auth);
    const h = harness({ viewAfter: view(ROW_BEFORE) });
    const out = await run(h);
    expect(out.code).toBe("VALUES_NOT_UPDATED");
    expect(out.after.excl).toBe(247394);
  });

  it("VALUE_SET_FAILED when process_money() does not land on the total - nothing clicked", async () => {
    writeAuth(auth);
    const h = harness({ filled: { total_value: "247394", total_amt: "247394", vat: "0", excl: "272133" } });
    const out = await run(h);
    expect(out.code).toBe("VALUE_SET_FAILED");
    expect(h.evaluated).not.toContain("runEditSaveFlow");
    expect(readAuth()).toEqual({});
  });

  describe("add_attachments (the old file is never deleted: del_file() is an immediate form1.submit())", () => {
    const signedPath = path.join(EVIDENCE_DIR, "2610", "claude", SIGNED);
    const add = [{ path: signedPath, replaces: "261019_Claude-invoice.pdf" }];
    // VAT already fixed: excl = total on the view and in the Edit page DOM.
    const consistent = { total_value: "272133", excl: "272133", vat: "0" };
    const attachOnly = (o: Opts = {}) => harness({
      viewBefore: view(ROW_AFTER),
      viewAfter: view(ROW_AFTER, DRAFTS_HEAD, [...FILE_NAMES, SIGNED]),
      ...o,
      state: { ...consistent, ...(o.state ?? {}) },
    });

    it("attachment-only save: consumes the authorization, attaches before [ Save ], never fills VAT, reports DRAFT_UPDATED and the file left for the person to delete", async () => {
      writeAuth(auth);
      let authAtAttach: unknown = "unread";
      attachFilesSpy.mockImplementation(async (_f: unknown, paths: string[]) => {
        authAtAttach = readAuth();
        return { attached: paths.length, skipped: [] };
      });
      const h = attachOnly();
      const out = await run(h, { add_attachments: add });
      expect(out.error).toBe(false);
      expect(out.data.outcome).toBe("DRAFT_UPDATED");
      expect(attachFilesSpy).toHaveBeenCalledTimes(1);
      expect(attachFilesSpy.mock.calls[0][1]).toEqual([signedPath]);
      expect(authAtAttach).toEqual({});
      expect(h.evaluated).not.toContain("applyOverseasVatZero");
      expect(h.evaluated).toContain("runEditSaveFlow");
      expect(out.data.attachments_after).toEqual([...FILE_NAMES, SIGNED]);
      expect(out.data.left_for_person_to_delete).toEqual(["261019_Claude-invoice.pdf"]);
      expect(out.data.after).toEqual(out.data.before);
      expect(out.data.message).toMatch(/261019_Claude-invoice\.pdf/);
    });

    it("dry_run with attachments: reports what would be added, attaches nothing, needs no authorization", async () => {
      const h = attachOnly();
      const out = parse(await handleIpkCardErFixVat(h.session, h.config, { doc_id: DOC, add_attachments: add }));
      expect(out.data.dry_run).toBe(true);
      expect(out.data.would_add).toEqual([SIGNED]);
      expect(out.data.left_for_person_to_delete).toEqual(["261019_Claude-invoice.pdf"]);
      expect(attachFilesSpy).not.toHaveBeenCalled();
      expect(h.evaluated).not.toContain("runEditSaveFlow");
    });

    it("refuses when the file named in replaces is not attached - nothing opened, authorization kept", async () => {
      writeAuth(auth);
      const h = attachOnly();
      const out = await run(h, { add_attachments: [{ path: signedPath, replaces: "nope.pdf" }] });
      expect(out.code).toBe("REPLACED_FILE_NOT_FOUND");
      expect(readAuth()).toEqual(auth);
      expect(h.evaluated).not.toContain("readEditRowState");
    });

    it("refuses a path outside data/attachments (scratchpad / Downloads) before anything", async () => {
      writeAuth(auth);
      for (const p of ["/tmp/claude-1/scratchpad/x_signed.pdf", "/home/u/Downloads/x_signed.pdf"]) {
        const h = attachOnly();
        const out = await run(h, { add_attachments: [{ path: p }] });
        expect(out.code).toBe("INVALID_ATTACHMENT");
        expect(h.evaluated).not.toContain("readEditRowState");
      }
      expect(readAuth()).toEqual(auth);
      expect(attachFilesSpy).not.toHaveBeenCalled();
    });

    it("refuses a file whose name is already attached (a retry would attach it twice)", async () => {
      writeAuth(auth);
      const h = attachOnly({ viewBefore: view(ROW_AFTER, DRAFTS_HEAD, [...FILE_NAMES, SIGNED]) });
      const out = await run(h, { add_attachments: add });
      expect(out.code).toBe("ALREADY_ATTACHED");
      expect(readAuth()).toEqual(auth);
    });

    it("refuses when the Edit page's on-load amounts differ from document_view (process_money trap)", async () => {
      writeAuth(auth);
      const h = attachOnly({ state: { total_value: "247394" } });
      const out = await run(h, { add_attachments: add });
      expect(out.code).toBe("EDIT_PAGE_UNEXPECTED");
      expect(out.message).toMatch(/247394/);
      expect(readAuth()).toEqual(auth);
      expect(attachFilesSpy).not.toHaveBeenCalled();
    });

    it("refuses when del_no is set or the Edit page's attachment list differs from document_view", async () => {
      writeAuth(auth);
      for (const state of [{ del_no: "2" }, { mode: "file" }, { attachments: [FILE_NAMES[0]] }]) {
        const h = attachOnly({ state });
        expect((await run(h, { add_attachments: add })).code).toBe("EDIT_PAGE_UNEXPECTED");
      }
      expect(readAuth()).toEqual(auth);
      expect(attachFilesSpy).not.toHaveBeenCalled();
    });

    it("ATTACHMENT_NOT_ACCEPTED when the file does not land in a slot - [ Save ] never run", async () => {
      writeAuth(auth);
      attachFilesSpy.mockImplementation(async (_f: unknown, paths: string[]) => ({ attached: 0, skipped: [{ path: paths[0], reason: "x" }] }));
      const h = attachOnly();
      const out = await run(h, { add_attachments: add });
      expect(out.code).toBe("ATTACHMENT_NOT_ACCEPTED");
      expect(h.evaluated).not.toContain("runEditSaveFlow");
      expect(readAuth()).toEqual({});
    });

    it("ATTACHMENTS_MISMATCH when the read-back list is not exactly before + added", async () => {
      writeAuth(auth);
      const h = attachOnly({ viewAfter: view(ROW_AFTER) });
      const out = await run(h, { add_attachments: add });
      expect(out.code).toBe("ATTACHMENTS_MISMATCH");
      expect(out.expected_attachments).toEqual([...FILE_NAMES, SIGNED]);
    });

    it("AMOUNTS_CHANGED when an attachment-only save changed the amounts", async () => {
      writeAuth(auth);
      const h = attachOnly({ viewAfter: view(ROW_BEFORE, DRAFTS_HEAD, [...FILE_NAMES, SIGNED]) });
      const out = await run(h, { add_attachments: add });
      expect(out.code).toBe("AMOUNTS_CHANGED");
    });

    it("fix_vat:false skips the overseas check, so any card ER's attachment can be added", async () => {
      writeAuth(auth);
      const row = "Office Supplies\tA4 paper\t1\t10,000\t1,000\t11,000\tN/N\t-01\tSTATIONERY\t-";
      const h = attachOnly({
        viewBefore: view(row),
        viewAfter: view(row, DRAFTS_HEAD, [...FILE_NAMES, SIGNED]),
        state: { item_name: "A4 paper", total_attr: "11000", total_value: "11000", excl: "10000", vat: "1000" },
      });
      const out = await run(h, { fix_vat: false, add_attachments: add });
      expect(out.data?.outcome).toBe("DRAFT_UPDATED");
      expect(h.evaluated).not.toContain("applyOverseasVatZero");
    });

    it("fix_vat:false with no attachments is refused as nothing to do", async () => {
      const h = attachOnly();
      expect((await run(h, { fix_vat: false })).code).toBe("NOTHING_TO_DO");
      expect(h.evaluated).not.toContain("readEditRowState");
    });

    it("VAT fix and attachment in one save", async () => {
      writeAuth(auth);
      const h = harness({ viewAfter: view(ROW_AFTER, DRAFTS_HEAD, [...FILE_NAMES, SIGNED]) });
      const out = await run(h, { add_attachments: add });
      expect(out.data.outcome).toBe("DRAFT_UPDATED");
      expect(h.evaluated).toContain("applyOverseasVatZero");
      expect(attachFilesSpy).toHaveBeenCalledTimes(1);
    });
  });
});

describe("runEditSaveFlow (fake page globals)", () => {
  afterEach(() => {
    delete (globalThis as any).window;
  });
  it("calls the page's own fn_Edit_Check('update','drafts') - never the [ Request ] path", () => {
    const calls: unknown[][] = [];
    (globalThis as any).window = {
      __ipkCardEr: { alerts: [], pageError: null },
      fn_Edit_Check: (...a: unknown[]) => calls.push(a),
      Check_Form_Request: () => calls.push(["Check_Form_Request directly"]),
    };
    const out = runEditSaveFlow();
    expect(calls).toEqual([["update", "drafts"]]);
    expect(out.pageError).toBeNull();
  });
  it("a page without fn_Edit_Check is reported, not thrown", () => {
    (globalThis as any).window = { __ipkCardEr: { alerts: [], pageError: null } };
    expect(runEditSaveFlow().pageError).toMatch(/fn_Edit_Check is not defined/);
  });
});
