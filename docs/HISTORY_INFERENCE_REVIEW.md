# 최종 검토 보고서: 이력 기반 추론 시스템

> **Agent**: /최종검토
> **검토일**: 2025-12-29
> **검토 대상**: HISTORY_INFERENCE_ANALYSIS.md + 구현 코드

---

## 1. 검토 요약 (Executive Summary)

- **판정**: ⚠️ **CONDITIONAL** - 조건부 승인
- **핵심 이슈**:
  - 동시 접근 문제 미해결 (Race condition)
  - 초기 이력 없을 때 사용자 경험 저하
  - Expense/Travel 폼 미적용
- **권고사항**: 실사용 테스트 후 배포, 동시성 문제 모니터링

---

## 2. 검증 결과 (Verification Results)

### 2.1 논리적 일관성

| 항목 | 판정 | 근거 |
|------|------|------|
| mode 추론 로직 | ✅ Pass | Counter 기반 최빈값, 수학적으로 정확 |
| context_mode 로직 | ✅ Pass | 2단계 fallback (context → 전체) |
| recent 추론 로직 | ✅ Pass | 최근 값 우선, 반복 패턴 신뢰도 |
| 신뢰도 계산 | ⚠️ Partial | 50% 임계값 근거 불명확 |
| fallback 로직 | ✅ Pass | credentials → history → default 순서 |

### 2.2 완전성

| 누락 항목 | 심각도 | 보완 방안 |
|----------|--------|----------|
| Expense 이력 추론 | Medium | budget_code는 적용 가능했음 |
| Travel 이력 추론 | Low | 연결 문서 방식이 더 적합 |
| 파일 잠금 | High | 동시 접근시 데이터 손상 가능 |
| 이력 백업 | Medium | 손상시 복구 불가 |
| 초기 데이터 수집 | Medium | 기존 승인 문서에서 이력 추출 미구현 |

### 2.3 타협점 감사

| 타협 사항 | 정당성 | 대안 존재 여부 | 위험도 |
|----------|--------|---------------|--------|
| JSON 파일 저장 | ✅ 정당 | SQLite는 과도함 | Low |
| 100개 이력 제한 | ✅ 정당 | 적절한 균형 | Low |
| 50% 신뢰도 고정 | ❌ 부당 | 필드별 조정 가능했음 | Medium |
| Expense 미적용 | ⚠️ 부분 | budget_code는 가능 | Medium |
| 동시성 미처리 | ❌ 부당 | 간단한 잠금 구현 가능 | High |

---

## 3. 발견된 문제점 (Issues Found)

### Critical

1. **파일 동시 접근 문제** (`history_manager.py:36-50`)
   - 문제: 여러 프로세스가 동시에 `.history.json` 읽기/쓰기
   - 영향: 데이터 손상, 이력 손실
   - 해결안:
   ```python
   import fcntl
   def _save(self):
       with open(self.history_file, 'w') as f:
           fcntl.flock(f, fcntl.LOCK_EX)
           json.dump(self.data, f)
           fcntl.flock(f, fcntl.LOCK_UN)
   ```

### Major

2. **초기 이력 부재 문제**
   - 문제: 첫 사용시 이력이 없어 모든 추론 실패
   - 영향: 첫 사용자 경험 저하
   - 해결안:
     - 과거 승인 문서에서 이력 자동 수집
     - 또는 setup 시 초기 값 설정

3. **신뢰도 임계값 고정**
   - 문제: 모든 필드에 50% 동일 적용
   - 영향: 자주 변하는 필드(purpose)와 고정 필드(emergency)를 동일 취급
   - 해결안: 필드별 threshold 설정 (이미 HISTORY_FIELDS에 있으나 미활용)

### Minor

4. **Expense budget_code 미적용**
   - 분석구현이 "패턴 불분명"으로 타협했으나, working과 동일 방식 적용 가능

5. **이력 백업 없음**
   - `.history.json` 손상시 복구 불가
   - 정기 백업 또는 버전 관리 권장

---

## 4. 독립 검증 결과 (Independent Verification)

| 주장 | 검증 방법 | 결과 | 불일치 사항 |
|------|----------|------|------------|
| mode 추론 정확 | 코드 리뷰 | ✅ 일치 | Counter.most_common() 사용 권장 |
| context_mode 정확 | 코드 리뷰 + 테스트 | ✅ 일치 | fallback 로직 확인됨 |
| 50% 임계값 | 테스트 실행 | ⚠️ 부분 | 실제 코드는 `count/threshold` 아닌 `count/max(threshold,1)` |
| 이력 기록 정상 | 테스트 실행 | ✅ 일치 | doc_id 포함 확인 |
| CLI 작동 | 직접 실행 | ✅ 일치 | `--demo`, `--context` 정상 |

### 독립 검증: 코드 정확성

