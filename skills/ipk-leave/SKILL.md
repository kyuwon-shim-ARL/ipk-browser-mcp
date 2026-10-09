---
name: ipk-leave
description: "IPK leave request (AppFrm-073): annual, half-day or hourly leave draft. Use when the user says \"leave\", \"연차\", \"반차\", \"연차신청\", \"휴가\", \"육아시간\", \"시간연차\"."
---

# /ipk-leave - Leave / Half-day / Hourly Leave Request (AppFrm-073)

Drafts a leave request via the MCP tools in this plugin.

## Trigger

When user says: "leave", "연차", "반차", "연차신청", "휴가", "육아시간", "시간연차"

## Instructions

### 1. Profile check

If `ipk_profile_init` hasn't been run yet (or the tool returns `FORM_RULE_VIOLATION` on a self field), run it right after `ipk_login`.

### 2. Collect from the user

- Date (default: today, if the user doesn't say otherwise)
- Leave type: annual / morning half-day / afternoon half-day / hourly leave (e.g. childcare hours)
- For hourly leave: start/end time and reason

### 3. Auto-lookup (never ask the user for these)

- Remaining leave balance: from the groupware's own leave-balance page
- Approval line: match the pattern on the person's own recently approved leave documents

### 4. Baseline

Pull a few of the department's recently approved leave requests of the same type via `document_list.php?type=groupapproved` to confirm field conventions before drafting. State the baseline doc_ids when reporting back.

### 5. Submit (draft)

```
mcp tool: ipk_submit_form
  form_type: leave
  leave_type: <annual | compensatory | sick | paternity | ...>
  start_date / end_date
  start_time / end_time   (hourly leave only)
  substitute_name
  draft_only: true
```

For sick / special / paternity leave, remind the user about the required attachment (medical certificate / supporting document / birth certificate) before drafting.

### 6. Verify and report

Confirm the draft appears in the Drafts list (not "submitted" — if it shows as submitted, repossess it immediately), then show the screenshot.

## Safety

- Claude never submits for approval — only saves the draft. The person presses the approval-request button themselves.
- Never guess leave balance or approval-line values that the groupware can supply.
