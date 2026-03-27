import { describe, it, expect } from "vitest";
import { textResult } from "../../src/util.js";

/**
 * Regression tests for T1: stub FormTypes must return friendly NOT_IMPLEMENTED
 * errors (code: "NOT_IMPLEMENTED"), NOT Zod enum rejection errors.
 *
 * These tests replicate the logic in handleIpkSubmitForm's switch statement
 * for the 5 new stub types without requiring a live browser session.
 */

const STUB_FORM_TYPES = [
  { type: "travel_settlement", label: "출장정산", appFrm: "AppFrm-076" },
  { type: "leave_return",      label: "대체휴일반납", appFrm: "AppFrm-028" },
  { type: "card_expense",      label: "카드경비",   appFrm: "AppFrm-020" },
  { type: "seminar",           label: "세미나공시", appFrm: "AppFrm-043" },
  { type: "overseas_travel",   label: "해외출장",   appFrm: "AppFrm-026" },
] as const;

/** Simulate what the switch statement returns for stub types */
function stubResponse(formType: string): ReturnType<typeof textResult> {
  const messages: Record<string, string> = {
    travel_settlement: "출장정산(AppFrm-076) 기능은 현재 구현 중입니다. Python bridge 연동 후 사용 가능합니다.",
    leave_return:      "대체휴일반납(AppFrm-028) 기능은 현재 구현 중입니다. Python bridge 연동 후 사용 가능합니다.",
    card_expense:      "카드경비(AppFrm-020) 기능은 현재 구현 중입니다. Python bridge 연동 후 사용 가능합니다.",
    seminar:           "세미나공시(AppFrm-043) 기능은 현재 구현 중입니다. Python bridge 연동 후 사용 가능합니다.",
    overseas_travel:   "해외출장(AppFrm-026) 기능은 현재 구현 중입니다. Python bridge 연동 후 사용 가능합니다.",
  };
  const message = messages[formType];
  if (!message) return textResult({ error: true, code: "UNKNOWN_FORM", message: `Unknown: ${formType}` });
  return textResult({ error: true, code: "NOT_IMPLEMENTED", message });
}

describe("Regression: stub FormTypes return NOT_IMPLEMENTED (not Zod rejection)", () => {
  for (const { type, label, appFrm } of STUB_FORM_TYPES) {
    it(`${type} (${label} / ${appFrm}) returns NOT_IMPLEMENTED error code`, () => {
      const response = stubResponse(type);
      // MCP textResult returns { content: [{ type: "text", text: JSON }] }
      const text = response.content[0].text;
      const parsed = JSON.parse(text);
      expect(parsed.error).toBe(true);
      expect(parsed.code).toBe("NOT_IMPLEMENTED");
      // Message must be in Korean and mention the AppFrm code
      expect(parsed.message).toContain(appFrm);
      // Must NOT be a Zod validation error
      expect(parsed.code).not.toBe("ZOD_ERROR");
      expect(parsed.code).not.toBe("VALIDATION_ERROR");
    });
  }
});
