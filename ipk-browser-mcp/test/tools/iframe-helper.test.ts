import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Frame, Page } from "playwright";

// We test setFieldValue, setSelectValue, executeAjaxCascade by importing from source
// and providing mock Frame/Page objects.
import { setFieldValue, setSelectValue, executeAjaxCascade } from "../../src/browser/iframe-helper.js";
import type { CascadeStep } from "../../src/browser/iframe-helper.js";

/** Create a minimal mock Frame */
function createMockFrame(overrides: Partial<Record<string, any>> = {}): Frame {
  return {
    waitForSelector: vi.fn().mockResolvedValue({}),
    evaluate: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as unknown as Frame;
}

/** Create a minimal mock Page */
function createMockPage(): Page {
  return {
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    waitForNavigation: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
}

// ─── setFieldValue ──────────────────────────────────────────────

describe("setFieldValue", () => {
  it("returns true when element is found and value is set", async () => {
    const frame = createMockFrame({
      evaluate: vi.fn().mockResolvedValue("ok"),
    });
    const result = await setFieldValue(frame, 'input[name="subject"]', "Test Subject");
    expect(result).toBe(true);
    expect(frame.waitForSelector).toHaveBeenCalledWith('input[name="subject"]', { timeout: 5000 });
    expect(frame.evaluate).toHaveBeenCalled();
  });

  it("returns false when element is not found in DOM", async () => {
    const frame = createMockFrame({
      waitForSelector: vi.fn().mockRejectedValue(new Error("timeout")),
      evaluate: vi.fn().mockResolvedValue("not_found"),
    });
    const result = await setFieldValue(frame, 'input[name="missing"]', "value");
    expect(result).toBe(false);
  });

  it("handles empty value string", async () => {
    const frame = createMockFrame({
      evaluate: vi.fn().mockResolvedValue("ok"),
    });
    const result = await setFieldValue(frame, 'input[name="field"]', "");
    expect(result).toBe(true);
    // Verify evaluate was called with the empty value
    const callArgs = (frame.evaluate as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[1]).toEqual({ sel: 'input[name="field"]', val: "" });
  });

  it("throws rather than writing to a disabled control", async () => {
    // A disabled control is omitted from the submitted payload, so a value written to it
    // would appear on screen and never reach the server.
    const frame = createMockFrame({
      evaluate: vi.fn().mockResolvedValue("disabled"),
    });
    await expect(setFieldValue(frame, 'select[name="food_ex_cnt"]', "3")).rejects.toThrow(
      /FIELD_DISABLED/
    );
  });
});

// ─── setSelectValue ─────────────────────────────────────────────

describe("setSelectValue", () => {
  it("returns true when select element exists", async () => {
    const frame = createMockFrame({
      waitForSelector: vi.fn().mockResolvedValue({}), // element found
      evaluate: vi.fn().mockResolvedValue(true),
    });
    const result = await setSelectValue(frame, 'select[name="budget_type"]', "01");
    expect(result).toBe(true);
  });

  it("returns false when select element does not exist", async () => {
    const frame = createMockFrame({
      waitForSelector: vi.fn().mockResolvedValue(null), // null = not found
    });
    const result = await setSelectValue(frame, 'select[name="missing"]', "01");
    expect(result).toBe(false);
  });

  it("dispatches change event via evaluate", async () => {
    const evaluateFn = vi.fn().mockResolvedValue(true);
    const frame = createMockFrame({
      waitForSelector: vi.fn().mockResolvedValue({}),
      evaluate: evaluateFn,
    });
    await setSelectValue(frame, 'select[name="type"]', "02");
    expect(evaluateFn).toHaveBeenCalledTimes(1);
    const callArgs = evaluateFn.mock.calls[0];
    expect(callArgs[1]).toEqual({ sel: 'select[name="type"]', val: "02" });
  });
});

// ─── executeAjaxCascade ─────────────────────────────────────────

describe("executeAjaxCascade", () => {
  let page: Page;

  beforeEach(() => {
    page = createMockPage();
  });

  it("completes all steps in sequence", async () => {
    const frame = createMockFrame({
      waitForSelector: vi.fn().mockResolvedValue({}),
      evaluate: vi.fn().mockResolvedValue(true),
    });

    const steps: CascadeStep[] = [
      { field: "province", value: "Seoul", waitSelector: "select[name='city'] option:nth-child(2)", timeoutMs: 3000 },
      { field: "city", value: "Gangnam", timeoutMs: 1500 },
    ];

    const result = await executeAjaxCascade(page, frame, steps);
    expect(result.completed).toBe(2);
    expect(result.total).toBe(2);
    expect(result.errors).toHaveLength(0);
  });

  it("retries on timeout then succeeds", async () => {
    let callCount = 0;
    const frame = createMockFrame({
      waitForSelector: vi.fn().mockImplementation(async (sel: string, opts: any) => {
        // First call for setSelectValue — succeeds
        // For waitSelector calls: fail first time, succeed on retry
        callCount++;
        if (sel.includes("option") && callCount <= 2) {
          throw new Error("TimeoutError");
        }
        return {};
      }),
      evaluate: vi.fn().mockResolvedValue(true),
    });

    const steps: CascadeStep[] = [
      { field: "province", value: "Seoul", waitSelector: "select[name='city'] option:nth-child(2)", timeoutMs: 3000 },
    ];

    const result = await executeAjaxCascade(page, frame, steps);
    // Should succeed after retry
    expect(result.completed).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("reports error when cascade fully times out", async () => {
    const frame = createMockFrame({
      waitForSelector: vi.fn().mockImplementation(async (sel: string) => {
        if (sel.includes("option")) {
          throw new Error("TimeoutError");
        }
        return {}; // setSelectValue's waitForSelector succeeds
      }),
      evaluate: vi.fn().mockResolvedValue(true),
    });

    const steps: CascadeStep[] = [
      { field: "province", value: "Seoul", waitSelector: "select[name='city'] option:nth-child(2)", timeoutMs: 1000 },
    ];

    const result = await executeAjaxCascade(page, frame, steps);
    expect(result.completed).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("CASCADE_TIMEOUT");
  });

  it("skips step when condition is not met", async () => {
    const frame = createMockFrame({
      waitForSelector: vi.fn().mockResolvedValue({}),
      evaluate: vi.fn().mockImplementation(async (fn: any, arg: any) => {
        // condition check returns false (no value set)
        if (typeof arg === "string") return false;
        // setSelectValue returns true
        return true;
      }),
    });

    const steps: CascadeStep[] = [
      { field: "budget_code", value: "NN2612", condition: "budget_type", timeoutMs: 1000 },
    ];

    const result = await executeAjaxCascade(page, frame, steps);
    // Step should be skipped (condition not met), but not counted as error
    expect(result.completed).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(result.total).toBe(1);
  });

  it("handles selector not found for a step", async () => {
    const frame = createMockFrame({
      waitForSelector: vi.fn().mockResolvedValue(null), // setSelectValue sees null → returns false
      evaluate: vi.fn().mockResolvedValue(true),
    });

    const steps: CascadeStep[] = [
      { field: "province", value: "Seoul", timeoutMs: 1000 },
    ];

    const result = await executeAjaxCascade(page, frame, steps);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("SELECTOR_NOT_FOUND");
  });
});
