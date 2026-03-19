# Claude Code MCP 플러그인 품질 개선 가이드

> 작성일: 2026-03-19
> 대상: Claude Code MCP 플러그인 개발자
> 적용 워크플로우: `sciomc → critic → exp-workflow → ralph`

---

## 개요

이 가이드는 Claude Code MCP 플러그인을 초기 개발 이후 체계적으로 검토하고 개선하는 워크플로우를 설명한다. ipk-browser-mcp 플러그인 개선 경험을 바탕으로 작성되었다.

**언제 사용하는가:**
- 초기 개발 완료 후 프로덕션 배포 전
- 주기적 품질 유지보수 (분기 1회 권장)
- 보안 이슈가 의심될 때
- 성능 저하나 토큰 낭비가 감지될 때

**전체 흐름:**

```
/sciomc (병렬 연구)
    ↓
critic agent (심각도 분류)
    ↓
/exp-workflow (GitHub 티켓)
    ↓
/ralph (구현 + 검증 루프)
```

---

## Phase 1: 연구 및 분석 (`/sciomc`)

### 호출 방법

```
/sciomc
```

프롬프트 예시:
```
Analyze ipk-browser-mcp (Claude Code MCP plugin) for production readiness.
Research: token efficiency, security vulnerabilities, API design quality,
architecture issues, and deployment strategy tradeoffs.
```

### 플러그인 검토를 위한 권장 연구 단계

각 단계를 독립적인 scientist agent에 할당한다. `/sciomc`는 이를 병렬로 실행한다.

| 연구 단계 | 핵심 질문 | 예시 발견 사항 |
|-----------|-----------|----------------|
| **Token efficiency** | MCP 응답 크기가 최소화되어 있는가? JSON이 이중 인코딩되지 않는가? | `JSON.stringify()` 중복 호출, 불필요한 wrapper 필드 |
| **Security audit** | `evaluate()` 호출이 파라미터화되어 있는가? 자격증명이 응답에 노출되지 않는가? URL 검증이 충분한가? | 인라인 문자열 보간으로 인한 script injection 위험 |
| **API design review** | 스키마 설명이 Claude가 이해하기에 충분한가? 미사용 파라미터가 있는가? | dead parameter, 불명확한 enum 값 |
| **Architecture review** | 코드 중복이 있는가? 모듈 경계가 명확한가? | 각 tool에 복사된 동일한 error handling 패턴 |
| **Deployment strategy** | MCP vs CLI 각각의 적합한 사용 사례는? | 배치 작업은 CLI가 더 적합 |

### 기대 출력

각 scientist는 `finding + evidence + recommendation` 구조로 리포트를 작성한다. 리포트는 `.omc/scientist/reports/` 에 저장된다.

---

## Phase 2: 비판적 검토 (Critic Agent)

### 호출 방법

Phase 1 결과를 입력으로 `oh-my-claudecode:critic` agent를 TaskCreate로 실행한다:

```
Task: oh-my-claudecode:critic
Input: [Phase 1 scientist reports]
Goal: Classify findings by severity, identify gaps, approve when no HIGH+ issues remain
```

### Critic 평가 기준

```
CRITICAL  - 보안 취약점 (즉시 수정, 배포 차단)
HIGH      - 기능 정확성 오류, 데이터 손실 위험
MEDIUM    - 성능, 유지보수성, API 일관성 문제
LOW       - 스타일, 네이밍, 문서 개선 사항
```

### 수렴 기준

- Critic이 HIGH+ 신규 발견 없이 승인하면 Phase 3으로 진행
- 일반적으로 1-3 라운드 소요
- 각 라운드에서 CRITICAL/HIGH 항목만 재검토하여 시간을 절약

### ipk-browser-mcp 실제 발견 사례

| 심각도 | 발견 사항 | 해결 방법 |
|--------|-----------|-----------|
| CRITICAL | `evaluate("window.fn('" + param + "')")` - script injection | `evaluate(([p]) => window.fn(p), [param])` 으로 교체 |
| HIGH | MCP 응답에 세션 쿠키 포함 가능성 | `sanitizer.ts`에서 credential 패턴 필터링 |
| MEDIUM | 각 tool마다 동일한 `try/catch` 블록 복사 | 공통 `withErrorHandling()` wrapper 추출 |
| LOW | `max_chars` 파라미터 미사용 경로 존재 | dead code 제거 |

---

## Phase 3: 티켓 관리 (`/exp-workflow`)

### 전제 조건

프로젝트 루트에 `.omc-config.sh` 가 설정되어 있어야 한다:

```bash
export OMC_GH_REPO="owner/repo"
export OMC_PROJECT_NUMBER="1"
# ... 기타 필드
```

### 티켓 생성 방법

Critic 승인된 항목을 실행 가능한 단위로 분해한다:

