---
name: ipk-travel
description: "IPK travel request (AppFrm-023) or travel report draft. Use when the user says \"travel request\", \"travel report\", \"출장신청\", \"출장보고\", \"출장\"."
---

# /ipk-travel - Travel Request / Travel Report (AppFrm-023 / AppFrm-076)

Drafts a travel request (before the trip) or a travel report (after the trip) via the MCP tools in this plugin.

## Trigger

When user says: "travel request", "travel report", "출장신청", "출장보고", "출장", "출장 draft"

## Instructions

### 1. Profile check

If `ipk_profile_init` hasn't been run yet (or the tool returns `FORM_RULE_VIOLATION` on a self field), run it right after `ipk_login`.

### 2. Branch: request vs. report

If ambiguous (just "출장"/"travel"), ask whether this is a **request** (before the trip, `form_type: travel_request`, AppFrm-023) or a **report** (after the trip, `form_type: travel`, AppFrm-076).

### A. Travel request (`form_type: travel_request`)

1. Collect from the user: destination, dates, purpose, transport mode, expected meals-served answer.
2. The tool itself can read the department's recent approved travel requests (`precedent: true`, the default) and will report where the draft departs from them — let it do this rather than fetching precedents by hand.
3. Budget code: the tool refuses a `budget_code` that differs from the writer's own recent precedent unless `budget_code_confirmed: true` is passed — don't just force that flag; confirm with the person that the new code is actually funded first.
4. Key params: `start_tm`/`end_tm`, `bound_code` (`19` within metro / `20` outside metro — Seoul counts as outside metro here), `working_code`, `province_code`/`city_code`, `travel_type_code`, `purpose_type`, `meals_served` (required when `bound_code` is `20`), `credit_card_no` (must be the traveler's own card, from their precedent documents, never typed in from memory).
5. Submit with `draft_only: true`.

### B. Travel report (`form_type: travel`)

1. **Baseline first** — before drafting, collect several of the department's approved travel reports of the same kind via `document_list.php?type=groupapproved` (optionally filtered by keyword), opened via `travel_report_view.php?doc_id=<linked request doc_id>`. Match section length and which items are included/omitted — a single personal document is not enough. State the baseline doc_ids when reporting back.
2. Auto-look-up the related travel request doc_id (search `document_list.php?type=approved` by date/title) rather than asking the user for it.
3. Confirm the actual expenses/evidence the user provides; never invent receipts or figures.
4. Submit with `draft_only: true`, with the request doc_id linked via document-select.

For a 0-night/1-day domestic trip, a travel report is usually not required — check with the person before drafting one.

### 5. Verify and report

Confirm the draft appears in the Drafts list, then show the screenshot. State the baseline doc_ids used.

## Safety

- Claude never submits for approval — only saves the draft. The person presses the approval-request button themselves.
- Never fabricate attachments, amounts, or itinerary details not supplied by the user or the groupware itself.
