# Dev Scripts

Exploration, analysis, and one-off scripts used during development of `ipk-browser-mcp`.

**These are NOT part of the published Claude Code plugin distribution.** The plugin distributes only:
- `ipk-browser-mcp/` — TypeScript MCP server with prebuilt `dist/`
- `skills/` — Claude Code skills (MCP-only, no Python deps required for end users)
- `scripts/` — `setup.sh` + `ensure-deps.mjs`
- `.claude-plugin/` — plugin manifest + marketplace entry

Files here are kept as developer references and historical exploration. They depend on Python packages declared in the repo-root `pyproject.toml` (`keyring`, `playwright`, etc.).

## Running

Always run with `cwd = repo root`. Most scripts read data from `analysis_results/` and `form_templates/` at the repo root via relative paths.

```bash
# install Python deps once
uv sync   # or: pip install -e .

# example
python3 dev/analyze_travel_request_patterns.py
python3 dev/document_agent.py smart "내일 연차 신청"
```

## Cross-imports

Scripts in this folder import each other (e.g. `from ipk_gw import IPKGroupware`). Keep them in the same directory so imports keep working.

## What's here

- `ipk_gw.py` — core groupware client (Playwright wrapper) used by every other script
- `pipeline.py` / `bridge.py` / `document_lookup.py` — form-template orchestration
- `form_utils.py` — JS escape + DOM helpers
- `document_agent.py` — natural-language → form classifier (legacy; the `/문서작성` skill no longer uses this)
- `analyze_*.py` — pattern mining over historical groupware documents
- `fetch_*.py` — bulk document scrapers
- `submit_*.py` / `capture_*.py` / `discover_*.py` / `explore_*.py` — exploratory and per-form helpers
- `email_capture.py` — Gmail API capture utility
- `sign_invoice.py` / `fix_runpod_er_attachments.py` — RunPod ER attachment helpers
- `history_manager.py` — local approval-history cache
- `verify_live.py` / `test_leave.py` — local smoke tests
