import { describe, it, expect } from "vitest";
import {
  checkTravelRequestParams,
  TRAVEL_DOC_SLOTS,
  slotSelector,
  parseCardNo,
} from "../../src/forms/travel-request.js";

describe("bound_code combinations (what AppFrm-023's selectBound() actually does)", () => {
  it("refuses province/city under 관내 (19): the form hides and clears them", () => {
    const v = checkTravelRequestParams({ bound_code: "19", province_code: "02", city_code: "192" });
    expect(v.map((x) => x.code)).toContain("BOUND_HIDES_PROVINCE");
  });
  it("refuses working_code other than 197 under 관내: the form forces 197", () => {
    const v = checkTravelRequestParams({ bound_code: "19", working_code: "198" });
    expect(v.map((x) => x.code)).toContain("BOUND_FORCES_WORKING_CODE");
  });
  it("accepts 관내 with working_code 197 or omitted", () => {
    expect(checkTravelRequestParams({ bound_code: "19", working_code: "197" })).toEqual([]);
    expect(checkTravelRequestParams({ bound_code: "19" })).toEqual([]);
  });
  it("requires province, city and transport under 관외 (20) and refuses working_code there", () => {
    const v = checkTravelRequestParams({ bound_code: "20", working_code: "198" });
    const codes = v.map((x) => x.code);
    expect(codes).toContain("BOUND_NEEDS_PROVINCE");
    expect(codes).toContain("BOUND_HIDES_WORKING_CODE");
  });
  it("accepts the department's actual practice: 관외 + Seoul/Seoul + public transport + no meals", () => {
    expect(
      checkTravelRequestParams({ bound_code: "20", province_code: "02", city_code: "192", travel_type_code: "03", meals_served: "N" })
    ).toEqual([]);
  });
  it("관외 without meals_served is refused: the form asks and the tool must not guess", () => {
    const v = checkTravelRequestParams({ bound_code: "20", province_code: "02", city_code: "192", travel_type_code: "03" });
    expect(v.map((x) => x.code)).toEqual(["MEALS_REQUIRED"]);
    expect(checkTravelRequestParams({ bound_code: "20", province_code: "02", city_code: "192", travel_type_code: "03", meals_served: "2" })).toEqual([]);
    expect(checkTravelRequestParams({ bound_code: "20", province_code: "02", city_code: "192", travel_type_code: "03", meals_served: "yes" })[0].code).toBe("MEALS_MALFORMED");
  });
});

describe("attachment slots", () => {
  it("maps every named slot to its own file input", () => {
    expect(TRAVEL_DOC_SLOTS.verification).toBe("travel_doc_e[]");
    expect(TRAVEL_DOC_SLOTS.transport).toBe("travel_doc_a[]");
    expect(slotSelector("verification")).toBe('input[name="travel_doc_e[]"]');
  });
  it("an attachment on this form without a slot is refused, not guessed into the first slot", () => {
    const v = checkTravelRequestParams({ bound_code: "20", province_code: "02", city_code: "192", travel_type_code: "03", meals_served: "N", attachment_path: "/x.pdf" });
    expect(v.map((x) => x.code)).toEqual(["ATTACHMENT_SLOT_REQUIRED"]);
  });
  it("an unknown slot name is refused with the list", () => {
    const v = checkTravelRequestParams({ attachment_path: "/x.pdf", attachment_slot: "receipts" });
    expect(v[0].code).toBe("ATTACHMENT_SLOT_UNKNOWN");
    expect(v[0].message).toContain("verification");
  });
});

describe("corporate card number", () => {
  it("splits 16 digits into the four copcard boxes", () => {
    expect(parseCardNo("XXXX-XXXX-XXXX-XXXX")).toEqual(["5525", "7642", "1492", "9594"]);
    expect(parseCardNo("XXXX-XXXX-XXXX-XXXX")).toEqual(["5525", "7642", "1492", "9594"]);
  });
  it("rejects anything that is not 16 digits", () => {
    expect(parseCardNo("5525-7642-1492")).toBeNull();
    expect(parseCardNo("")).toBeNull();
  });
  it("a malformed credit_card_no is refused before the form is touched", () => {
    const v = checkTravelRequestParams({ credit_card_no: "1234" });
    expect(v.map((x) => x.code)).toContain("CARD_NO_MALFORMED");
  });
});
