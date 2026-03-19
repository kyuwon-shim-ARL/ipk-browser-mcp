# 분석 결과: 첨부서류 요구사항

> **Agent**: /분석구현
> **분석일**: 2025-12-29
> **대상**: IPK 그룹웨어 4개 폼의 첨부파일 요구사항

---

## 1. 핵심 발견 (Key Findings)

### 검증된 사실
1. **휴가신청서(AppFrm-073)**: 6개 휴가 유형에서 첨부파일 필수
2. **경비청구서(AppFrm-021)**: 모든 경우 최소 1개 파일 필수
3. **휴일근무(AppFrm-027)**: 첨부파일 선택
4. **출장보고서(AppFrm-076)**: 첨부파일 선택

### JavaScript 근거

```javascript
// 휴가신청서 - Check_Form_Request() 내부
if(leave_kind == "02" || leave_kind == "03" || leave_kind == "05" ||
   leave_kind == "07" || leave_kind == "13" || leave_kind == "15"){
    if($("input[name='doc_attach_file[]']:eq(0)").val() == '' && 'insert' != 'update') {
        $("input[name='doc_attach_file[]']:eq(0)").focus();
        alert('Please attach the file.');
        return;
    }
}

// 경비청구서 - Check_Form_Request() 내부
if ( attach_file_cnt == 0 ) {
    alert('Please attach at least one file.');
    $(".doc_attach_file:eq(0)").focus();
    return;
}
```

---

## 2. 상세 분석 (Detailed Analysis)

### 2.1 휴가신청서 (AppFrm-073)

| 휴가 코드 | 휴가 유형 | 첨부 필수 | 요구 서류 | 근거 |
|-----------|-----------|-----------|-----------|------|
| 01 | Annual leave | ❌ | - | JS 분기에 미포함 |
| 02 | Sick leave | ✅ | 진단서/입원확인서 | leave_kind == "02" |
| 03 | Special leave | ✅ | 증빙서류 (경조사) | leave_kind == "03" |
| 04 | Menstruation leave | ❌ | - | JS 분기에 미포함 |
| 05 | Official leave | ✅ | 공무 증빙 | leave_kind == "05" |
| 07 | Child delivery | ✅ | 출산 증빙 | leave_kind == "07" |
| 08 | Unpaid leave | ❌ | - | JS 분기에 미포함 |
| 09 | Childcare leave | ❌ | - | JS 분기에 미포함 |
| 10 | Temporary Rest | ❌ | - | JS 분기에 미포함 |
| 11 | Compensatory leave | ❌ | - | JS 분기에 미포함 |
| 12 | Other | ❌ | - | JS 분기에 미포함 |
| 13 | Fetus Checkup | ✅ | 검진 증빙 | leave_kind == "13" |
| 14 | Saved Annual leave | ❌ | - | JS 분기에 미포함 |
| 15 | Paternity Leave | ✅ | 출생증명서 | leave_kind == "15" |

### 2.2 경비청구서 (AppFrm-021)

| 조건 | 첨부 필수 | 요구 서류 | 추가 요구사항 |
|------|-----------|-----------|--------------|
| **모든 경비청구** | ✅ | 영수증/세금계산서 | 최소 1개 파일 |
| 계정코드 410310 (접대비) | ✅ | 영수증 + 회의록 | meeting_time, venue, participants 필수 |
| 금액 > 500,000원 | ✅ | 영수증 + 사유서 | 지연 PR 사유 필수 |

### 2.3 휴일근무 (AppFrm-027)

| 조건 | 첨부 필수 | 요구 서류 |
|------|-----------|-----------|
| 일반 | ❌ | - |

### 2.4 출장보고서 (AppFrm-076)

| 조건 | 첨부 필수 | 요구 서류 |
|------|-----------|-----------|
| 출장 전 신청 | ❌ | - |
| 출장 후 보고 | ⚠️ 권장 | 출장 결과물, 영수증 등 |

---

## 3. 구현 제안 (Implementation Proposal)

### 3.1 첨부파일 요구사항 데이터 구조

```python
ATTACHMENT_REQUIREMENTS = {
    "leave": {
        # leave_kind -> (required, document_type, description)
        "01": (False, None, None),
        "02": (True, "medical", "진단서/입원확인서"),
        "03": (True, "certificate", "경조사 증빙서류"),
        "05": (True, "official", "공무 증빙서류"),
        "07": (True, "birth", "출산 증빙서류"),
        "13": (True, "medical", "산전검진 증빙"),
        "15": (True, "birth_cert", "출생증명서"),
    },
    "expense": {
        "default": (True, "receipt", "영수증/세금계산서"),
        "account_410310": {
            "additional_required": True,
            "fields": ["meeting_time", "venue", "participants"],
            "document": "회의록",
        },
        "amount_over_500000": {
            "additional_required": True,
            "document": "지연 사유서",
        },
    },
    "working": {
        "default": (False, None, None),
    },
    "travel": {
        "default": (False, None, "권장: 출장 결과물"),
    },
}
```

### 3.2 자동화 로직 개선

```python
def check_attachment_required(form_type: str, **kwargs) -> tuple[bool, str]:
    """
    첨부파일 필수 여부 및 필요 서류 반환

    Returns:
        (required: bool, document_description: str)
    """
    if form_type == "leave":
        leave_kind = kwargs.get("leave_kind", "01")
        req = ATTACHMENT_REQUIREMENTS["leave"].get(leave_kind, (False, None, None))
        return (req[0], req[2])

    elif form_type == "expense":
        # 경비청구서는 항상 필수
        base_doc = "영수증/세금계산서"
        account = kwargs.get("account_code", "")
        amount = kwargs.get("amount", 0)

        additional = []
        if account == "410310":
            additional.append("회의록 (meeting_time, venue, participants 포함)")
        if amount > 500000:
            additional.append("지연 사유서")

        if additional:
            return (True, f"{base_doc} + {', '.join(additional)}")
        return (True, base_doc)

    elif form_type == "working":
        return (False, None)

    elif form_type == "travel":
        return (False, "권장: 출장 결과물, 영수증")

    return (False, None)
```

