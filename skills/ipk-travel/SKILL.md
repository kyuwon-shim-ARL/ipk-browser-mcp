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

A domestic report is **not** a standalone document — it's written onto the already-approved
AppFrm-023 request itself (`travel_report_write.php`), which has no subject, destination or
period fields of its own (those are inherited, read-only text from the request). The old
"select the request from a pdoc_id dropdown on AppFrm-076" flow is now **overseas-only**.

1. **0-night check first.** A same-day (0-night) domestic trip gets no report — only
   2 nights (2박3일) or more does. The tool refuses with `NO_REPORT_FOR_DAY_TRIP` if you try
   anyway; don't draft one for a day trip.
2. **Baseline first** — before drafting, collect several of the department's approved travel
   reports of the same kind via `document_list.php?type=groupapproved` (optionally filtered
   by keyword), opened via `travel_report_view.php?doc_id=<linked request doc_id>`. Match
   section length and which items are included/omitted — a single personal document is not
   enough. State the baseline doc_ids when reporting back.
3. Don't ask the user for `request_doc_id` — the tool auto-looks it up from this person's own
   approved AppFrm-023/AppFrm-026 documents (narrow it with `request_keyword` if several
   trips could match; the tool refuses rather than guessing when 0 or >1 match). Only pass
   `request_doc_id` explicitly if the auto-lookup can't narrow it down.
4. `purpose`, `schedule` (→ agenda) and `reason` (→ result) must each be **≥100 characters**
   in English — the page's own `Check_Form()` rejects shorter values, and the tool refuses
   first with `TRAVEL_REPORT_FIELDS_MIN_LENGTH` naming which field(s) are short.
5. Confirm the actual expenses/evidence the user provides; never invent receipts or figures.
6. Submit with `draft_only: true`. There is no final-submit path on this page at all (its only
   save control is the page's own `[ Draft ]` button) — `NO_FINAL_SUBMIT` still applies.
7. For an **overseas** report, pass `report_kind: "overseas"` (or it's auto-detected when the
   linked request is AppFrm-026) — that path still uses the standalone AppFrm-076 form with
   `title`/`destination`/`start_date`/`end_date`.

### 5. Verify and report

Confirm the draft appears in the Drafts list, then show the screenshot. State the baseline doc_ids used.

## Safety

- Claude never submits for approval — only saves the draft. The person presses the approval-request button themselves.
- Never fabricate attachments, amounts, or itinerary details not supplied by the user or the groupware itself.
