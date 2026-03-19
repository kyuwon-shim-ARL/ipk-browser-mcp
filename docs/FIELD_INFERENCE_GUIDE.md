# IPK 그룹웨어 필드 추론 가이드

> 각 폼 필드를 "사용자 필수 입력 / 자동 추론 / 1회 설정 / 과거 이력 추론" 으로 분류

---

## 📊 분류 기준

| 분류 | 설명 | 예시 |
|------|------|------|
| 🔴 **필수 입력** | 매번 사용자가 반드시 제공해야 함 | 휴가 날짜, 출장지 |
| 🟢 **자동 추론** | 시스템이 자동으로 계산/생성 가능 | 오늘 날짜, Subject 포맷 |
| 🔵 **1회 설정** | 최초 1회 입력 후 재사용 (.credentials) | 대리자 이름, 비상연락처 |
| 🟡 **이력 추론** | 과거 패턴 분석으로 추론 가능 | 자주 가는 출장지, 예산코드 |

---

## 📄 1. 휴가신청 (AppFrm-073)

### 필드 분류표

| 필드명 | 분류 | 현재 처리 | 추론 로직 |
|--------|------|-----------|-----------|
| `leave_kind` | 🔴 필수 | CLI `--type` | - |
| `begin_date` | 🔴 필수 | CLI `--date` | 미입력시 내일 날짜 |
| `end_date` | 🟢 자동 | 시작일과 동일 | `end_date = start_date` |
| `using_type` | 🟢 자동 | 시간 입력 여부로 판단 | 시간차면 `04`, 아니면 `01` |
| `start_time` | 🔴 조건부 | 시간차 휴가시만 | - |
| `end_time` | 🔴 조건부 | 시간차 휴가시만 | - |
| `purpose` | 🟡 이력 | 기본값 `personal` | 휴가 유형별 자주 쓰는 사유 |
| `destination` | 🟡 이력 | 기본값 `Seoul` | 자주 가는 목적지 |
| `subject` | 🟢 자동 | 자동 생성 | `{휴가종류}, {날짜}, {목적지}, {이름}` |
| `substitute_name` | 🔵 1회 | `.credentials` | 팀원 목록에서 선택 |
| `substitute_payroll` | 🟢 자동 | 팝업에서 자동 | 대리자 선택시 시스템 제공 |
| `substitute_position` | 🟢 자동 | 팝업에서 자동 | 대리자 선택시 시스템 제공 |
| `substitute_contact` | 🟢 자동 | 팝업에서 자동 | 대리자 선택시 시스템 제공 |
| `emergency_address` | 🔵 1회 | `.credentials` | 보통 집 주소 |
| `emergency_telephone` | 🔵 1회 | `.credentials` | 보통 본인 연락처 |

### 최소 입력 시나리오

```bash
# 최소 입력 (연차 1일)
python ipk_gw.py leave --date 2025-01-02

# 시스템이 추론하는 값:
# - end_date: 2025-01-02 (시작일과 동일)
# - using_type: 01 (Full day)
# - purpose: personal
# - destination: Seoul
# - subject: "Annual leave, 2025-01-02~2025-01-02, Seoul, Kyuwon Shim"
# - substitute_*: .credentials에서 로드 → 팝업 선택
# - emergency_*: .credentials에서 로드
```

### 이력 기반 추론 가능 항목

```python
# 과거 휴가 데이터 분석시 추론 가능:
HISTORY_PATTERNS = {
    "annual": {
        "purpose": ["personal", "family event", "travel"],
        "destination": ["Seoul", "Busan", "Home"],
        "avg_duration": 1.5,  # 평균 1.5일
    },
    "sick": {
        "purpose": ["health checkup", "hospital visit", "illness"],
        "destination": ["Seoul", "Hospital"],
    },
    "compensatory": {
        "purpose": ["personal", "rest"],
        "destination": ["Seoul", "Home"],
    }
}
```

---

## 📄 2. 휴일근무 (AppFrm-027)

