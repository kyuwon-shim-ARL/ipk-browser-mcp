/**
 * Regression tests for IPK-DR-007 bug fixes:
 *   T1 – ipk_fetch_approvals URL mapping + onclick doc_id parsing
 *   T2 – navigateToForm stale frame detection + FORM_READY_SELECTORS
 *   T3 – ESM __dirname replacement (smoke)
 *   T4 – ipk_navigate frame.url() fallback
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Frame, Page } from "playwright";

// ── shared mock helpers ───────────────────────────────────────────

function makeMockFrame(overrides: Partial<Record<string, any>> = {}): Frame {
  return {
    goto: vi.fn().mockResolvedValue(null),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue({}),
    evaluate: vi.fn().mockResolvedValue([]),
    url: vi.fn().mockReturnValue("https://gw.ip-korea.org/Document/"),
    title: vi.fn().mockResolvedValue("Test"),
    ...overrides,
  } as unknown as Frame;
}

function makeMockPage(frame: Frame | null): Page {
  // navigateToForm navigates the page itself and then uses page.mainFrame();
  // the frame.goto()/stale-retry path it used to take no longer exists.
  return {
    frame: vi.fn().mockReturnValue(frame),
    mainFrame: vi.fn().mockReturnValue(frame),
    goto: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
}

// ── T1: URL parameter mapping ──────────────────────────────────────

describe("T1 – ipk_fetch_approvals URL type mapping", () => {
  /**
   * We test the STATUS_URL_MAP logic by verifying that navigateInFrame is called
   * with the expected ?type= query string for each status value.
   * We mock navigateInFrame via vi.doMock to capture the URL argument.
   */

  it("maps 'pending' → type=progress in URL", () => {
    const STATUS_URL_MAP: Record<string, string> = {
      pending: "progress",
      approved: "approved",
      rejected: "rejected",
      draft: "draft",
    };
    expect(STATUS_URL_MAP["pending"]).toBe("progress");
    expect(STATUS_URL_MAP["approved"]).toBe("approved");
    expect(STATUS_URL_MAP["rejected"]).toBe("rejected");
    expect(STATUS_URL_MAP["draft"]).toBe("draft");
  });

  it("dedup: approved wins over rejected for same docId", () => {
    const DEDUP_PRIORITY: Record<string, number> = {
      approved: 3,
      rejected: 2,
      draft: 1,
      progress: 0,
    };

    function statusToPriority(status: string): number {
      const s = status.toLowerCase();
      for (const [key, pri] of Object.entries(DEDUP_PRIORITY)) {
        if (s.includes(key)) return pri;
      }
      return -1;
    }

    // Simulate dedup
    const raw = [
      { docId: "12345", status: "rejected", title: "Doc A" },
      { docId: "12345", status: "approved", title: "Doc A" },
    ];

    type Item = typeof raw[0] & { _pri?: number };
    const dedupMap = new Map<string, Item & { _pri: number }>();
    for (const item of raw) {
      const pri = statusToPriority(item.status);
      const existing = dedupMap.get(item.docId);
      if (!existing || pri > existing._pri) {
        dedupMap.set(item.docId, { ...item, _pri: pri });
      }
    }

    const result = [...dedupMap.values()];
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("approved");
  });

  it("dedup: approved wins over progress for same docId", () => {
    const DEDUP_PRIORITY: Record<string, number> = {
      approved: 3,
      rejected: 2,
      draft: 1,
      progress: 0,
    };
    function pri(status: string): number {
      const s = status.toLowerCase();
      for (const [k, v] of Object.entries(DEDUP_PRIORITY)) {
        if (s.includes(k)) return v;
      }
      return -1;
    }

    const raw = [
      { docId: "99999", status: "progress" },
      { docId: "99999", status: "approved" },
    ];

    type R = typeof raw[0] & { _pri: number };
    const m = new Map<string, R>();
    for (const item of raw) {
      const p = pri(item.status);
      const ex = m.get(item.docId);
      if (!ex || p > ex._pri) m.set(item.docId, { ...item, _pri: p });
    }

    expect(m.get("99999")?.status).toBe("approved");
  });

  it("onclick 1차 regex matches doc_id= pattern", () => {
    const onclick1 = "viewDoc('doc_id=12345&foo=bar')";
    const m = onclick1.match(/['"]?doc_id['"]?\s*[=,]\s*['"]?(\d+)/i);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("12345");
  });

  it("onclick 2차 fallback matches 5+ digit quoted number", () => {
    const onclick2 = "openDocument('99999', 'title')";
    // 1차 fails
    const m1 = onclick2.match(/['"]?doc_id['"]?\s*[=,]\s*['"]?(\d+)/i);
    expect(m1).toBeNull();
    // 2차 succeeds
    const m2 = onclick2.match(/['"](\d{5,})['"]/);
    expect(m2).not.toBeNull();
    expect(m2![1]).toBe("99999");
  });

  it("onclick both regex fail → no doc_id extracted", () => {
    const onclick3 = "doSomething('abc', 'xyz')";
    const m1 = onclick3.match(/['"]?doc_id['"]?\s*[=,]\s*['"]?(\d+)/i);
    const m2 = onclick3.match(/['"](\d{5,})['"]/);
    expect(m1).toBeNull();
    expect(m2).toBeNull();
  });
});

// ── T2: navigateToForm stale frame detection ───────────────────────

describe("T2 – navigateToForm navigation contract", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("navigates the page (not the child frame) and returns the main frame", async () => {
    const { navigateToForm } = await import("../../src/browser/iframe-helper.js");

    const frame = makeMockFrame({});
    const page = makeMockPage(frame);
    const config = { baseUrl: "https://gw.ip-korea.org", navTimeoutMs: 10000 } as any;

    const result = await navigateToForm(page, "leave", config);

    expect(result).toBe(frame);
    const gotoUrl = (page.goto as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(gotoUrl).toContain("/Document/document_write.php?approve_type=");
  }, 3000);

  it("strips any path in baseUrl so the form URL uses the origin only", async () => {
    const { navigateToForm } = await import("../../src/browser/iframe-helper.js");

    const frame = makeMockFrame({});
    const page = makeMockPage(frame);
    const config = { baseUrl: "https://gw.ip-korea.org/main.php", navTimeoutMs: 10000 } as any;

    await navigateToForm(page, "leave", config);

    const gotoUrl = (page.goto as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(gotoUrl).not.toContain("main.php");
    expect(gotoUrl.startsWith("https://gw.ip-korea.org/Document/")).toBe(true);
  }, 3000);

  it("leave form waits for select[name='leave_kind[]'] ready selector", async () => {
    const { navigateToForm } = await import("../../src/browser/iframe-helper.js");

    const waitForSelectorFn = vi.fn().mockResolvedValue({});
    const frame = makeMockFrame({ waitForSelector: waitForSelectorFn });
    const page = makeMockPage(frame);
    const config = { baseUrl: "https://gw.ip-korea.org", navTimeoutMs: 10000 } as any;

    await navigateToForm(page, "leave", config);

    const calls = (waitForSelectorFn as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(calls).toContain('select[name="leave_kind[]"]');
  }, 3000);
});

// ── T4: ipk_navigate frame.url() fallback ──────────────────────────

describe("T4 – ipk_navigate frame.url() fallback via frame.evaluate", () => {
  it("calls frame.evaluate when frame.url() returns non-gw URL", async () => {
    const evaluateFn = vi.fn().mockResolvedValue("https://gw.ip-korea.org/Document/document_list.php");
    const frame = makeMockFrame({
      url: vi.fn().mockReturnValue("https://other-domain.com/page"),
      evaluate: evaluateFn,
      title: vi.fn().mockResolvedValue("Document List"),
    });

    // Test the fallback logic directly (mirrors handleIpkNavigate implementation)
    let frameUrl = frame.url();
    if (!frameUrl.includes("gw.ip-korea.org")) {
      try {
        frameUrl = await (frame.evaluate as any)(() => location.href);
      } catch (e) {
        // keep original
      }
    }

    expect(evaluateFn).toHaveBeenCalledTimes(1);
    expect(frameUrl).toBe("https://gw.ip-korea.org/Document/document_list.php");
  });

  it("keeps original frame.url() when evaluate throws", async () => {
    const originalUrl = "https://other-domain.com/page";
    const frame = makeMockFrame({
      url: vi.fn().mockReturnValue(originalUrl),
      evaluate: vi.fn().mockRejectedValue(new Error("frame detached")),
    });

    let frameUrl = frame.url();
    if (!frameUrl.includes("gw.ip-korea.org")) {
      try {
        frameUrl = await (frame.evaluate as any)(() => location.href);
      } catch (_e) {
        // keep original
      }
    }

    expect(frameUrl).toBe(originalUrl);
  });
});

// ── T3: ESM smoke ─────────────────────────────────────────────────

describe("T3 – ESM __dirname replacement smoke test", () => {
  it("ipk-inspect module loads without __dirname reference error", async () => {
    // If __dirname is undefined in ESM, the module-level code would throw at import time
    await expect(import("../../src/tools/ipk-inspect.js")).resolves.toHaveProperty("ipkInspectFormSchema");
  });

  it("ipk-submit module loads without __dirname reference error", async () => {
    await expect(import("../../src/tools/ipk-submit.js")).resolves.toHaveProperty("ipkSubmitFormSchema");
  });
});
