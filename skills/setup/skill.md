# IPK Browser MCP Setup

Configure IPK Groupware credentials securely.

## Trigger

When user says: "ipk setup", "setup ipk", "configure ipk", "ipk 설정"

## Instructions

**IMPORTANT: Never ask the user to type their password in Claude Code.** Credentials must be entered in a regular terminal to avoid API transmission.

### Guide the user

Tell the user to open a **separate terminal** (not Claude Code) and run:

```bash
bash ~/.claude/plugins/cache/*/ipk-browser-mcp/*/scripts/setup.sh
```

If that path doesn't work (plugin not installed yet), they can also run from the repo:

```bash
bash /path/to/ipk-browser-mcp/scripts/setup.sh
```

### What the script does

1. Prompts for IPK username and password (`read -s` hides password)
2. Saves to `~/.config/ipk-browser-mcp/.env` with chmod 600
3. The MCP server loads this file automatically on next session start

### After setup

Tell the user to restart Claude Code. Then they can use:
- `ipk_login` — log into IPK groupware
- `ipk_submit_form` — submit leave, expense, working, or travel forms

### Security Notes

- NEVER ask for password directly in the Claude Code conversation
- NEVER use Bash tool to write credentials
- The setup script uses `read -s` so password is not visible on screen
- Credentials are stored at `~/.config/ipk-browser-mcp/.env` (mode 600, outside any git repo)