### 필드 분류표

| 필드명 | 분류 | 현재 처리 | 추론 로직 |
|--------|------|-----------|-----------|
| `desired_date` | 🔴 필수 | CLI `--date` | 미입력시 다음 토요일 |
| `budget_type` | 🟡 이력 | 기본값 `02` (R&D) | 사용자의 주 예산 유형 |
| `budget_code` | 🟡 이력 | 하드코딩 | **가장 최근 사용한 예산코드** |
| `sub_subject` (reason) | 🟡 이력 | 기본값 `experiment` | 자주 쓰는 사유 |
| `wroking_place` | 🟡 이력 | 기본값 `IPK` | 대부분 IPK |
| `contents1` (details) | 🟢 자동 | reason 복사 | `= reason` |
| `subject` | 🟢 자동 | 자동 생성 | `Application for Working on {날짜}, {이름}` |

### 최소 입력 시나리오

```bash
# 최소 입력
python ipk_gw.py work --date 2025-01-04

# 시스템이 추론하는 값:
# - budget_type: 02 (R&D) - 연구원이므로
# - budget_code: NN2512-0001 - 마지막 사용 코드
# - reason: experiment
# - work_place: IPK
# - subject: 자동 생성
```

### 이력 기반 추론 가능 항목

```python
# 과거 휴일근무 데이터 분석시:
WORK_HISTORY = {
    "budget_codes_used": [
        ("NN2512-0001", 15),  # (코드, 사용횟수)
        ("NN2511-0003", 3),
    ],
    "reasons": [
        ("experiment", 12),
        ("data analysis", 5),
        ("paper writing", 3),
    ],
    "weekday_pattern": {
        "Saturday": 80,  # 80%가 토요일
        "Sunday": 20,
    }
}
```

### 🎯 핵심 추론: 예산코드

```python
def infer_budget_code(user_history: list) -> str:
    """
    예산코드 추론 로직:
    1. 가장 최근에 사용한 예산코드
    2. 사용 빈도가 가장 높은 예산코드
    3. 현재 활성화된 프로젝트의 예산코드
    """
    if user_history:
        # 최근 3개월 내 가장 많이 사용한 코드
        recent = [h for h in user_history if h.date > now - 90days]
        return most_common(recent)
    return "NN2512-0001"  # 기본값
```

---

## 📄 3. 출장보고 (AppFrm-076)

### 필드 분류표

| 필드명 | 분류 | 현재 처리 | 추론 로직 |
|--------|------|-----------|-----------|
| `title` (subject) | 🔴 필수 | CLI `--title` | - |
| `report_dest` | 🔴 필수 | CLI `--dest` | - |
| `start_day` | 🔴 필수 | CLI `--start` | - |
| `end_day` | 🔴 필수 | CLI `--end` | - |
| `purpose_field` | 🔴 필수 | CLI `--purpose` | 제목에서 추출 가능 |
| `report_date` | 🟢 자동 | 오늘 날짜 | `datetime.now()` |
| `report_name` | 🔵 1회 | `.credentials` | 로그인 사용자 |
| `report_post` | 🔵 1회 | `.credentials` | 직급 |
| `report_group` | 🔵 1회 | `.credentials` | 소속 부서 |
| `report_leader` | 🔵 1회 | `.credentials` | 팀장 이름 |
| `date_field` | 🟢 자동 | 날짜에서 생성 | `{start} ~ {end}` |
| `org_field` | 🟡 이력 | dest 복사 | 출장지에서 추론 |
| `person_field` | 🟢 자동 | 본인 이름 | - |
| `discuss_field` | 🟢 자동 | purpose 복사 | - |
| `agenda_field` | 🟢 자동 | purpose 복사 | - |
| `result_field` | 🟡 이력 | placeholder | 출장 후 수정 필요 |
| `other_field` | 🟢 자동 | "N/A" | - |
| `conclusion_field` | 🟢 자동 | purpose 기반 | - |

### 최소 입력 시나리오

