---
name: ipk-travel
description: "IPK travel request (AppFrm-023) or travel report draft. Use when the user says \"travel request\", \"travel report\", \"출장신청\", \"출장보고\", \"출장\"."
---

# /ipk-travel - Travel Request / Travel Report (AppFrm-023 request / written onto AppFrm-023 domestic or AppFrm-022 overseas; AppFrm-076 standalone, explicit only)

Drafts a travel request (before the trip) or a travel report (after the trip) via the MCP tools in this plugin.

## Trigger

When user says: "travel request", "travel report", "출장신청", "출장보고", "출장", "출장 draft"

## Instructions

### 1. Profile check

If `ipk_profile_init` hasn't been run yet (or the tool returns `FORM_RULE_VIOLATION` on a self field), run it right after `ipk_login`.

### 2. Branch: request vs. report

If ambiguous (just "출장"/"travel"), ask whether this is a **request** (before the trip, `form_type: travel_request`, AppFrm-023) or a **report** (after the trip, `form_type: travel`, written onto the approved AppFrm-023 domestic / AppFrm-022 overseas request — AppFrm-076 only for the separate, explicit-only standalone path).

### A. Travel request (`form_type: travel_request`)

1. Collect from the user: destination, dates, purpose, transport mode, expected meals-served answer.
2. The tool itself can read the department's recent approved travel requests (`precedent: true`, the default) and will report where the draft departs from them — let it do this rather than fetching precedents by hand.
3. Budget code: the tool refuses a `budget_code` that differs from the writer's own recent precedent unless `budget_code_confirmed: true` is passed — don't just force that flag; confirm with the person that the new code is actually funded first.
4. Key params: `start_tm`/`end_tm`, `bound_code` (`19` within metro / `20` outside metro — Seoul counts as outside metro here), `working_code`, `province_code`/`city_code`, `travel_type_code`, `purpose_type`, `meals_served` (required when `bound_code` is `20`), `credit_card_no` (must be the traveler's own card, from their precedent documents, never typed in from memory).
5. Submit with `draft_only: true`.

### B. Travel report (`form_type: travel`)

Neither a domestic nor an overseas report is a standalone document — both are written onto
the already-approved travel request itself (`travel_report_write.php`: `&approve_type=AppFrm-023`
for domestic, no `&approve_type` at all for overseas), which has no subject, destination or
period fields of its own (those are inherited, read-only text from the request). The request
behind an overseas report is **AppFrm-022** (not AppFrm-026 — that's the overseas *settlement*,
a different form; `overseas_travel` in this plugin maps to it, see /ipk-document). The
"select the request from a pdoc_id dropdown on AppFrm-076" flow is a third, separate path —
`report_kind: "standalone"` — used only when explicitly asked for, never auto-detected.

1. **0-night check first — domestic only.** A same-day (0-night) domestic trip gets no
   report — only 2 nights (2박3일) or more does. The tool refuses with `NO_REPORT_FOR_DAY_TRIP`
   if you try anyway for a domestic report; don't draft one for a day trip. This pattern has
   **not** been established for overseas trips and is not applied to them.
2. **Baseline first** — before drafting, collect several of the department's approved travel
   reports of the same kind via `document_list.php?type=groupapproved` (optionally filtered
   by keyword), opened via `travel_report_view.php?doc_id=<linked request doc_id>` for domestic
   or `travel_report_view.php?doc_id=<026 settlement doc_id>&pop=Y` for overseas (colleagues'
   overseas reports are only observed via the settlement's own id — see the open question
   below). Match section length and which items are included/omitted — a single personal
   document is not enough. State the baseline doc_ids when reporting back.
   - **Mechanical gate**: before calling `ipk_submit_form` to save a draft, run
     `baseline_gate.gate(gw, "domestic_travel_report"|"overseas_travel_report", fields)`
     (`dev/baseline_gate.py`) yourself — it refuses a field longer than colleagues' p75. The
     MCP tool itself only enforces the page's own ≥100-char **minimum**
     (`TRAVEL_REPORT_FIELDS_MIN_LENGTH`); it does **not** check the p75 ceiling, so skipping
     this step is how an over-long report gets past every automated layer.
3. Don't ask the user for `request_doc_id` — the tool auto-looks it up from this person's own
   approved AppFrm-023/AppFrm-022 documents (narrow it with `request_keyword` if several
   trips could match; the tool refuses rather than guessing when 0 or >1 match). Only pass
   `request_doc_id` explicitly if the auto-lookup can't narrow it down. Either way, the
   request's real form code is resolved against the groupware itself, never guessed — an
   explicit `report_kind` that disagrees with it is refused (`REPORT_KIND_MISMATCH`), and a
   request that's neither AppFrm-023 nor AppFrm-022 is refused (`REQUEST_FORM_CODE_UNRESOLVED`).
4. `purpose`, `schedule` (→ agenda) and `reason` (→ result) must each be **≥100 characters**
   in English — the page's own `Check_Form()` rejects shorter values, and the tool refuses
   first with `TRAVEL_REPORT_FIELDS_MIN_LENGTH` naming which field(s) are short. This applies
   to **both** domestic and overseas reports.
5. Confirm the actual expenses/evidence the user provides; never invent receipts or figures.
6. Submit with `draft_only: true`. There is no final-submit path on this page at all (its only
   save control is the page's own `[ Draft ]` button) — `NO_FINAL_SUBMIT` still applies.
7. For an **overseas** report, pass `report_kind: "overseas"` (or it's auto-detected when the
   linked request resolves to AppFrm-022) — this writes onto the request at the same
   `travel_report_write.php` endpoint as domestic, just without `&approve_type`. The page may
   refuse with `REPORT_PAGE_UNAVAILABLE` (missing fields/Check_Form, e.g. a field-set mismatch
   not yet fully confirmed for this path) or `PERMISSION_DENIED` (a permission dialog on load).
   For the separate standalone AppFrm-076 form, pass `report_kind: "standalone"` explicitly —
   it needs `title`/`destination`/`start_date`/`end_date`.

**Open question**: if a report is written onto the AppFrm-022 request before any AppFrm-026
settlement exists for the trip, it's unknown whether that report later shows up when the
settlement is eventually filed — colleagues' overseas reports have only ever been observed
via the settlement's own id (`travel_report_view.php?doc_id=<026>&pop=Y`), never via the
request's id directly.

### 5. Verify and report

For a report written onto an approved request (domestic or overseas), it does not create its own Drafts-list entry — confirm by re-opening the request's report view (`travel_report_view.php?doc_id=<request doc_id>`) and checking the fields saved. For a standalone AppFrm-076 report, confirm it appears in the Drafts list. Then show the screenshot. State the baseline doc_ids used.

## Safety

- Claude never submits for approval — only saves the draft. The person presses the approval-request button themselves.
- Never fabricate attachments, amounts, or itinerary details not supplied by the user or the groupware itself.