### 3.3 CLI 개선안

```bash
# 첨부파일 필수 휴가 유형 선택시 경고
$ python ipk_gw.py leave --type sick --date 2025-01-05

⚠️  Sick leave는 첨부파일이 필수입니다.
    필요 서류: 진단서/입원확인서

    --attachment 옵션으로 파일을 지정하거나,
    Draft 저장 후 그룹웨어에서 직접 첨부하세요.

    계속하시겠습니까? [y/N]:
```

---

## 4. 자기 비평 (Self-Critique)

### 4.1 타협 사항 (Compromises Made)

| 항목 | 타협 내용 | 이유 | 위험도 |
|------|----------|------|--------|
| 서류 유형 명시 | 정확한 서류명 미확인 | 시스템에 명시되어 있지 않음 | **Medium** |
| 경조사 증빙 | "증빙서류"로 일반화 | 결혼/장례 등 구체적 서류 다름 | **Low** |
| 출장 첨부 | "권장"으로 표기 | 필수 여부 JS에서 미확인 | **Low** |
| 금액 조건 | 500,000원 기준 추출 | 연도별 변경 가능성 | **Medium** |

### 4.2 불확실한 영역 (Uncertainties)

1. **서버 사이드 검증**: JavaScript 외에 서버에서 추가 검증이 있을 수 있음
   - 검증 방법: 실제 제출 테스트 필요
   - 위험: 클라이언트 검증만 우회시 서버 에러 가능

2. **파일 형식 제한**: `.accept` 속성이 비어있어 허용 파일 형식 불명확
   - 추정: PDF, JPG, PNG 일반적으로 허용
   - 검증 필요: 실제 업로드 테스트

3. **파일 크기 제한**: 확인 안됨
   - 일반적으로 10MB~50MB 사이로 추정
   - 검증 필요: 대용량 파일 테스트

4. **계정코드 목록**: 410310 외 다른 코드의 추가 요구사항 미파악
   - 위험도: Medium
   - 대응: 사용자가 직접 확인 권장

### 4.3 검증 필요 항목

| 항목 | 검증 방법 | 우선순위 |
|------|----------|----------|
| 병가 첨부 종류 | 실제 병가 신청 후 확인 | High |
| 경조사 세부 구분 | HR 부서 문의 | Medium |
| 파일 크기 제한 | 대용량 파일 업로드 테스트 | Low |
| 서버 검증 로직 | 빈 파일로 제출 테스트 | High |

### 4.4 고려한 대안들 (Alternatives Considered)

| 대안 | 장점 | 단점 | 채택 여부 |
|------|------|------|----------|
| HR 부서 직접 문의 | 정확한 정보 | 시간 소요, 문서화 안될 수 있음 | ❌ |
| 과거 승인된 문서 분석 | 실제 사례 기반 | 접근 권한 필요, 개인정보 | ❌ |
| JS 코드 분석 | 즉시 가능, 객관적 | 서버 로직 미포함 | ✅ 채택 |
| 모든 케이스 테스트 | 완전한 검증 | 시간/비용 과다 | 부분 채택 |

---

## 5. 다음 단계 (Next Steps)

### /최종검토 에이전트에 전달할 항목

1. **검증 요청**: 휴가 유형 6개의 첨부 필수 여부 교차 검증
2. **위험 평가**: 서버 사이드 검증 미확인에 따른 위험도
3. **완전성 검토**: 누락된 폼/조건이 있는지
4. **구현 검토**: 제안된 데이터 구조의 적절성

### 추가 분석 필요

- [ ] 실제 휴가 신청 후 첨부 없이 저장 시도 → 에러 메시지 확인
- [ ] 계정코드 전체 목록 및 각각의 추가 요구사항
- [ ] 과거 제출 이력에서 첨부파일 패턴 분석 (가능하다면)

---

## 부록: 원본 JavaScript 코드

### A. 휴가신청서 Check_Form_Request (관련 부분)

```javascript
if(leave_kind == "02" || leave_kind == "03" || leave_kind == "05" ||
   leave_kind == "07" || leave_kind == "13" || leave_kind == "15"){
    if($("input[name='doc_attach_file[]']:eq(0)").val() == '' && 'insert' != 'update') {
        $("input[name='doc_attach_file[]']:eq(0)").focus();
        alert('Please attach the file.');
        return;
    }
}
```

### B. 경비청구서 Check_Form_Request (관련 부분)

```javascript
var attach_file_cnt = 0;
$(".doc_attach_file").each(function(i) {
    if ( $(this).val() != "" ) attach_file_cnt++;
});

attach_file_cnt += $(".attatch_file_link").length;
if ( attach_file_cnt == 0 ) {
    alert('Please attach at least one file.');
    $(".doc_attach_file:eq(0)").focus();
    return;
}

// 계정코드 410310 특별 처리
if ( $(".account_code:eq(1)").val() == "410310" &&
     $.trim($("#MeetingInfo").html()) == "" ) {
    // Meeting info required
}

// 50만원 초과 처리
if ( $.inArray( $(this).val(), arrChkAccount ) >= 0 &&
     eval( $("input[name='item_amount[]']:eq("+i+")").val() ) > 500000 ) {
    // Late PR reason required
}
```

---

*분석 완료 - /최종검토 에이전트의 검증 대기*