```bash
# 최소 입력
python ipk_gw.py travel --title "MSK 2026" --dest "Seoul" --start 2025-03-01 --end 2025-03-03

# 시스템이 추론하는 값:
# - report_date: 오늘
# - report_name/post/group/leader: .credentials
# - date_field: "2025-03-01 ~ 2025-03-03"
# - purpose_field: 제목에서 "Conference" 추론 가능
# - org_field: "Seoul" (출장지)
# - person_field: 본인 이름
```

### 이력 기반 추론 가능 항목

```python
# 과거 출장 데이터 분석시:
TRAVEL_HISTORY = {
    "frequent_destinations": [
        ("Seoul", 10, {"org": "KIST", "purpose": "collaboration"}),
        ("Daejeon", 5, {"org": "KAIST", "purpose": "seminar"}),
        ("Boston", 2, {"org": "ASM Microbe", "purpose": "conference"}),
    ],
    "conference_patterns": {
        "MSK": {"dest": "Seoul", "duration": 3, "purpose": "conference"},
        "ASM": {"dest": "varies", "duration": 5, "purpose": "international conference"},
        "KSBB": {"dest": "varies", "duration": 2, "purpose": "domestic conference"},
    }
}

def infer_from_title(title: str) -> dict:
    """제목에서 출장 정보 추론"""
    title_lower = title.lower()

    # 학회명으로 추론
    if "msk" in title_lower:
        return {"purpose": "Conference presentation", "org": "대한미생물학회"}
    if "asm" in title_lower:
        return {"purpose": "International conference", "duration": 5}

    # 키워드로 추론
    if "meeting" in title_lower:
        return {"purpose": "Business meeting"}
    if "seminar" in title_lower:
        return {"purpose": "Seminar attendance"}

    return {}
```

---

## 📄 4. 야근식대 (AppFrm-021)

### 필드 분류표

| 필드명 | 분류 | 현재 처리 | 추론 로직 |
|--------|------|-----------|-----------|
| `attachment` | 🔴 필수 | CLI `--attachment` | 영수증 필수 |
| `amount` | 🔴 필수 | CLI `--amount` | 영수증 OCR 가능 |
| `date` (invoice) | 🟡 이력 | 기본값 오늘 | 영수증 날짜 |
| `budget_type` | 🟡 이력 | 기본값 `02` | 휴일근무와 동일 |
| `budget_code` | 🟡 이력 | 하드코딩 | 휴일근무와 동일 |
| `pay_kind` | 🟢 자동 | `04` (개인환급) | 거의 항상 동일 |
| `p_reason` | 🟢 자동 | 고정 문구 | - |
| `item_desc` | 🟢 자동 | "overtime meal" | - |
| `item_qty` | 🟢 자동 | 1 | - |
| `item_amount` | 🟢 자동 | VAT 제외 계산 | `amount / 1.1` |
| `item_vat` | 🟢 자동 | VAT 계산 | `amount - item_amount` |
| `participants` | 🟡 이력 | CLI `--participants` | 자주 함께하는 동료 |
| `subject` | 🟢 자동 | 고정 | "[Card] overtime meal" |

### 최소 입력 시나리오

```bash
# 최소 입력 (영수증 필수)
python ipk_gw.py meal --amount 15000 --attachment receipt.jpg

# 시스템이 추론하는 값:
# - date: 오늘 (또는 영수증 OCR)
# - budget_type/code: 마지막 사용값
# - pay_kind: 04 (개인환급)
# - item_amount: 13636 (15000/1.1)
# - item_vat: 1364
# - participants: 마지막 사용값 또는 빈값
```

### 이력 기반 추론 가능 항목

```python
# 야근식대 패턴 분석:
MEAL_HISTORY = {
    "avg_amount": 15000,
    "frequent_participants": [
        "Guinam Wee",
        "Minjeong Woo",
    ],
    "weekday_pattern": {
        "Friday": 40,  # 금요일이 가장 많음
        "Thursday": 25,
        "Wednesday": 20,
    }
}
```

