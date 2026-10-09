---
name: ipk-card-er
description: "IPK corporate card expense report (AppFrm-021) draft or preview from a card transaction. Use when the user says \"card er\", \"카드 er\", \"카드 경비\", \"baemin er\", \"배민 er\", \"식대 er\", \"법인카드 정산\"."
---

# /ipk-card-er - Corporate Card Expense Report (AppFrm-021)

Fills a corporate-card R&D expense report (card ER) from an unprocessed card transaction, via the MCP tools in this plugin.

## Trigger

When user says: "card er", "카드 er", "카드 경비", "baemin er", "배민 er", "식대 er", "법인카드 정산"

## Instructions

### 1. Profile check

If `ipk_profile_init` hasn't been run on this machine yet (or `ipk_submit_form` returns `FORM_RULE_VIOLATION` naming a self field like `card_no`/`budget_code`), run `ipk_profile_init` right after `ipk_login`. It reads the person's own cards and budget pots (read-only) into `~/.config/ipk-browser-mcp/profile.json`.

### 2. Auto-lookup the card transaction

Never ask the user for `trseq` or `appr_no` — look them up first:

```
ipk_navigate (or ipk_get_content) → corporation_card_list.php
```

Parse the unprocessed-transaction rows for the matching vendor/date/amount, and read `trseq` + `appr_no` off that row's "Make ER" link. Only rows with that link are unprocessed.

### 3. Baseline first

Before drafting, pull several of the department's recently approved card ERs of the same kind (`document_list.php?type=groupapproved` — never `type=approved` (own docs only) or `type=group` (always empty)) and match their field values, free-text length, and included/omitted items. Don't draft from one person's document alone. State the baseline doc_ids when reporting back.

### 4. Account code and VAT

| Purpose | account_code | account_str |
|---|---|---|
| Overtime meal | 410903 | Meal Allowance |
| IT subscription | 410318 | IT Software (IT Subscription) |
| Team activities | ask the person — org policy requires the department's specific team-activity account and card; don't guess |

VAT handling:
- **Overseas IT subscriptions** (RunPod, cloud APIs, SaaS, etc.): VAT = 0, excl.-VAT amount = total. Do not split — splitting causes double taxation and rework.
- **Domestic vendors** (e.g. food delivery): split VAT normally from the receipt.

Team-activity / meeting accounts require `venue`, `meeting_begin`/`meeting_end` (`YYYY-MM-DD HH:MM`), `participants`, `purpose_minutes` — the tool's org-policy check refuses the submission without them.

If the meal ER follows an overtime approval, link the overtime document: look it up via `document_list.php?type=groupapproved` by date and pass its doc_id through the form's document-select field.

### 5. Attachments

Confirm required files are available (ask the user only for files they must supply themselves — never fabricate financial documents):
- Overseas IT subscriptions (AppFrm-021 R&D ER via card, `form_type: card_expense_rd`): invoice (signed), card statement, daily usage log (if applicable), receipt.
- Domestic card expenses: the receipt/screenshot for the transaction.

Pass file paths via `attachment_path` / `attachment_paths`.

### 6. Submit (draft/preview only)

```
mcp tool: ipk_submit_form
  form_type: card_expense_rd   (or card_expense for AppFrm-020)
  trseq / appr_no
  item_name, seller_en, account_code_label
  budget_code
  draft_only: true   (always — see Safety)
```

**card_expense_rd (mker=Y) has no draft state: saving = submitting for approval.** `draft_only: true` instead returns a no-save **preview** — the filled form's own validation, the `[Card]`-prefixed subject, and a screenshot — without saving anything. Show this preview to the person; they decide whether to save (which immediately submits) themselves.

For plain `card_expense` (AppFrm-020), `draft_only: true` does save an actual draft — confirm it shows up in the Drafts list before reporting it saved.

## Safety

- Claude never submits for approval. `draft_only: false` is refused by the tool unless `confirm_submit: true` **and** the operator has set `IPK_ALLOW_SUBMIT=1`. For every other form it then still only saves a draft. **card_expense_rd is the exception: with that switch on, saving really does submit for approval.** So for card ERs always use `draft_only: true` (preview) and let the person save it themselves; never suggest setting `IPK_ALLOW_SUBMIT`.
- Never invent amounts, vendors, or receipts. Only use files and figures the user actually provided or the groupware itself returned.
