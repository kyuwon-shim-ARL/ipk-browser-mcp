---
name: ipk-overtime
description: "IPK weekend/holiday work application (AppFrm-074, form_type working) draft. Use when the user says \"overtime\", \"야근\", \"야근신청\", \"연장근무\", \"휴일근무\"."
---

# /ipk-overtime - Weekend/Holiday Work Application (AppFrm-074)

Drafts a weekend/holiday work (overtime) application via the MCP tools in this plugin.

## Trigger

When user says: "overtime", "야근", "야근신청", "연장근무", "야근 draft", "휴일근무"

## Important

This form is `form_type: working` → **AppFrm-074**. Do not confuse it with any facility-request form — only `working`/AppFrm-074 exists for this purpose in this plugin.

## Instructions

### 1. Profile check

If `ipk_profile_init` hasn't been run yet (or the tool returns `FORM_RULE_VIOLATION` on a self field), run it right after `ipk_login`.

### 2. Collect from the user

- Work date (default: today)
- Work rows: one or more `{date, hours}` entries — hours must be a whole number 1-12, and total hours per ISO week must not exceed 12
- Reason / work content (English, minimum 20 characters — the tool refuses shorter text)
- Whether a meal expense (ER) should be filed for this overtime

### 3. Auto-lookup (never ask the user for these)

- Approval line: match the person's own recently approved overtime documents
- Budget code: same as their recent precedent documents

### 4. Baseline

Pull a few of the department's recently approved AppFrm-074 documents via `document_list.php?type=groupapproved` to match field conventions and reason-text length before drafting. State the baseline doc_ids when reporting back.

### 5. Submit (draft)

```
mcp tool: ipk_submit_form
  form_type: working
  rows: [{date, hours}, ...]
  reason
  budget_code
  draft_only: true
```

### 6. Meal ER linkage (optional)

If the person also wants a meal expense ER for this overtime, draft that separately via `/ipk-card-er` (account 410903, Meal Allowance) and link this overtime document's doc_id into the ER form's document-select field — not the other way around.

### 7. Verify and report

Confirm the draft appears in the Drafts list, then show the screenshot.

## Safety

- Claude never submits for approval — only saves the draft. The person presses the approval-request button themselves.
