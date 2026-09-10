/**
 * What the travel request form (AppFrm-023) does with its own fields, written down so the
 * handler can refuse a combination the form would silently undo.
 *
 * Read from the form's selectBound() on 2026-09-10:
 *   bound_code 19 (within metro): hides province_code/city_code, clears province_code,
 *                                 forces working_code to 197. The document view then prints
 *                                 the bound label instead of a city.
 *   bound_code 20 (out of metro): shows province/city/travel_type and hides working_code;
 *                                 Check_Form_Request refuses without all three.
 *
 * doc 299905 and 299953 were drafted as 19 + Seoul/Seoul + 198: every select reported
 * "ok" and the document held none of it. The department's own approved requests use 20.
 */

export interface FormRuleViolation {
  code: string;
  message: string;
  fields: string[];
}

/** Attachment rows on AppFrm-023, in the order the form renders them. */
export const TRAVEL_DOC_SLOTS = {
  transport: "travel_doc_a[]",
  accommodation: "travel_doc_b[]",
  boarding: "travel_doc_c[]",
  etc: "travel_doc_d[]",
  verification: "travel_doc_e[]",
  poster: "travel_doc_f[]",
} as const;

export type TravelDocSlot = keyof typeof TRAVEL_DOC_SLOTS;

export function slotSelector(slot: TravelDocSlot): string {
  return `input[name="${TRAVEL_DOC_SLOTS[slot]}"]`;
}

/** "XXXX-XXXX-XXXX-XXXX" or 16 bare digits -> the four copcard boxes; null otherwise. */
export function parseCardNo(s: string): [string, string, string, string] | null {
  const digits = String(s ?? "").replace(/[-\s]/g, "");
  if (!/^\d{16}$/.test(digits)) return null;
  return [digits.slice(0, 4), digits.slice(4, 8), digits.slice(8, 12), digits.slice(12, 16)];
}

export function checkTravelRequestParams(p: Record<string, any>): FormRuleViolation[] {
  const out: FormRuleViolation[] = [];
  const bound = p.bound_code == null ? "" : String(p.bound_code);
  const hasProvince = !!(p.province_code || p.city_code);

  if (bound === "19") {
    if (hasProvince) {
      out.push({
        code: "BOUND_HIDES_PROVINCE",
        fields: ["bound_code", "province_code", "city_code"],
        message:
          "bound_code '19' (within metro) hides and clears province_code/city_code; the document " +
          "would show only 'Within Metropolitan'. Use bound_code '20' to name a province and city.",
      });
    }
    if (p.working_code && String(p.working_code) !== "197") {
      out.push({
        code: "BOUND_FORCES_WORKING_CODE",
        fields: ["bound_code", "working_code"],
        message: `bound_code '19' forces working_code to '197'; '${p.working_code}' would be overwritten. Omit working_code or use '197'.`,
      });
    }
  } else if (bound === "20") {
    if (!(p.province_code && p.city_code && p.travel_type_code)) {
      out.push({
        code: "BOUND_NEEDS_PROVINCE",
        fields: ["province_code", "city_code", "travel_type_code"],
        message: "bound_code '20' (out of metro) requires province_code, city_code and travel_type_code; the form refuses without them.",
      });
    }
    // Out-of-metro trips carry a food allowance, and the form asks whether meals are
    // provided ("How many meals are served?"). That is a fact about the trip, not a default.
    if (p.meals_served == null || p.meals_served === "") {
      out.push({
        code: "MEALS_REQUIRED",
        fields: ["meals_served"],
        message: "bound_code '20' asks whether meals are provided on the trip. Pass meals_served: 'N', or the number of meals served (1-30).",
      });
    } else if (!(String(p.meals_served) === "N" || /^([1-9]|[12]\d|30)$/.test(String(p.meals_served)))) {
      out.push({
        code: "MEALS_MALFORMED",
        fields: ["meals_served"],
        message: `meals_served must be 'N' or a count 1-30, not '${p.meals_served}'.`,
      });
    }
    if (p.working_code) {
      out.push({
        code: "BOUND_HIDES_WORKING_CODE",
        fields: ["bound_code", "working_code"],
        message: "bound_code '20' hides working_code; a value set there is not part of the document. Omit it.",
      });
    }
  }

  if (p.attachment_path || (Array.isArray(p.attachment_paths) && p.attachment_paths.length)) {
    const slot = p.attachment_slot;
    const names = Object.keys(TRAVEL_DOC_SLOTS).join(", ");
    if (!slot) {
      out.push({
        code: "ATTACHMENT_SLOT_REQUIRED",
        fields: ["attachment_slot"],
        message: `travel_request has six attachment rows (${names}). Say which one with attachment_slot; the file is not guessed into the first row.`,
      });
    } else if (!(slot in TRAVEL_DOC_SLOTS)) {
      out.push({
        code: "ATTACHMENT_SLOT_UNKNOWN",
        fields: ["attachment_slot"],
        message: `attachment_slot '${slot}' is not a row on this form. Rows: ${names}.`,
      });
    }
  }

  if (p.credit_card_no != null && p.credit_card_no !== "" && !parseCardNo(String(p.credit_card_no))) {
    out.push({
      code: "CARD_NO_MALFORMED",
      fields: ["credit_card_no"],
      message: "credit_card_no must be 16 digits (e.g. XXXX-XXXX-XXXX-XXXX).",
    });
  }

  return out;
}
