# ipk-browser-mcp

Claude Code MCP plugin for IPK Groupware automation via Playwright.

Automates form submissions (leave, expense, travel, etc.) on the IPK groupware system through browser automation, exposed as MCP tools for Claude Code.

## Quick Start

### 1. Install Plugin

Install from Claude Code marketplace or clone:

```bash
git clone https://github.com/kyuwon-shim-ARL/ipk-browser-mcp.git
```

### 2. Setup Credentials

Run in a **separate terminal** (not inside Claude Code):

```bash
bash scripts/setup.sh
```

This prompts for your IPK groupware ID/password and saves to `~/.config/ipk-browser-mcp/.env` (chmod 600).

### 3. Restart Claude Code

The plugin auto-installs Playwright on first session start via the `SessionStart` hook.

### 4. Use

Ask Claude naturally:

```
"Submit annual leave for tomorrow"
"File an expense report for overtime meal, 15000 won"
"Draft a travel request for March 26"
```

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