### 🎯 미래 개선: 영수증 OCR

```python
def extract_from_receipt(image_path: str) -> dict:
    """영수증에서 정보 추출 (OCR)"""
    # TODO: Google Vision API 또는 Tesseract
    return {
        "date": "2025-01-03",
        "amount": 15000,
        "vendor": "BBQ",
        "items": ["치킨", "콜라"],
    }
```

---

## 📊 종합 요약: 필드별 추론 신뢰도

### 높은 신뢰도 (자동화 적합) ✅

| 필드 | 추론 방식 | 신뢰도 |
|------|-----------|--------|
| `subject` | 템플릿 기반 자동 생성 | 99% |
| `report_date` | 시스템 날짜 | 100% |
| `end_date` (휴가) | 시작일 복사 | 95% |
| `using_type` | 시간 입력 여부 | 100% |
| `substitute_*` (payroll, position, contact) | 팝업 시스템 제공 | 100% |
| VAT 계산 | 수학 계산 | 100% |

### 중간 신뢰도 (이력 기반) 🟡

| 필드 | 추론 방식 | 신뢰도 |
|------|-----------|--------|
| `budget_code` | 최근 사용 이력 | 85% |
| `destination` | 자주 가는 곳 | 70% |
| `purpose` | 휴가/출장 유형별 패턴 | 60% |
| `participants` | 자주 함께하는 동료 | 50% |

### 낮은 신뢰도 (사용자 확인 필요) 🔴

| 필드 | 이유 |
|------|------|
| `begin_date` | 매번 다름 |
| `leave_kind` | 사용자 의도 필요 |
| `title` (출장) | 출장마다 다름 |
| `result_field` (출장 결과) | 출장 후에만 알 수 있음 |
| `attachment` | 물리적 파일 필요 |

---

## 🚀 권장 UX 개선안

### 1. Smart Defaults

```python
class SmartDefaults:
    def get_next_leave_date(self) -> str:
        """다음 휴가 가능일 추천"""
        # 1. 이번 주 금요일 (휴가 가장 많은 요일)
        # 2. 다음 공휴일 전날
        # 3. 연휴 연결 가능일
        pass

    def get_likely_budget_code(self) -> str:
        """예산코드 추천"""
        # 1. 최근 3개월 가장 많이 사용한 코드
        # 2. 현재 활성 프로젝트 코드
        pass
```

### 2. Interactive Mode

```bash
# 대화형 모드로 누락된 필수값만 질문
$ python ipk_gw.py leave --date 2025-01-02

? 휴가 종류 [annual/compensatory/sick]: annual
? 목적지 [Seoul]: (Enter로 기본값 사용)
? 사유 [personal]: 가족 행사

✅ 휴가 신청 완료 (doc_id: 287240)
```

### 3. 과거 이력 학습

```python
# ~/.ipk_gw_history.json
{
    "leave": [
        {"date": "2024-12-25", "type": "annual", "dest": "Busan"},
        {"date": "2024-11-15", "type": "annual", "dest": "Seoul"},
    ],
    "work": [
        {"date": "2024-12-21", "budget_code": "NN2512-0001", "reason": "experiment"},
    ],
    "patterns": {
        "preferred_substitute": "Guinam Wee",
        "common_destinations": ["Seoul", "Busan"],
        "active_budget_codes": ["NN2512-0001"],
    }
}
```

---

## 📋 최종 정리: 폼별 최소 필수 입력

| 폼 | 최소 필수 입력 | 나머지는 자동 추론 |
|----|----------------|-------------------|
| **휴가** | `--date` | type, end, purpose, dest, substitute, emergency |
| **휴일근무** | `--date` | budget, reason, place |
| **출장** | `--title`, `--dest`, `--start`, `--end` | purpose, 모든 report 필드 |
| **야근식대** | `--amount`, `--attachment` | date, budget, VAT, participants |

---

*문서 끝*
