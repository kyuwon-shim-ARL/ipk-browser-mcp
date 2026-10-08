# IPK Browser MCP — Architecture

## Overview

Python-primary architecture: the Python layer owns all NL classification, field inference, and
generic pipeline logic. TypeScript (TS) provides the MCP deployment interface and manages the
Playwright browser session (login state, cookies). The two layers communicate over a Python
subprocess stdio JSON-RPC bridge.

---

## Layer Diagram

```
User / Claude Code
     │
     ▼
/문서작성 skill (skills/문서작성/skill.md)
     │  natural language input
     ▼
Python subprocess (stdio JSON-RPC)
     │  JSON request: {"id":"1","method":"infer_fields","params":{...}}
     ▼
document_agent.py / pipeline.py
     │  SmartFormAgent classification + field inference
     ▼
ipk_gw.py (Playwright automation)
     │
     ▼
IPK Groupware (https://gw.ip-korea.org)
```

---

## Layer Responsibilities

### TS MCP Layer (`ipk-browser-mcp/src/`)

- **Deployment interface**: exposes MCP tools to Claude Code via `@modelcontextprotocol/sdk`
- **Playwright session management**: login, cookie/storage-state persistence, screenshot capture
- **Routing**: dispatches tool calls to implemented TS handlers or stub handlers (NOT_IMPLEMENTED)
- **form-registry.ts**: single source of truth for `FormType ↔ AppFrmCode` mapping; emits
  `form-registry.json` at build time for Python layer consumption

### Python Layer (`document_agent.py`, `pipeline.py`, `ipk_gw.py`)

- **NL classification** (`SmartFormAgent`): maps free-text requests to a `FormType`
- **Field inference** (`inference_engine`): extracts structured field values from natural language
- **Generic pipeline** (`load_template → infer_fields → fill_form`): template-driven form filling
  for all registered form types
- **Playwright automation** (`ipk_gw.py`): low-level browser interactions with IPK Groupware

---

## Bridge: Python Subprocess stdio JSON-RPC

The TS layer spawns a Python subprocess and communicates via stdin/stdout:

```
TS process
  │  stdin  ──→  {"id":"1","method":"infer_fields","params":{"formType":"travel_request","text":"..."}}
  │  stdout ←──  {"id":"1","result":{"fields":{...}}}
Python subprocess (document_agent.py)
```

- **Transport**: newline-delimited JSON over stdio (no HTTP, no sockets)
- **Methods**: `infer_fields`, `fill_form`, `classify_form`
- **Error handling**: Python returns `{"id":"...","error":{"code":-32603,"message":"..."}}` on failure

---

## Shared Registry: form-registry.json

Single source of truth flow:

```
form-registry.ts  (TS, hand-edited)
      │
      │  build step (tsc / generate script)
      ▼
form-registry.json  (committed, Python-readable)
      │
      ▼
Python layer loads at startup (json.load)
```

- TS consumers import `FORM_REGISTRY` directly from `form-registry.ts`
- Python consumers load `form-registry.json` at runtime
- **Never edit `form-registry.json` by hand** — regenerate from `form-registry.ts`

---

## Stub Handlers (`ipk-submit.ts`)

The 5 new `FormType` values added for the Python bridge are currently stubs in the TS layer:

```typescript
// TODO(T6): replace with Python bridge call once bridge is implemented
case "travel_settlement":
case "leave_return":
case "card_expense":
case "seminar":
case "overseas_travel":
  return makeError("NOT_IMPLEMENTED", `Form type '${formType}' pending Python bridge (T6)`);
```

After T6 completes, each stub is replaced with a bridge call:
`spawnPythonBridge("fill_form", { formType, fields })`.

---

## Form Onboarding Workflow

When adding a new IPK form (an `AppFrm-XXX` not yet in `form_templates/`), follow
**template-first**: declarative knowledge in JSON drives the existing generic pipeline.

```
[1] Explore     ipk_inspect_form (MCP, src/tools/ipk-inspect.ts)
                  │  selectors, iframe nesting, ajax cascade, submit_flow stages
                  ▼
[2] Persist     form_templates/AppFrm-XXX.json     ← single source of truth
                  │  (NOT skills/문서작성/skill.md — skill is workflow-only)
                  ▼
[3] Verify      tests/forms/test_<appfrm>_draft.py (E2E gate)
                  │  login → draft submit → document_view.php?...&type=drafts
                  ▼
[4] Execute     document_agent.py / pipeline.py (generic submitter)
                  │  load_template → infer_fields → fill_form
                  ▼
[5] Fallback    Per-form submit_*.py only when generic cannot handle.
                Treated as a signal to extend the generic submitter;
                keep the JSON template in sync with any .py knowledge.
```

**Anti-pattern**: writing a new ~400-line `submit_*.py` per form.
`submit_runpod_er.py` is 426 lines because it bypasses generic to handle
AppFrm-021 `mker=Y` approval popups (43 raw `frame.evaluate` / `gw.page` calls).
When this happens, the popup flow belongs in the generic submitter, not
duplicated per form.

**Why declarative wins**: `ipk_inspect_form` outputs structure (selectors, fields,
submit flow). Storing it as JSON keeps one form ↔ one source. Storing it as
imperative Python forks the knowledge between `form_templates/AppFrm-XXX.json`
and `submit_*.py`, with no sync mechanism (DRY violation; IPK DOM changes
silent-fail in both places).

---

## Security Design

| Concern | Mechanism |
|---|---|
| Accidental submission | `draft_first: true` default — all forms saved as draft before final submit |
| Double confirmation | `confirm_submit` flag must be explicitly set to `true` to transition draft → request |
| PII in logs | Field values containing passwords/tokens are masked before logging |
| Credentials storage | Stored locally in `~/.config/ipk-browser-mcp/.env` (not in repo) |
| Session persistence | Playwright storage state saved to `~/.config/ipk-mcp/profiles/` (local only) |
