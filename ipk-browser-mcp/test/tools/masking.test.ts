import { describe, it, expect } from "vitest";
import {
  maskKoreanName,
  maskPhone,
  maskEmail,
  maskPiiFields,
} from "../../src/security/masking.js";

describe("PII masking", () => {
  describe("maskKoreanName", () => {
    it("masks 3-char Korean name", () => {
      expect(maskKoreanName("홍길동")).toBe("홍*동");
    });

    it("masks 2-char Korean name", () => {
      expect(maskKoreanName("김이")).toBe("김*");
    });

    it("passes through non-Korean name", () => {
      const result = maskKoreanName("John Smith");
      expect(result).toContain("J.");
    });

    it("handles empty string", () => {
      expect(maskKoreanName("")).toBe("");
    });
  });

  describe("maskPhone", () => {
    it("masks middle digits of Korean phone number", () => {
      expect(maskPhone("010-1234-5678")).toBe("010-****-5678");
    });

    it("masks unformatted phone number", () => {
      expect(maskPhone("01012345678")).toBe("010-****-5678");
    });
  });

  describe("maskEmail", () => {
    it("masks local part keeping first char", () => {
      expect(maskEmail("user@example.com")).toBe("u***@example.com");
    });

    it("passes through invalid email", () => {
      expect(maskEmail("notanemail")).toBe("notanemail");
    });
  });

  describe("maskPiiFields", () => {
    it("masks known PII fields (substitute_name, emergency_telephone)", () => {
      const input = {
        substitute_name: "홍길동",
        emergency_telephone: "010-1234-5678",
      };
      const result = maskPiiFields(input);
      expect(result.substitute_name).toBe("홍*동");
      expect(result.emergency_telephone).toBe("010-****-5678");
    });

    it("passes through unknown fields unchanged", () => {
      const input = {
        subject: "My Document Title",
        custom_field: "some value",
      };
      const result = maskPiiFields(input);
      expect(result.subject).toBe("My Document Title");
      expect(result.custom_field).toBe("some value");
    });

    it("masks all 6 known PII field names", () => {
      const input = {
        substitute_name: "김철수",
        emergency_telephone: "010-9999-0000",
        emergency_address: "서울특별시 강남구",
        report_name: "이영희",
        report_leader: "박민준",
        ov_member: "홍길동, 김철수",
      };
      const result = maskPiiFields(input);
      expect(result.substitute_name).not.toBe("김철수");
      expect(result.emergency_telephone).toContain("****");
      expect(result.emergency_address).toContain("[MASKED]");
      expect(result.report_name).not.toBe("이영희");
      expect(result.report_leader).not.toBe("박민준");
      expect(result.ov_member).not.toBe("홍길동, 김철수");
    });
  });
});