```python
# history_manager.py:130-135 검증
def _infer_mode(self, stats: Dict, threshold: int) -> Tuple:
    most_common = max(counter.items(), key=lambda x: x[1])
    value, count = most_common
    confidence = min(1.0, count / max(threshold, 1))  # ✓ 올바름
```
**검증 결과**: 수학적으로 정확함

### 독립 검증: 통합 테스트

```bash
$ python ipk_gw.py history --demo
# 결과: 8개 이력 기록됨 ✓

$ python ipk_gw.py history --form leave --context "leave_type=compensatory"
# 결과: purpose="child care" 정확히 추론됨 ✓
```
**검증 결과**: 기능 정상 작동

---

## 5. 위험 평가 (Risk Assessment)

| 위험 요소 | 발생 확률 | 영향도 | 대응 방안 |
|----------|----------|--------|----------|
| 동시 접근 데이터 손상 | 20% | High | 파일 잠금 구현 |
| 초기 이력 부재 | 100% (첫 사용) | Medium | 기본값 fallback 존재 |
| 이력 파일 삭제 | 5% | Medium | 자동 재생성됨 |
| 잘못된 추론 적용 | 10% | Low | 사용자가 override 가능 |
| 이력 100개 초과 | 30% (장기 사용) | Low | 자동 정리됨 |

### 종합 위험도: **Medium**

- 핵심 기능은 정상 작동
- 동시성 문제는 단일 사용자 환경에서 낮은 발생률
- 초기 이력 부재는 credentials fallback으로 완화

---

## 6. 최종 권고 (Final Recommendations)

### 필수 조치 (Must Do)

1. **파일 잠금 구현** (동시성 문제 해결)
   ```python
   # history_manager.py에 추가
   import fcntl

   def _load(self):
       with open(self.history_file, 'r') as f:
           fcntl.flock(f, fcntl.LOCK_SH)
           data = json.load(f)
           fcntl.flock(f, fcntl.LOCK_UN)
       return data
   ```

2. **실사용 테스트**
   ```bash
   # 최소 3회 leave 신청 후 추론 확인
   python ipk_gw.py leave --type annual --date 2025-01-10
   python ipk_gw.py leave --type annual --date 2025-01-11
   python ipk_gw.py leave --type annual --date 2025-01-12
   python ipk_gw.py history --form leave
   ```

### 권장 조치 (Should Do)

1. **필드별 임계값 활용**
   ```python
   # 이미 정의된 threshold 실제 사용
   "emergency_address": {"method": "mode", "confidence_threshold": 1}
   ```

2. **Expense budget_code 추론 추가**
   - Working과 동일 방식 적용 가능

3. **이력 초기화 스크립트**
   ```bash
   # 기존 승인 문서에서 이력 수집
   python ipk_gw.py history --import-from-approved
   ```

### 선택 조치 (Could Do)

1. 이력 백업 자동화 (`.history.json.bak`)
2. 추론 결과 확인 프롬프트 추가
3. 웹 UI 대시보드 (이력 조회/수정)

---

## 7. 검토자 자기 비평 (Reviewer Self-Critique)

### 이 검토에서 놓쳤을 수 있는 부분
- 다른 OS(Windows)에서의 파일 잠금 호환성
- 매우 긴 값(>1000자)의 저장/추론 성능
- 특수문자/유니코드 처리

### 검토자의 편향 가능성
- 동시성 문제에 과도하게 집중 (단일 사용자 시나리오에서 낮은 발생률)
- 코드 품질보다 기능 완성도에 편중

### 추가 검토가 필요한 영역
- 장기 사용 후 성능 (이력 100개 이상)
- 다른 사용자의 이력과 섞이는 경우 (공유 시스템)
- 이력 데이터 개인정보 보호

---

## 8. 판정 상세

### ⚠️ CONDITIONAL 사유

1. **핵심 기능 검증됨**:
   - mode, recent, context_mode 추론 정상
   - CLI 통합 정상
   - 테스트 결과 정확

2. **미해결 이슈 존재**:
   - 동시 접근 문제 (권장: 파일 잠금)
   - 초기 이력 부재 (완화: fallback 존재)

3. **위험 관리 가능**:
   - 단일 사용자 환경에서 안전
   - 추론 실패시 credentials fallback

### 배포 조건
- [x] 기본 기능 테스트 완료
- [ ] 실제 휴가 신청 1회 이상 테스트
- [ ] 동시성 문제 모니터링 계획 수립

### 승인 후 모니터링
- `.history.json` 파일 무결성 주기적 확인
- 추론 정확도 사용자 피드백 수집
- 3개월 후 성능 리뷰

---

*검토 완료*

**검토자**: /최종검토 Agent
**판정**: ⚠️ CONDITIONAL
**다음 액션**: 파일 잠금 구현 권장, 실사용 테스트 후 배포
