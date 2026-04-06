# IPK Browser MCP

MCP server for automating IPK groupware (gw.ip-korea.org) — form submission, document retrieval, and browser control via Playwright.

## 1. Quick Start

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `IPK_USERNAME` | Groupware login username | Yes |
| `IPK_PASSWORD` | Groupware login password | Yes |
| `IPK_BASE_URL` | Groupware base URL (default: `https://gw.ip-korea.org`) | No |
| `SCREENSHOT_DIR` | Directory for screenshots (default: `/tmp/ipk-screenshots`) | No |

### Configuration

Create `.env` at `~/.config/ipk-browser-mcp/.env`:

```env
IPK_USERNAME=your_username
IPK_PASSWORD=your_password
IPK_BASE_URL=https://gw.ip-korea.org
SCREENSHOT_DIR=/tmp/ipk-screenshots
```

### Install & Build

```bash
cd ipk-browser-mcp
npm install
npm run build
```

## 2. Workflow Sequence

```
┌─────────┐    ┌──────────────────┐    ┌──────────────┐    ┌────────────┐
│ 1. Login │───▶│ 2. Navigate/     │───▶│ 3. Submit    │───▶│ 4. Screen- │
│          │    │    Inspect       │    │    Form      │    │    shot    │
│ipk_login │    │ipk_navigate     │    │ipk_submit_   │    │ screenshot │
│          │    │ipk_inspect_form │    │  form        │    │            │
│          │    │ipk_get_content  │    │              │    │            │
└─────────┘    └──────────────────┘    └──────────────┘    └────────────┘
```

1. **Login** — Authenticate with `ipk_login` (uses env vars or explicit credentials)
2. **Navigate/Inspect** — Browse forms with `ipk_navigate`, inspect fields with `ipk_inspect_form`, read content with `ipk_get_content`
3. **Submit** — Fill and submit forms with `ipk_submit_form` (draft mode by default)
4. **Screenshot** — Capture current state with `screenshot` for verification

## 3. Tool Reference

| Tool | Description | Key Parameters | Output |
|------|-------------|---------------|--------|
| `ipk_login` | Authenticate to groupware | `username?`, `password?` | Session status |
| `ipk_navigate` | Navigate within main_menu iframe | `url` | Page content |
| `ipk_inspect_form` | Inspect form DOM elements | `form_code`, `compare_template?` | Field list + template diff |
| `ipk_submit_form` | Fill and submit a form | `form_type`, `draft_only?`, `confirm_submit?`, + form params | Doc ID, status |
| `ipk_get_content` | Extract page/iframe text | `selector?`, `include_forms?` | Sanitized text |
| `ipk_fetch_approvals` | List approval documents | `status?`, `page?` | Document list JSON |
| `screenshot` | Capture browser screenshot | `full_page?` | File path |

## 4. Form Cheatsheet

| form_type | AppFrm Code | Korean Name | Key Required Params |
|-----------|-------------|-------------|-------------------|
| `leave` | AppFrm-073 | 휴가신청 | `leave_type`, `start_date`, `end_date` |
| `expense` | AppFrm-020 | 경비지출 | `budget_code`, `amount`, `reason` |
| `working` | AppFrm-027 | 휴일근무 | `budget_code`, `work_date`, `reason` |
| `travel` | AppFrm-076 | 출장보고 | `title`, `destination`, `start_date`, `end_date` |
| `travel_request` | AppFrm-023 | 출장신청 | `budget_code`, `title`, `destination`, `start_date`, `end_date` |
| `budget_transfer` | AppFrm-039 | 예산전용 | `from_account`, `to_account`, `amount`, `reason` |
| `card_expense` | AppFrm-020 | 카드경비 | `budget_code`, `amount`, `reason` |
| `travel_settlement` | AppFrm-054 | 출장정산 | `budget_code`, `title`, `destination`, `start_date`, `end_date` |
| `leave_return` | AppFrm-028 | 대체휴일반납 | `leave_type`, `start_date`, `end_date` |
| `seminar` | AppFrm-043 | 세미나공시 | `title`, `date`, `location` |
| `overseas_travel` | AppFrm-026 | 해외출장 | `budget_code`, `title`, `destination`, `start_date`, `end_date`, `purpose` |

## 5. Examples

### Leave Request
```json
{ "form_type": "leave", "leave_type": "annual", "start_date": "2026-04-10", "end_date": "2026-04-10" }
```

### Expense Report
```json
{ "form_type": "expense", "budget_code": "NN2612-0001", "amount": 50000, "reason": "Lab supplies" }
```

### Working on Holiday
```json
{ "form_type": "working", "budget_code": "NN2612-0001", "work_date": "2026-04-12", "reason": "experiment" }
```

### Travel Report
```json
{ "form_type": "travel", "title": "Conference Report", "destination": "Seoul", "start_date": "2026-04-15", "end_date": "2026-04-16" }
```

### Travel Request
```json
{ "form_type": "travel_request", "budget_code": "NN2612-0001", "title": "Business Travel", "destination": "Daejeon", "start_date": "2026-04-20", "end_date": "2026-04-21" }
```

### Budget Transfer
```json
{ "form_type": "budget_transfer", "from_account": "420421", "to_account": "420375", "amount": 100000, "reason": "Reallocation for Q2" }
```

### Card Expense
```json
{ "form_type": "card_expense", "budget_code": "NN2612-0001", "amount": 15000, "reason": "Team lunch" }
```

### Travel Settlement
```json
{ "form_type": "travel_settlement", "budget_code": "NN2612-0001", "title": "Seoul Trip Settlement", "destination": "Seoul", "start_date": "2026-04-15", "end_date": "2026-04-16" }
```

### Leave Return
```json
{ "form_type": "leave_return", "leave_type": "compensatory", "start_date": "2026-04-10", "end_date": "2026-04-10" }
```

### Seminar Notice
```json
{ "form_type": "seminar", "title": "AI in Drug Discovery", "date": "2026-04-25", "location": "4th floor meeting room" }
```

### Overseas Travel
```json
{ "form_type": "overseas_travel", "budget_code": "NN2612-0001", "title": "International Conference", "destination": "Tokyo", "start_date": "2026-05-01", "end_date": "2026-05-03", "purpose": "Present research findings" }
```

## 6. Error Recovery

| Error Code | Meaning | Recovery Action |
|------------|---------|----------------|
| `NOT_LOGGED_IN` | No active session | Call `ipk_login` first |
| `SESSION_EXPIRING` | Session timeout imminent | Re-authenticate with `ipk_login` |
| `FRAME_NOT_FOUND` | main_menu iframe not found | Call `ipk_navigate` to load the form page first |
| `CONFIRMATION_REQUIRED` | Submission needs confirmation | Use `draft_only=true` for safe draft mode |
| `INVALID_ATTACHMENT` | Attachment file issue | Check file exists and path is in allowed directories |
| `MISSING_BUDGET_CODE` | Budget code not provided | Supply `budget_code` param (e.g., "NN2612-0001") |
| `FORM_NOT_FOUND` | Form type not recognized | Check `form_type` against the 11 supported types |

## 7. Attachment Rules

### Allowed Directories
- `/tmp`
- `~/Downloads`
- `~/Documents`
- `~/Desktop`

### Security Restrictions
- Attachments must be within allowed directories (no arbitrary path traversal)
- File size limits apply per groupware server configuration
- Supported formats depend on the specific form type
- Leave types requiring attachments: sick leave (진단서), special leave (증빙서류), paternity leave (출생증명서)
