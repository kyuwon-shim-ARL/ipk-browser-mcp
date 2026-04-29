# ipk-browser-mcp

Claude Code MCP plugin for IPK Groupware automation via Playwright.

Automates form submissions (leave, expense, travel, etc.) on the IPK groupware system through browser automation, exposed as MCP tools for Claude Code.

## Quick Start

### 1. Install Plugin (paste these into Claude Code)

Copy and paste these two commands directly into your Claude Code prompt:

```
/plugin marketplace add kyuwon-shim-ARL/ipk-browser-mcp
/plugin install ipk-browser-mcp@ipk-browser-mcp
```

The first command registers this repo as a self-marketplace; the second installs the plugin from it.

### 2. Configure Credentials (in a regular terminal, NOT in Claude Code)

> ⚠️ **Important:** Run this in a regular terminal — never inside Claude Code — so your password is never sent to the model API.

```bash
bash ~/.claude/plugins/cache/ipk-browser-mcp/ipk-browser-mcp/*/scripts/setup.sh
```

This prompts for your IPK groupware ID/password (input is hidden via `read -s`) and saves them to `~/.config/ipk-browser-mcp/.env` with `chmod 600`. Credentials never leave your machine.

### 3. Restart Claude Code

On next start, the plugin's `SessionStart` hook auto-installs Playwright Chromium (≈ 30 seconds, one-time).

### 4. Use

Ask Claude naturally:

```
"내일 연차 신청 초안 만들어줘"
"3월 26일 COEX 학회 출장 신청서 작성해줘"
"법인카드 회식비 50000원 카드경비 등록해줘"
"Submit annual leave for tomorrow"
```

Or invoke the conversational `/문서작성` skill for guided form filling.

## Updating the Plugin

When a new version is published, run these in Claude Code:

```
/plugin marketplace update ipk-browser-mcp
/plugin update ipk-browser-mcp@ipk-browser-mcp
```

Then restart Claude Code so the new MCP server bundle and hook are loaded.

## Requirements

- Claude Code with `/plugin` support
- Node.js ≥ 20 (Playwright dependency)
- IPK groupware account (only useful for IP Korea employees — `gw.ip-korea.org`)
- Linux or macOS (Windows untested)

## Supported Forms

| Form | `form_type` | AppFrm Code |
|------|-------------|-------------|
| Leave Request | `leave` | AppFrm-073 |
| R&D Expense Report | `expense` | AppFrm-021 |
| Holiday Work Request | `working` | AppFrm-027 |
| Travel Request | `travel_request` | AppFrm-023 |
| Travel Report | `travel` | AppFrm-076 |
| Budget Transfer (R&D) | `budget_transfer` | AppFrm-039 |
| Budget Transfer (General) | `budget_transfer` | AppFrm-053 |

## MCP Tools

| Tool | Description |
|------|-------------|
| `ipk_login` | Authenticate with IPK groupware |
| `ipk_submit_form` | Submit any supported form (draft or request) |
| `ipk_fetch_approvals` | Fetch approval/document lists |
| `ipk_navigate` | Navigate to a URL within IPK |
| `ipk_get_content` | Extract page content (text/HTML) |
| `screenshot` | Capture a screenshot of the current page |

## Safety

- **Draft-first**: All forms default to `draft_only=true`. No form is submitted for approval unless explicitly requested.
- **Confirm submit**: Even with `draft_only=false`, a `confirm_submit=true` flag is required to actually submit.
- **Credentials**: Stored locally at `~/.config/ipk-browser-mcp/.env` with 600 permissions. Never committed to git.
- **Session management**: Browser sessions auto-expire after 30 minutes of inactivity.
- **Parameterized evaluation**: All browser JS execution uses parameterized args to prevent injection.

## Configuration

Environment variables (set via `setup.sh` or in `.env`):

| Variable | Default | Description |
|----------|---------|-------------|
| `IPK_USERNAME` | (required) | Groupware login ID |
| `IPK_PASSWORD` | (required) | Groupware password |
| `IPK_BASE_URL` | `https://gw.ip-korea.org` | Groupware base URL |
| `BROWSER_HEADLESS` | `true` | Run browser headless |
| `SCREENSHOT_DIR` | `/tmp/ipk-mcp-screenshots` | Screenshot storage path |
| `SCREENSHOT_TTL_MINUTES` | `60` | Screenshot auto-cleanup TTL |
| `NAV_TIMEOUT_MS` | `30000` | Navigation timeout (ms) |
| `STORAGE_STATE_DIR` | `~/.config/ipk-mcp/profiles` | Session cookie storage |

## Project Structure

```
ipk-browser-mcp/
  src/
    index.ts              # MCP server entry point
    types.ts              # Types, form codes, config
    browser/
      session.ts          # Browser session management
      iframe-helper.ts    # iframe navigation & field helpers
    tools/
      ipk-login.ts        # Authentication handler
      ipk-submit.ts       # Form submission (all 6 types)
      ipk-fetch.ts        # Approval list fetcher
      ipk-navigate.ts     # URL navigation
      ipk-content.ts      # Page content extraction
      screenshot.ts       # Screenshot capture
    security/
      masking.ts          # Credential masking in logs
      sanitizer.ts        # Output sanitization
  dist/                   # Built bundle (ESM)
  package.json
scripts/
  setup.sh                # Credential setup wizard
  ensure-deps.mjs         # Auto-install playwright on session start
.claude-plugin/
  plugin.json             # Claude Code plugin manifest
  hooks/hooks.json        # SessionStart hook config
.mcp.json                 # MCP server configuration
FIELD_REFERENCE.md        # Form field mapping reference
docs/                     # Additional documentation
```

## Development

```bash
cd ipk-browser-mcp
npm install
npm run build        # Build with esbuild
npm run typecheck    # Type check without emit
npm run lint:security  # Check for unsafe evaluate patterns
```

Requires Node.js >= 20.

## License

MIT
