/**
 * script_values -> ipk_submit_form params, per form_type.
 *
 * Alias tables below are built from the ACTUAL key names observed in
 * replay/corpus_structured.json (not guessed from the DOM/zod names alone - the corpus
 * producer used its own key vocabulary per script, e.g. "period_start" for leave,
 * "travel_dest[0]" for travel_request). Anything not in a table is reported as unmapped
 * rather than guessed at. Three kinds of key are deliberately left unmapped, always:
 *   - a person's own payroll/position/contact (e.g. substitute_payroll_no) - the tool
 *     only ever gets this from the groupware's own substitute picker, never typed
 *     directly (fabrication risk); see ipk-submit.ts's SUBSTITUTE_POPUP_FAILED comment.
 *   - informational/derived figures the groupware computes itself (daily_pay, night,
 *     days, item_amount[1] etc. - prefilled_by_system per form_templates/*.json).
 *   - workflow bookkeeping (mode1, approve_type, p_doc_id-as-url-param, *_match helpers).
 */

function applyAliases(scriptValues, aliasTable) {
  const params = {};
  const unmapped = [];
  for (const [k, v] of Object.entries(scriptValues || {})) {
    const paramName = aliasTable[k];
    if (paramName) params[paramName] = v;
    else unmapped.push(k);
  }
  return { params, unmapped };
}

export function adaptLeave(scriptValues) {
  const { params, unmapped } = applyAliases(scriptValues, {
    leave_kind: "leave_type",
    period_start: "start_date",
    period_end: "end_date",
    start_hour: "start_time",
    end_hour: "end_time",
    purpose_for_leave: "reason",
    // substitute_present (bool) and substitute_payroll_no are deliberately NOT mapped:
    // there is no substitute_name in this corpus's script_values, and the payroll number
    // alone cannot be typed in as a name without fabricating one.
  });
  return { form_type: "leave", params: { ...params, draft_only: true, dry_run: true }, unmapped };
}

export function adaptTravelRequest(scriptValues) {
  const { params, unmapped } = applyAliases(scriptValues, {
    subject: "subject",
    bound_code: "bound_code",
    working_code: "working_code",
    province_code: "province_code",
    purpose_type: "purpose_type",
    purpose: "purpose",
    matrials: "matrials",
    start_date: "start_date",
    end_date: "end_date",
    start_tm: "start_tm",
    end_tm: "end_tm",
    "travel_dest[0]": "destination",
    food_yn: "meals_served",
    budget_type: "budget_type",
    budget_code: "budget_code",
    // copcard1-4 (card number split across 4 fields): not mapped - credit_card_no wants
    // one 16-digit string and splicing 4 numeric fragments back together risks an error
    // nobody would notice. city_code_match/travel_type_code_match/item_no_match/
    // project_code/er_row_cnt/night/days/daily_* /notes/fin_support_type/approve_type:
    // either *_match validation helpers, groupware-computed figures, or workflow
    // bookkeeping, not direct form inputs.
  });
  return {
    form_type: "travel_request",
    params: { ...params, draft_only: true, dry_run: true, precedent: false },
    unmapped,
  };
}

export function adaptTravelSettlement(scriptValues) {
  const { params, unmapped } = applyAliases(scriptValues, {
    subject: "subject",
    p_doc_id: "approved_doc_ref",
    // prefilled_verified_only holds values the groupware itself prefills from the parent
    // request once approved_doc_ref is set - not separate inputs to pass; mode1/
    // approve_type are workflow bookkeeping.
  });
  return { form_type: "travel_settlement", params: { ...params, draft_only: true, dry_run: true }, unmapped };
}

export function adaptCardExpenseRd(scriptValues) {
  const { params, unmapped } = applyAliases(scriptValues, {
    trseq: "trseq",
    appr_no: "appr_no",
    budget_type: "budget_type",
    budget_code: "budget_code",
    subject: "subject",
    "item_name[1]": "item_name",
    item_name: "item_name",
    "seller[1]": "seller_en",
    "account_str[1]": "account_code_label",
    p_reason: "notes",
    notes: "notes",
    org_name: "event_name",
    dmex_se_cd: "event_type",
    organizer_nm: "organizer",
    edu_start_day: "event_start",
    edu_end_day: "event_end",
    // account_code[1]/account_seq[1] (internal popup codes), item_qty/item_amount* and
    // invoice[1] (prefilled_by_system per form_templates/AppFrm-021.json), vender[1]
    // (Korean legal name - seller_en wants the English name, already supplied
    // separately), card_no/edu_member (the writer's own card/name - system-prefilled,
    // never typed), item_desc[1]: left unmapped.
  });
  return { form_type: "card_expense_rd", params: { ...params, draft_only: true, dry_run: true }, unmapped };
}

export function adaptBudgetTransfer(scriptValues) {
  const { params, unmapped } = applyAliases(scriptValues, {
    subject: "subject",
    budget_code: "budget_code",
    source_account_match: "from_budget_code",
    target_account_match: "to_budget_code",
    amount1: "transfer_amount",
    contents_data: "reason",
    // approve_type/request_type/mode1: workflow bookkeeping, not form inputs.
  });
  // transfer_amount is z.number() - the corpus carries it as a numeric string.
  if (typeof params.transfer_amount === "string") params.transfer_amount = Number(params.transfer_amount);
  return { form_type: "budget_transfer", params: { ...params, draft_only: true, dry_run: true }, unmapped };
}

export const ADAPTERS = {
  leave: adaptLeave,
  travel_request: adaptTravelRequest,
  travel_settlement: adaptTravelSettlement,
  card_expense_rd: adaptCardExpenseRd,
  budget_transfer: adaptBudgetTransfer,
};

export function adaptDoc(doc) {
  const adapter = ADAPTERS[doc.form_type];
  if (!adapter) return { form_type: doc.form_type, params: null, unmapped: Object.keys(doc.script_values || {}) };
  return adapter(doc.script_values);
}
