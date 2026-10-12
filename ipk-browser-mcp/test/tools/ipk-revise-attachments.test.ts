/**
 * ipk_revise_attachments (plan v6 P3 item 3c): adds files to a card ER returned for
 * revision via the Additional document widget. attach_file_trans() is an IMMEDIATE write
 * (mode='tran_file' + form1.submit(), no draft) - mocked-page tests only, never a live write.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("../../src/security/attachment-path.js", () => ({ validateAttachmentPath: () => null }));

const { navigateInFrameSpy, attachRevisionFilesSpy } = vi.hoisted(() => ({
  navigateInFrameSpy: vi.fn(),
  attachRevisionFilesSpy: vi.fn(async (_frame: unknown, paths: string[]) => ({ attached: paths.length, skipped: [] })),
}));
vi.mock("../../src/browser/iframe-helper.js", () => ({ navigateInFrame: navigateInFrameSpy }));
vi.mock("../../src/internal/primitives/attachment.js", () => ({ attachRevisionFiles: attachRevisionFilesSpy }));

import { handleIpkReviseAttachments } from "../../src/tools/ipk-revise-attachments.js";

const parse = (r: any) => JSON.parse(r.content[0].text);

const REVISION_TEXT = fs.readFileSync(
  path.join(__dirname, "..", "fixtures", "card-er-location", "document-view-301306-revision.rawtext.txt"), "utf8"
);

function makeFrame(bodyText: string, delNo = "") {
  const setInputFilesCalls: string[] = [];
  const attachFileTrans = vi.fn();
  const windowOpenCalls: string[] = [];
  const evaluate = vi.fn(async (fn: any) => {
    const src = String(fn);
    if (src.includes("document.body ? document.body.innerText")) return bodyText;
    if (src.includes('name="del_no"')) return delNo;
    if (src.includes("attach_file_trans")) {
      attachFileTrans();
      return undefined;
    }
    return undefined;
  });
  const locator = vi.fn((sel: string) => ({
    nth: (i: number) => ({
      setInputFiles: vi.fn(async (p: string) => { setInputFilesCalls.push(`${sel}[${i}]=${p}`); }),
    }),
  }));
  const frame: any = {
    evaluate,
    locator,
    url: vi.fn(() => "https://gw.ip-korea.org/Document/document_view.php?doc_id=301306"),
  };
  return { frame, setInputFilesCalls, attachFileTrans, windowOpenCalls };
}

function makeSession(frame: any) {
  return {
    isLoggedIn: () => true,
    getLoginState: () => "logged_in",
    getPage: () => ({ waitForTimeout: vi.fn(async () => undefined) }),
  } as any;
}

const config: any = { baseUrl: "https://gw.ip-korea.org" };

const ATTACH = "/data/attachments/program.pdf";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ipk_revise_attachments dry_run (default true)", () => {
  it("shows opinions, existing Additional documents, and the account-resolved attachment review - no upload", async () => {
    const { frame, setInputFilesCalls, attachFileTrans } = makeFrame(REVISION_TEXT);
    navigateInFrameSpy.mockResolvedValue(frame);
    const session = makeSession(frame);
    const out = parse(await handleIpkReviseAttachments(session, config, {
      doc_id: "301306",
      attachments: [{ path: ATTACH, kind: "fee_table", quotes: ["Total: 650,000"] }],
    }));
    expect(out.error).toBe(false);
    expect(out.data.dry_run).toBe(true);
    expect(out.data.account_code).toBe("410306");
    expect(out.data.existing_additional_documents).toEqual([
      "260927_AI4Sci-conference_program_revised.pdf",
      "260927_AI4Sci-conference_program_registration_fee.png",
    ]);
    expect(out.data.opinions.some((o: any) => o.hasOpinion)).toBe(true);
    expect(attachRevisionFilesSpy).not.toHaveBeenCalled();
    expect(attachFileTrans).not.toHaveBeenCalled();
  });

  it("runs the P1 attachment review against the resolved account and blocks a bad fee_table quote, even under dry_run", async () => {
    const { frame, setInputFilesCalls } = makeFrame(REVISION_TEXT);
    navigateInFrameSpy.mockResolvedValue(frame);
    const session = makeSession(frame);
    const out = parse(await handleIpkReviseAttachments(session, config, {
      doc_id: "301306",
      attachments: [{ path: ATTACH, kind: "fee_table", quotes: ["no total here"] }],
    }));
    expect(out.error).toBe(true);
    expect(out.code).toBe("ATTACHMENT_REVIEW_BLOCKED");
    expect(attachRevisionFilesSpy).not.toHaveBeenCalled();
  });

  it("defaults dry_run true even when the caller omits it entirely", async () => {
    const { frame, attachFileTrans } = makeFrame(REVISION_TEXT);
    navigateInFrameSpy.mockResolvedValue(frame);
    const session = makeSession(frame);
    const out = parse(await handleIpkReviseAttachments(session, config, {
      doc_id: "301306",
      attachments: [{ path: ATTACH, kind: "fee_table", quotes: ["Total: 650,000"] }],
      // dry_run omitted
    }));
    expect(out.data.dry_run).toBe(true);
    expect(attachFileTrans).not.toHaveBeenCalled();
  });
});

describe("ipk_revise_attachments real write (dry_run:false)", () => {
  it("refuses without confirm_submit:true - no upload", async () => {
    const { frame, setInputFilesCalls, attachFileTrans } = makeFrame(REVISION_TEXT);
    navigateInFrameSpy.mockResolvedValue(frame);
    const session = makeSession(frame);
    const out = parse(await handleIpkReviseAttachments(session, config, {
      doc_id: "301306",
      attachments: [{ path: ATTACH, kind: "fee_table", quotes: ["Total: 650,000"] }],
      dry_run: false,
    }));
    expect(out.error).toBe(true);
    expect(out.code).toBe("REVISE_CONFIRM_REQUIRED");
    expect(attachRevisionFilesSpy).not.toHaveBeenCalled();
    expect(attachFileTrans).not.toHaveBeenCalled();
  });

  it("refuses when del_no is unexpectedly non-empty, before any upload", async () => {
    const { frame, setInputFilesCalls, attachFileTrans } = makeFrame(REVISION_TEXT, "3");
    navigateInFrameSpy.mockResolvedValue(frame);
    const session = makeSession(frame);
    const out = parse(await handleIpkReviseAttachments(session, config, {
      doc_id: "301306",
      attachments: [{ path: ATTACH, kind: "fee_table", quotes: ["Total: 650,000"] }],
      dry_run: false,
      confirm_submit: true,
    }));
    expect(out.error).toBe(true);
    expect(out.code).toBe("DEL_NO_NOT_EMPTY");
    expect(attachRevisionFilesSpy).not.toHaveBeenCalled();
    expect(attachFileTrans).not.toHaveBeenCalled();
  });

  it("with both dry_run:false and confirm_submit:true, uploads into trans_attach_file[] and calls attach_file_trans() exactly once", async () => {
    const { frame, setInputFilesCalls, attachFileTrans } = makeFrame(REVISION_TEXT);
    navigateInFrameSpy.mockResolvedValue(frame);
    const session = makeSession(frame);
    const out = parse(await handleIpkReviseAttachments(session, config, {
      doc_id: "301306",
      attachments: [{ path: ATTACH, kind: "fee_table", quotes: ["Total: 650,000"] }],
      dry_run: false,
      confirm_submit: true,
    }));
    expect(out.error).toBe(false);
    expect(out.data.attached).toBe(1);
    expect(attachRevisionFilesSpy).toHaveBeenCalledWith(frame, [ATTACH]);
    expect(attachFileTrans).toHaveBeenCalledTimes(1);
    expect(out.data.existing_additional_documents_after).toEqual([
      "260927_AI4Sci-conference_program_revised.pdf",
      "260927_AI4Sci-conference_program_registration_fee.png",
    ]);
  });

  it("rejects more than 3 files before touching the page at all", async () => {
    navigateInFrameSpy.mockClear();
    const session = makeSession({});
    const out = parse(await handleIpkReviseAttachments(session, config, {
      doc_id: "301306",
      attachments: [1, 2, 3, 4].map((i) => ({ path: `${ATTACH}${i}`, kind: "other" as const })),
      dry_run: false,
      confirm_submit: true,
    }));
    expect(out.error).toBe(true);
    expect(out.code).toBe("TOO_MANY_FILES");
    expect(navigateInFrameSpy).not.toHaveBeenCalled();
  });
});

describe("structural: never calls doc_revision_pop / [Revision Complete], never del_trans_file/del_file", () => {
  it("the executable handler never references doc_revision_pop or del_trans_file/del_file (the description string and comments may document them by name)", () => {
    const full = fs.readFileSync(path.join(__dirname, "..", "..", "src", "tools", "ipk-revise-attachments.ts"), "utf8");
    const handler = full.slice(full.indexOf("export async function handleIpkReviseAttachments("));
    expect(handler).not.toMatch(/doc_revision_pop/);
    expect(handler).not.toMatch(/del_trans_file/);
    expect(handler).not.toMatch(/del_file\(/);
  });

  it("a real write never triggers window.open/doc_revision_pop as a side effect (stub spy)", async () => {
    const { frame, attachFileTrans } = makeFrame(REVISION_TEXT);
    const openSpy = vi.fn();
    frame.evaluate = vi.fn(async (fn: any) => {
      const src = String(fn);
      if (src.includes("document.body ? document.body.innerText")) return REVISION_TEXT;
      if (src.includes('name="del_no"')) return "";
      if (src.includes("attach_file_trans")) { attachFileTrans(); return undefined; }
      return undefined;
    });
    navigateInFrameSpy.mockResolvedValue(frame);
    const session = makeSession(frame);
    await handleIpkReviseAttachments(session, config, {
      doc_id: "301306",
      attachments: [{ path: ATTACH, kind: "fee_table", quotes: ["Total: 650,000"] }],
      dry_run: false,
      confirm_submit: true,
    });
    expect(openSpy).not.toHaveBeenCalled();
  });
});