```
/exp-start e1 "Parameterize all evaluate() calls to prevent script injection"
/exp-start e2 "Extract shared error handling wrapper across tools"
/exp-start e3 "Remove dead parameters from ipk_fetch_approvals schema"
/exp-start e4 "Fix double JSON.stringify in content response"
```

**분해 원칙:**
- 티켓 하나 = 하나의 파일 또는 하나의 관심사
- CRITICAL/HIGH는 별도 티켓으로 분리 (순서 제어를 위해)
- 리팩토링과 기능 수정은 분리

### GitHub remote가 없는 경우

`.omc-config.sh` 미설정 시 Phase 3을 건너뛰고 Phase 4로 직접 진행한다. Critic 승인 내용을 ralph 입력으로 직접 전달한다.

---

## Phase 4: 구현 (`/ralph`)

### 호출 방법

```
/ralph implement all approved improvements from critic review:
1. Parameterize evaluate() calls (CRITICAL)
2. Extract shared error handler (MEDIUM)
3. Remove dead params (LOW)
Build must pass, architect must approve.
```

### Ralph가 처리하는 것

- 병렬 executor agent 위임
- 빌드 검증 (`tsc --noEmit`, `npm run build`)
- architect agent sign-off
- 실패 시 자동 재시도 루프

### 완료 기준

- `npm run build` 클린 통과
- TypeScript 오류 0개
- architect agent 승인
- 모든 티켓 resolved

### 주의 사항

Ralph는 자율적으로 실행된다. 다음 상황에서는 수동 개입이 필요하다:
- 환경 변수나 외부 서비스가 필요한 런타임 테스트
- 브라우저 자동화 smoke test (VPN + 자격증명 필요)
- architect가 설계 방향에 의문을 제기하는 경우

---

## 대안 접근법

플러그인의 복잡도와 위험도에 따라 워크플로우를 단순화할 수 있다.

| 상황 | 권장 워크플로우 |
|------|----------------|
| 간단한 플러그인 (도구 3개 이하) | `/code-review` → `/ralph` |
| 보안 민감 플러그인 (자격증명, 세션 처리) | `/sciomc` → `/security-review` → critic → `/ralph` |
| 대규모 리팩토링 | `/ralplan` (합의 계획) → `/ralph` |
| 단순 버그 수정 | executor 직접 위임 |
| 신규 기능 추가 | `omc-feature-start` → executor → verifier |

---

## 플러그인 검토 체크리스트

각 검토 사이클에 복사하여 사용한다.

```markdown
## Plugin Review Checklist - [플러그인명] - [날짜]

### Token Efficiency
- [ ] No double JSON.stringify (JSON object inside string inside JSON)
- [ ] Response size bounded (max_chars or equivalent limit enforced)
- [ ] No redundant wrapper fields in MCP response structure
- [ ] Content truncation works correctly at boundaries

### Security
- [ ] All evaluate() calls use parameterized form: evaluate(([p]) => ..., [p])
- [ ] No credentials, session tokens, or cookies in MCP responses
- [ ] URL inputs validated against allowlist or pattern
- [ ] PII masked in content responses before returning to Claude
- [ ] draft_only defaults to true for any write operations
- [ ] confirm_submit or equivalent required for destructive actions

### Dead Code
- [ ] All schema parameters are actually read in handler
- [ ] No unreachable branches (e.g., conditions that can never be true)
- [ ] No unused imports or exported symbols

### Code Duplication
- [ ] Shared error handling extracted to helper (not copy-pasted per tool)
- [ ] Common response shape built by single factory function
- [ ] Session access pattern consistent across all tools

### Schema Quality
- [ ] Each parameter has a `description` field Claude can act on
- [ ] Enums list all valid values with meaning (not just `"type1" | "type2"`)
- [ ] Optional parameters have sensible defaults documented
- [ ] Tool description explains when to use this tool vs alternatives

### Error Handling
- [ ] Errors return structured `{ error: true, code: "ERR_X", message: "..." }`
- [ ] No raw stack traces in MCP responses
- [ ] Network/timeout errors handled separately from logic errors
- [ ] Browser crash / session expiry handled gracefully

### Build Verification
- [ ] `npm run build` (or equivalent) exits 0
- [ ] TypeScript strict mode: zero errors, zero warnings
- [ ] Smoke test protocol passes (see test/smoke-test.md)
```

---

## 참고 파일

| 파일 | 용도 |
|------|------|
| `ipk-browser-mcp/test/smoke-test.md` | 런타임 검증 프로토콜 |
| `ipk-browser-mcp/src/security/sanitizer.ts` | credential 필터링 구현 참조 |
| `.omc/scientist/reports/` | sciomc 연구 결과 저장 위치 |
| `.omc-config.sh` | exp-workflow GitHub 연동 설정 |
