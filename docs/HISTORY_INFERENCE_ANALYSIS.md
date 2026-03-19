# 분석 결과: 이력 기반 추론 시스템 구현

> **Agent**: /분석구현
> **분석일**: 2025-12-29
> **대상**: history_manager.py + ipk_gw.py 통합

---

## 1. 핵심 발견 (Key Findings)

### 구현된 기능
1. **history_manager.py**: 이력 저장 및 추론 모듈
   - JSON 기반 이력 저장 (`.history.json`)
   - 3가지 추론 방식: mode, recent, context_mode
   - 신뢰도 기반 추론 (50% 이상시 적용)

2. **ipk_gw.py 통합**:
   - Leave: substitute, destination, purpose, emergency_* 추론
   - Working: budget_code, work_place 추론
   - 제출 성공시 자동 이력 기록

3. **CLI 인터페이스**:
   - `python ipk_gw.py history --demo`: 샘플 데이터 생성
   - `python ipk_gw.py history --form leave --context leave_type=annual`: 추론 테스트
   - `python ipk_gw.py leave --type annual`: 이력 기반 자동 추론

### 테스트 결과
```bash
$ python ipk_gw.py history --demo
# 8개 이력 기록, 6개 필드 추적

$ python ipk_gw.py history --form leave --context leave_type=compensatory
# purpose: child care (100%, context_mode)
# destination: Seoul (100%, context_mode)
```

---

## 2. 상세 분석 (Detailed Analysis)

### 데이터 구조
```json
{
  "version": "1.0",
  "submissions": [
    {
      "timestamp": "2025-12-29T...",
      "form_type": "leave",
      "doc_id": "287234",
      "fields": {"leave_type": "annual", "substitute": "Guinam Wee", ...}
    }
  ],
  "field_stats": {
    "leave": {
      "substitute": {
        "values": [...],
        "counter": {"Guinam Wee": 5},
        "context_counter": {"annual": {"Guinam Wee": 3}}
      }
    }
  }
}
```

### 추론 알고리즘
| 방식 | 설명 | 적용 필드 |
|------|------|----------|
| mode | 전체 최빈값 | substitute, emergency_* |
| recent | 가장 최근 값 | budget_code |
| context_mode | 컨텍스트별 최빈값 | destination, purpose (leave_type별) |

### 신뢰도 계산
```python
confidence = count / threshold  # 0.0 ~ 1.0
if confidence < 0.5:
    return fallback or inferred_value  # 낮은 신뢰도
else:
    return inferred_value  # 높은 신뢰도 적용
```

---

## 3. 구현 제안 (Implementation Completed)

### 구현된 파일
| 파일 | 라인 | 역할 |
|------|------|------|
| `history_manager.py` | 1-250 | 이력 관리 모듈 |
| `ipk_gw.py:27-31` | - | history_manager import |
| `ipk_gw.py:146-186` | - | `_get_history_value()`, `_record_submission()` |
| `ipk_gw.py:268-287` | - | leave 폼 이력 추론 |
| `ipk_gw.py:696-711` | - | working 폼 이력 추론 |
| `ipk_gw.py:970-1037` | - | history CLI 명령 |

### 사용 예시
```bash
# 기존: 모든 필드 수동 입력
python ipk_gw.py leave --type annual --date 2025-01-05 --purpose personal --dest Seoul

# 개선: 이력 기반 자동 추론
python ipk_gw.py leave --type annual --date 2025-01-05
# → purpose, dest, substitute 자동 추론
```

---

## 4. 자기 비평 (Self-Critique)

### ⚠️ 타협 사항 (Compromises Made)

| 항목 | 타협 내용 | 이유 | 위험도 |
|------|----------|------|--------|
| 저장소 | JSON 파일 사용 | SQLite 대비 간단, 소규모 데이터 | Low |
| 이력 보존 | 최근 100개만 유지 | 메모리/파일 크기 관리 | Low |
| 신뢰도 임계값 | 50% 고정 | 필드별 최적화 미수행 | Medium |
| Expense 미적용 | 이력 추론 적용 안함 | 필드 다양성 높음, 패턴 불분명 | Medium |
| Travel 미적용 | 연결 문서 추론에 의존 | 이력보다 문서 참조가 정확 | Low |

### ❓ 불확실한 영역 (Uncertainties)

1. **동시 접근 문제**
   - 여러 세션에서 동시에 `.history.json` 접근시 충돌 가능
   - 해결: 파일 잠금 또는 SQLite 전환 필요

2. **신뢰도 임계값 최적화**
   - 50% 고정값이 모든 필드에 적합한지 불확실
   - 필드별 최적 임계값은 실사용 후 조정 필요

3. **컨텍스트 키 확장성**
   - 현재 `leave_type`만 컨텍스트로 사용
   - `budget_type`, `time_of_year` 등 추가 컨텍스트 가능

4. **이력 데이터 마이그레이션**
   - 과거 승인 문서에서 이력 자동 수집 미구현
   - 현재는 새 제출부터 누적

### 🔄 고려한 대안들 (Alternatives Considered)

| 대안 | 장점 | 단점 | 채택 여부 |
|------|------|------|----------|
| SQLite 저장 | 동시성, 쿼리 | 복잡성 증가 | 미채택 |
| Redis 캐시 | 빠른 조회 | 외부 의존성 | 미채택 |
| 필드별 임계값 | 정확도 향상 | 설정 복잡 | 미채택 |
| ML 기반 추론 | 정교한 예측 | 과도한 복잡성 | 미채택 |
| 과거 문서 스크래핑 | 초기 데이터 | 시간 소요, 권한 | 추후 고려 |

---

## 5. 검증 체크리스트

### 완전성 검증
- [x] Leave 폼 이력 추론 구현
- [x] Working 폼 이력 추론 구현
- [ ] Expense 폼 이력 추론 (미적용 - 타협)
- [ ] Travel 폼 이력 추론 (미적용 - 타협)
- [x] 제출 후 자동 이력 기록
- [x] CLI 이력 조회 명령

### 기능 검증
- [x] mode 추론 작동 확인
- [x] context_mode 추론 작동 확인
- [x] recent 추론 작동 확인 (working)
- [x] 신뢰도 계산 정상
- [x] fallback 로직 정상

### Edge Case 처리
- [x] 이력 없을 때 fallback 사용
- [x] 낮은 신뢰도시 fallback 우선
- [x] 컨텍스트 없을 때 전체 mode로 fallback
- [ ] 동시 접근시 파일 충돌 (미처리)
- [ ] 손상된 JSON 복구 (기본 구조로 초기화만)

---

## 6. 다음 단계 (Next Steps)

### /최종검토 에이전트에 전달할 항목

1. **검증 요청**:
   - 구현된 추론 로직의 논리적 정확성
   - 타협 사항의 정당성 검토
   - 누락된 Edge case 식별

2. **테스트 요청**:
   - 실제 휴가 신청으로 이력 누적 테스트
   - 3-5회 제출 후 추론 정확도 확인

3. **위험 평가 요청**:
   - 동시 접근 문제의 실제 발생 확률
   - 이력 데이터 손상시 복구 방안

---

*분석 완료: /분석구현 Agent*
*구현 파일: `history_manager.py`, `ipk_gw.py`*
