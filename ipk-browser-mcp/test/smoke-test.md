# Smoke Test Protocol

## Prerequisites
- IPK_USERNAME and IPK_PASSWORD set as environment variables
- VPN connected to IPK network
- `npx playwright install chromium` completed

## Test 1: Login
```
Tool: ipk_login
Expected: { error: false, data: { loggedIn: true, sessionId: "default" } }
```

## Test 2: Navigate
```
Tool: ipk_navigate
Params: { url: "/Document/document_list.php?mtype=user&stype=write" }
Expected: { error: false, data: { url: contains "document_list.php" } }
```

## Test 3: Get Content
```
Tool: ipk_get_content
Params: { max_chars: 2000 }
Expected: { error: false, data: { content: contains [CONTENT_START] } }
```

## Test 4: Fetch Approvals
```
Tool: ipk_fetch_approvals
Params: { status: "all", limit: 5 }
Expected: { error: false, data: { count: >= 0, items: [...] } }
```

## Test 5: Submit Leave (Draft)
```
Tool: ipk_submit_form
Params: { form_type: "leave", leave_type: "annual", start_date: "2026-04-01", draft_only: true }
Expected: { error: false, data: { success: true, mode: "draft", docId: non-null } }
```

## Test 6: Screenshot
```
Tool: screenshot
Expected: { error: false, data: { path: "/tmp/ipk-mcp-screenshots/..." } }
```

## Security Checks
- [ ] No credentials in any MCP response
- [ ] All evaluate() calls use parameterized form
- [ ] PII is masked in content responses
- [ ] Content wrapped in [CONTENT_START]...[CONTENT_END]
- [ ] draft_only defaults to true
- [ ] confirm_submit required for non-draft submission
