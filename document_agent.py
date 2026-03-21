"""
Document Automation Agent: 대화형 문서 자동화 에이전트
=========================================================
/분석구현 Agent 구현

기능:
1. 문서 유형별 필수 요구사항 확인
2. 이력 기반 자동 추론
3. 최소 필수 입력만 사용자에게 요청
4. 충분한 정보 확보시 자동 Draft 작성

사용법:
    python document_agent.py leave
    python document_agent.py expense
    python document_agent.py working
"""

import json
import os
from pathlib import Path
from datetime import datetime, timedelta
from typing import Optional, Dict, Any, List, Tuple
from dataclasses import dataclass, field

try:
    from history_manager import get_history_manager, HistoryManager
    HISTORY_AVAILABLE = True
except ImportError:
    HISTORY_AVAILABLE = False

try:
    from ipk_gw import IPKGroupware, get_credential
    IPKGW_AVAILABLE = True
except ImportError:
    IPKGW_AVAILABLE = False


@dataclass
class FieldRequirement:
    """필드 요구사항 정의"""
    name: str
    label: str
    required: bool
    source: str  # "user", "history", "auto", "attachment"
    description: str = ""
    options: List[str] = field(default_factory=list)
    depends_on: Optional[Dict[str, Any]] = None  # 조건부 필수


@dataclass
class DocumentRequest:
    """문서 작성 요청"""
    form_type: str
    fields: Dict[str, Any] = field(default_factory=dict)
    attachments: List[str] = field(default_factory=list)
    inferred_fields: Dict[str, Tuple[Any, float, str]] = field(default_factory=dict)
    missing_fields: List[str] = field(default_factory=list)
    ready_to_submit: bool = False
    validation_errors: List[str] = field(default_factory=list)


class DocumentAgent:
    """대화형 문서 자동화 에이전트"""

    # 휴가 유형별 한글명
    LEAVE_TYPES = {
        "annual": ("01", "연차"),
        "compensatory": ("11", "보상휴가"),
        "sick": ("02", "병가"),
        "special": ("03", "특별휴가"),
        "paternity": ("15", "출산휴가"),
        "official": ("05", "공가"),
        "childcare": ("07", "육아휴직"),
        "fetus_checkup": ("13", "태아검진"),
    }

    # 첨부파일 필수 휴가 유형
    ATTACHMENT_REQUIRED_LEAVES = {
        "02": "진단서/입원확인서",
        "03": "경조사 증빙서류",
        "05": "공무 증빙서류",
        "07": "출산 증빙서류",
        "13": "산전검진 증빙",
        "15": "출생증명서",
    }

    # 폼별 필드 요구사항
    FORM_REQUIREMENTS = {
        "leave": {
            "required_user": [
                FieldRequirement("leave_type", "휴가 유형", True, "user",
                                 options=list(LEAVE_TYPES.keys())),
                FieldRequirement("start_date", "시작일", True, "user",
                                 description="YYYY-MM-DD 형식"),
                FieldRequirement("end_date", "종료일", True, "user",
                                 description="YYYY-MM-DD (당일이면 시작일과 동일)"),
            ],
            "optional_user": [
                FieldRequirement("purpose", "휴가 사유", False, "user",
                                 description="이력에서 추론 가능"),
                FieldRequirement("destination", "목적지", False, "user",
                                 description="이력에서 추론 가능"),
                FieldRequirement("substitute", "대리자", False, "user",
                                 description="이력에서 추론 가능"),
            ],
            "history_infer": ["purpose", "destination", "substitute",
                              "emergency_address", "emergency_telephone"],
            "auto_infer": ["subject", "drafter", "department"],
            "conditional_attachment": {
                "leave_type": ["sick", "special", "official", "childcare",
                               "fetus_checkup", "paternity"]
            }
        },
        "working": {
            "required_user": [
                FieldRequirement("work_date", "근무일", True, "user",
                                 description="YYYY-MM-DD 형식"),
                FieldRequirement("reason", "근무 사유", True, "user",
                                 description="업무 내용 간략히"),
            ],
            "optional_user": [
                FieldRequirement("budget_code", "예산 코드", False, "user",
                                 description="이력에서 추론 가능"),
                FieldRequirement("work_place", "근무 장소", False, "user",
                                 description="기본값: IPK"),
            ],
            "history_infer": ["budget_code", "work_place"],
            "auto_infer": ["subject", "drafter", "meal_expense"],
            "conditional_attachment": {}
        },
        "expense": {
            "required_user": [
                FieldRequirement("budget_type", "예산 유형", True, "user",
                                 options=["General", "R&D"]),
                FieldRequirement("budget_code", "예산 코드", True, "user",
                                 description="프로젝트 코드"),
                FieldRequirement("item_name", "항목명", True, "user",
                                 description="예: 야근식대, 회의비"),
                FieldRequirement("amount", "금액", True, "user",
                                 description="원 단위"),
                FieldRequirement("attachment", "영수증", True, "attachment",
                                 description="파일 경로 (필수)"),
            ],
            "optional_user": [
                FieldRequirement("date", "사용일", False, "user",
                                 description="기본값: 오늘"),
            ],
            "history_infer": [],
            "auto_infer": ["subject", "drafter"],
            "conditional_attachment": {"always": True}  # 항상 필수
        },
        "travel": {
            "required_user": [
                FieldRequirement("ref_doc", "출장신청서", True, "user",
                                 description="연결할 출장신청서 doc_id"),
                FieldRequirement("summary", "출장 결과 요약", True, "user",
                                 description="주요 성과/결과"),
            ],
            "optional_user": [],
            "history_infer": [],
            "auto_infer": ["date", "destination", "purpose"],  # 연결 문서에서
            "conditional_attachment": {}
        }
    }

    def __init__(self):
        self.history_manager = get_history_manager() if HISTORY_AVAILABLE else None
        self.current_request: Optional[DocumentRequest] = None

    def start_request(self, form_type: str) -> DocumentRequest:
        """새 문서 작성 요청 시작"""
        if form_type not in self.FORM_REQUIREMENTS:
            raise ValueError(f"지원하지 않는 문서 유형: {form_type}")

        self.current_request = DocumentRequest(form_type=form_type)
        return self.current_request

    def get_requirements(self, form_type: str) -> Dict[str, Any]:
        """폼 유형별 요구사항 반환"""
        reqs = self.FORM_REQUIREMENTS.get(form_type, {})
        return {
            "required": [f.name for f in reqs.get("required_user", [])],
            "optional": [f.name for f in reqs.get("optional_user", [])],
            "history_infer": reqs.get("history_infer", []),
            "auto_infer": reqs.get("auto_infer", []),
            "attachment_conditions": reqs.get("conditional_attachment", {}),
        }

    def infer_from_history(
        self,
        form_type: str,
        context: Optional[Dict[str, str]] = None
    ) -> Dict[str, Tuple[Any, float, str]]:
        """이력에서 필드 추론"""
        if not self.history_manager:
            return {}

        reqs = self.FORM_REQUIREMENTS.get(form_type, {})
        history_fields = reqs.get("history_infer", [])

        inferred = {}
        for field_name in history_fields:
            value, confidence, method = self.history_manager.infer(
                form_type, field_name, context
            ) if self.history_manager else (None, 0.0, "unavailable")

            if value and confidence >= 0.5:
                inferred[field_name] = (value, confidence, method)

        return inferred

    def check_attachment_required(
        self,
        form_type: str,
        fields: Dict[str, Any]
    ) -> Tuple[bool, Optional[str]]:
        """첨부파일 필수 여부 확인"""
        reqs = self.FORM_REQUIREMENTS.get(form_type, {})
        conditions = reqs.get("conditional_attachment", {})

        # 항상 필수 (expense)
        if conditions.get("always"):
            return True, "경비청구서는 영수증 첨부 필수"

        # 조건부 필수 (leave 특정 유형)
        for field_name, required_values in conditions.items():
            if field_name in fields:
                field_value = fields[field_name]
                if field_value in required_values:
                    # 휴가 유형에 따른 필수 서류
                    leave_code = self.LEAVE_TYPES.get(field_value, ("", ""))[0]
                    doc_type = self.ATTACHMENT_REQUIRED_LEAVES.get(leave_code, "증빙서류")
                    return True, f"{field_value} 유형은 첨부 필수: {doc_type}"

        return False, None

    def validate_request(self, request: DocumentRequest) -> List[str]:
        """요청 유효성 검사"""
        errors = []
        reqs = self.FORM_REQUIREMENTS.get(request.form_type, {})

        # 필수 필드 확인
        for field_req in reqs.get("required_user", []):
            if field_req.source == "attachment":
                if not request.attachments:
                    errors.append(f"필수 첨부파일 누락: {field_req.label}")
            elif field_req.name not in request.fields:
                # 이력에서 추론되었는지 확인
                if field_req.name not in request.inferred_fields:
                    errors.append(f"필수 입력 누락: {field_req.label}")

        # 첨부파일 조건 확인
        attach_required, attach_reason = self.check_attachment_required(
            request.form_type, request.fields
        )
        if attach_required and not request.attachments:
            errors.append(f"첨부파일 필수: {attach_reason}")

        # 날짜 형식 확인
        for field_name in ["start_date", "end_date", "work_date"]:
            if field_name in request.fields:
                try:
                    datetime.strptime(request.fields[field_name], "%Y-%m-%d")
                except ValueError:
                    errors.append(f"잘못된 날짜 형식: {field_name} (YYYY-MM-DD)")

        # expense 금액 검증 (0원 방지)
        if request.form_type == "expense":
            amount = request.fields.get("amount")
            if not amount or int(amount) <= 0:
                errors.append("필수 입력 누락: 금액 (0보다 큰 값 필요)")

        request.validation_errors = errors
        request.ready_to_submit = len(errors) == 0

        return errors

    def prepare_submission(self, request: DocumentRequest) -> Dict[str, Any]:
        """제출용 데이터 준비"""
        # 사용자 입력 + 이력 추론 병합
        submission_data = dict(request.fields)

        for field_name, (value, conf, method) in request.inferred_fields.items():
            if field_name not in submission_data:
                submission_data[field_name] = value

        # 첨부파일
        if request.attachments:
            submission_data["attachment"] = request.attachments[0]

        return submission_data

    def submit_draft(self, request: DocumentRequest) -> Tuple[bool, str]:
        """Draft 제출"""
        if not request.ready_to_submit:
            return False, f"제출 불가: {', '.join(request.validation_errors)}"

        if not IPKGW_AVAILABLE:
            return False, "IPK 그룹웨어 모듈을 사용할 수 없습니다"

        gw = None
        try:
            data = self.prepare_submission(request)

            # 자격증명 확인
            username = get_credential("username")
            password = get_credential("password")
            if not username or not password:
                return False, "로그인 정보가 없습니다. 'python ipk_gw.py setup' 실행 필요"

            gw = IPKGroupware(headless=True)
            gw.login(username, password)

            success = False

            if request.form_type == "leave":
                success = gw.submit_leave(
                    leave_type=data.get("leave_type", "annual"),
                    start_date=data.get("start_date"),
                    end_date=data.get("end_date"),
                    purpose=data.get("purpose"),
                    destination=data.get("destination"),
                    substitute=data.get("substitute"),
                    draft_only=True
                )
            elif request.form_type == "working":
                success = gw.submit_work_request(
                    work_date=data.get("work_date"),
                    reason=data.get("reason"),
                    work_place=data.get("work_place"),
                    budget_code=data.get("budget_code"),
                    draft_only=True
                )
            elif request.form_type == "expense":
                success = gw.submit_overtime_meal(
                    date=data.get("date"),
                    amount=int(data.get("amount", 0)),
                    attachment=data.get("attachment"),
                    draft_only=True
                )
            elif request.form_type == "travel":
                # Travel 문서는 아직 submit 메서드 미구현
                return False, "Travel 문서 자동 제출은 아직 지원되지 않습니다. 수동 제출 필요."

            if success:
                return True, "Draft 저장 완료"
            else:
                return False, "Draft 저장 실패"

        except Exception as e:
            return False, f"오류: {str(e)}"
        finally:
            if gw:
                gw.close()

    def interactive_session(self, form_type: str):
        """대화형 세션 실행"""
        print("\n" + "=" * 60)
        print(f"📝 문서 자동화 에이전트 - {form_type.upper()}")
        print("=" * 60)

        request = self.start_request(form_type)
        reqs = self.FORM_REQUIREMENTS.get(form_type, {})

        # 1. 이력 기반 추론
        print("\n[1/4] 이력 기반 추론 중...")
        context = {}
        if form_type == "leave":
            # 휴가 유형 먼저 확인
            leave_type = self._ask_field(
                reqs["required_user"][0],  # leave_type
                None
            )
            request.fields["leave_type"] = leave_type
            context["leave_type"] = leave_type

        request.inferred_fields = self.infer_from_history(form_type, context)

        if request.inferred_fields:
            print("\n  [이력에서 추론됨]")
            for field, (value, conf, method) in request.inferred_fields.items():
                print(f"    ✓ {field}: {value} ({conf:.0%} 신뢰도)")
        else:
            print("  (추론 가능한 이력 없음)")

        # 2. 필수 입력 요청
        print("\n[2/4] 필수 정보 입력")
        for field_req in reqs.get("required_user", []):
            if field_req.name in request.fields:
                continue  # 이미 입력됨
            if field_req.name in request.inferred_fields:
                continue  # 이력에서 추론됨
            if field_req.source == "attachment":
                continue  # 첨부파일은 별도 처리

            value = self._ask_field(field_req, request.inferred_fields.get(field_req.name))
            if value:
                request.fields[field_req.name] = value

        # 3. 첨부파일 확인
        print("\n[3/4] 첨부파일 확인")
        attach_required, attach_reason = self.check_attachment_required(
            form_type, request.fields
        )

        if attach_required:
            print(f"  ⚠️  {attach_reason}")
            attachment = input("  첨부파일 경로: ").strip()
            if attachment and os.path.exists(attachment):
                request.attachments.append(attachment)
                print(f"  ✓ 첨부됨: {attachment}")
            else:
                print("  ❌ 파일을 찾을 수 없습니다")
        else:
            print("  (첨부파일 선택 사항)")

        # 4. 검증 및 제출
        print("\n[4/4] 검증 및 제출")
        errors = self.validate_request(request)

        if errors:
            print("  ❌ 검증 실패:")
            for err in errors:
                print(f"    - {err}")
            return request

        # 제출 확인
        print("\n  ✓ 모든 요구사항 충족")
        print("\n  [제출 데이터 미리보기]")
        submission = self.prepare_submission(request)
        for k, v in submission.items():
            print(f"    {k}: {v}")

        confirm = input("\n  Draft로 저장하시겠습니까? (y/n): ").strip().lower()
        if confirm == 'y':
            success, message = self.submit_draft(request)
            if success:
                print(f"\n  ✅ {message}")
            else:
                print(f"\n  ❌ {message}")
        else:
            print("\n  취소됨")

        return request

    def _ask_field(
        self,
        field_req: FieldRequirement,
        inferred: Optional[Tuple[Any, float, str]]
    ) -> Optional[str]:
        """필드 입력 요청"""
        prompt = f"  {field_req.label}"

        if field_req.options:
            prompt += f" ({'/'.join(field_req.options)})"
        if field_req.description:
            prompt += f" [{field_req.description}]"

        if inferred:
            value, conf, _ = inferred
            prompt += f" (추론: {value})"

        prompt += ": "

        user_input = input(prompt).strip()

        # 빈 입력이면 추론값 사용
        if not user_input and inferred:
            return inferred[0]

        return user_input if user_input else None


class SmartFormAgent:
    """Natural language form parsing agent for IPK groupware.

    Usage:
        agent = SmartFormAgent()
        form_code = agent.classify_form("다음주 화요일 BEXCO 출장 BC-2026-0045")
        parsed = agent.parse_input("다음주 화 BEXCO 학회 BC-2026-0045", form_code)
        result = agent.fill_and_validate(form_code, parsed)
    """

    # Form type detection keywords
    FORM_KEYWORDS = {
        "AppFrm-023": ["출장신청", "출장", "travel request", "학회", "컨퍼런스", "conference"],
        "AppFrm-054": ["출장정산", "정산", "domestic settlement", "settlement"],
        "AppFrm-073": ["휴가", "연차", "대휴", "반차", "leave"],
        "AppFrm-020": ["카드", "영수증", "법인카드", "card", "expense"],
        "AppFrm-028": ["휴가복귀", "복귀", "return"],
        "AppFrm-043": ["세미나", "학회발표", "공개", "seminar", "disclosure"],
        "AppFrm-026": ["해외출장", "해외", "overseas"],
        "AppFrm-039": ["예산전용", "예산", "전용", "budget transfer", "budget", "transfer"],
    }

    # Priority order for disambiguation (more specific first)
    FORM_PRIORITY = [
        "AppFrm-028",  # 휴가복귀 before 휴가
        "AppFrm-026",  # 해외출장 before 출장
        "AppFrm-054",  # 출장정산 before 출장
        "AppFrm-043",
        "AppFrm-023",
        "AppFrm-073",
        "AppFrm-020",
        "AppFrm-039",
    ]

    # Korean weekday map
    WEEKDAY_KO = {"월": 0, "화": 1, "수": 2, "목": 3, "금": 4, "토": 5, "일": 6}

    # Seoul/metro area city keywords
    SEOUL_KEYWORDS = ["서울", "seoul", "coex", "코엑스", "삼성", "강남", "홍대", "여의도"]
    GYEONGGI_SUWON_KEYWORDS = ["수원", "suwon"]
    BUSAN_KEYWORDS = ["부산", "busan", "bexco", "벡스코"]
    DAEJEON_KEYWORDS = ["대전", "daejeon", "dcc"]

    def __init__(self, profiles_path: str = None, templates_dir: str = None):
        base = Path(__file__).parent
        self._profiles_path = profiles_path or str(base / "analysis_results" / "traveler_profiles.json")
        self._templates_dir = templates_dir or str(base / "form_templates")
        self._classification_path = str(base / "form_templates" / "FIELD_CLASSIFICATION.json")
        self._profiles: Optional[Dict] = None
        self._classification: Optional[Dict] = None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def classify_form(self, raw_text: str) -> str:
        """Detect which of the 8 form types from natural language text.

        Returns the AppFrm-XXX code string, or raises ValueError if ambiguous/unknown.
        """
        import re
        text_lower = raw_text.lower()

        # BC-XXXX-XXXX is a strong signal for travel request (AppFrm-023)
        # ARL-XXXXXX-XX is a strong signal for leave return (AppFrm-028)
        if re.search(r'\bBC-\d{4}-\d{4}\b', raw_text, re.IGNORECASE):
            # Overseas beats domestic
            for kw in self.FORM_KEYWORDS["AppFrm-026"]:
                if kw.lower() in text_lower:
                    return "AppFrm-026"
            # Settlement beats travel request
            for kw in self.FORM_KEYWORDS["AppFrm-054"]:
                if kw.lower() in text_lower:
                    return "AppFrm-054"
            return "AppFrm-023"

        if re.search(r'\bARL-\d{6}-\d{2,}\b', raw_text, re.IGNORECASE):
            # "정산" with ARL → travel settlement, not leave return
            for kw in self.FORM_KEYWORDS["AppFrm-054"]:
                if kw.lower() in text_lower:
                    return "AppFrm-054"
            return "AppFrm-028"

        # Receipt pattern: control number (XXXXXXXX-XX) + amount in 원 → card expense
        if re.search(r'\d{8}-\d{2}', raw_text) and re.search(r'\d[\d,]*원', raw_text):
            return "AppFrm-020"

        for form_code in self.FORM_PRIORITY:
            for kw in self.FORM_KEYWORDS[form_code]:
                if kw.lower() in text_lower:
                    return form_code
        raise ValueError(
            f"Cannot classify form from: '{raw_text}'. "
            f"Try adding keywords like 출장/휴가/정산/카드/해외/예산."
        )

    def parse_input(self, raw_text: str, form_code: str = None) -> dict:
        """Extract structured fields from unstructured natural language text.

        Parses: dates, amounts, doc references, locations, purposes.
        Returns a dict of field_name -> value for all detectable fields.
        """
        parsed: Dict[str, Any] = {}

        # --- Dates ---
        dates = self._parse_dates(raw_text)
        if len(dates) == 1:
            parsed["start_date"] = dates[0]
            parsed["end_date"] = dates[0]
        elif len(dates) >= 2:
            parsed["start_date"] = dates[0]
            parsed["end_date"] = dates[1]

        # --- Document references ---
        # ARL-XXXXXX-XX format (leave docs)
        import re
        arl_match = re.search(r'\bARL-\d{6}-\d{2,}\b', raw_text, re.IGNORECASE)
        if arl_match:
            parsed["original_leave_doc"] = arl_match.group(0).upper()

        # BC-XXXX-XXXX format (budget control no)
        bc_match = re.search(r'\bBC-\d{4}-\d{4}\b', raw_text, re.IGNORECASE)
        if bc_match:
            parsed["budget_control_no"] = bc_match.group(0).upper()

        # --- Amounts (숫자원, 콤마 숫자) ---
        amount_match = re.search(r'([\d,]+)\s*원', raw_text)
        if amount_match:
            parsed["amount"] = int(amount_match.group(1).replace(",", ""))

        # Plain large number (>= 4 digits, no trailing text = could be amount)
        if "amount" not in parsed:
            plain_num = re.search(r'\b(\d{4,})\b', raw_text)
            if plain_num:
                parsed["_raw_number"] = int(plain_num.group(1))

        # --- Destination / location ---
        dest = self._parse_destination(raw_text)
        if dest:
            parsed["destination"] = dest

        # --- Purpose / travel type from keywords ---
        purpose_kw = self._parse_purpose_keywords(raw_text)
        if purpose_kw:
            parsed["_purpose_keywords"] = purpose_kw

        # --- Leave type ---
        leave_type = self._parse_leave_type(raw_text)
        if leave_type:
            parsed["leave_type"] = leave_type

        # --- Card expense fields (AppFrm-020) ---
        if form_code == "AppFrm-020":
            # Control number: XXXXXXXX-XX
            ctrl_match = re.search(r'\b(\d{8}-\d{2})\b', raw_text)
            if ctrl_match:
                parsed["item_control_no"] = ctrl_match.group(1)

            # Amount parsing: "공급가+부가세=합계" or just total
            # Pattern: "23819+2381=26200" or "23,819+2,381=26,200"
            vat_split = re.search(r'([\d,]+)\s*\+\s*([\d,]+)\s*=\s*([\d,]+)', raw_text)
            if vat_split:
                parsed["item_amount_excl_vat"] = vat_split.group(1)
                parsed["item_vat"] = vat_split.group(2)
                parsed["item_total_amount"] = vat_split.group(3)
            elif "amount" in parsed:
                # Just total amount — estimate VAT split (10%)
                total = parsed["amount"]
                excl = round(total / 1.1)
                vat = total - excl
                parsed["item_amount_excl_vat"] = f"{excl:,}"
                parsed["item_vat"] = f"{vat:,}"
                parsed["item_total_amount"] = f"{total:,}"

            # Vendor: last Korean/English word cluster that isn't a keyword
            # Simple heuristic: find vendor-like tokens
            tokens = raw_text.split()
            skip_words = {"카드", "팀미팅", "미팅", "회의", "커피", "점심", "저녁", "원"}
            for token in tokens:
                clean = re.sub(r'[\d,원+=%]', '', token).strip()
                if clean and len(clean) >= 2 and clean not in skip_words:
                    if not re.match(r'\d{8}-\d{2}', token):
                        parsed["item_vendor"] = clean
                        break

            # Date: if parsed start_date, use as item_date
            if "start_date" in parsed:
                parsed["item_date"] = parsed["start_date"]

        return parsed

    def fill_and_validate(self, form_code: str, parsed: dict) -> dict:
        """Auto-fill form fields using templates and profiles.

        Returns structured result with auto_filled, needs_confirmation, missing_required.
        """
        classification = self._load_classification()
        form_cls = classification.get(form_code, {})
        form_name = form_cls.get("form_name", form_code)

        fields: Dict[str, Any] = {}
        auto_filled: List[str] = []
        needs_confirmation: List[Dict] = []
        missing_required: List[str] = []

        cls_fields = form_cls.get("fields", {})

        # 1. FIXED fields — fill silently
        for item in cls_fields.get("FIXED", []):
            fname = item.get("field")
            fval = item.get("value")
            if fname and fval is not None:
                fields[fname] = fval

        # 2. Merge parsed user inputs
        for k, v in parsed.items():
            if not k.startswith("_"):
                fields[k] = v

        # 3. DERIVED fields — calculate deterministically
        self._apply_derived(form_code, fields, cls_fields)

        # 4. INFERABLE_HIGH — fill and note as auto_filled
        for item in cls_fields.get("INFERABLE_HIGH", []):
            fname = item.get("field")
            if not fname or fname in fields:
                continue
            value = self._infer_high(form_code, fname, fields, parsed, item)
            if value is not None:
                fields[fname] = value
                auto_filled.append(fname)

        # 5. PROFILE_DEFAULT — fill from profile, mark needs_confirmation
        profiles = self._load_profiles()
        default_profile = self._get_default_profile(profiles)
        for item in cls_fields.get("PROFILE_DEFAULT", []):
            fname = item.get("field")
            if not fname or fname in fields:
                continue
            value, confidence = self._infer_profile(fname, default_profile, item)
            if value is not None:
                fields[fname] = value
                needs_confirmation.append({
                    "field": fname,
                    "value": value,
                    "confidence": confidence,
                    "reason": "profile default",
                })

        # 6. INFERABLE_MEDIUM — fill but mark needs_confirmation
        for item in cls_fields.get("INFERABLE_MEDIUM", []):
            fname = item.get("field")
            if not fname or fname in fields:
                continue
            value, confidence, reason = self._infer_medium(form_code, fname, fields, parsed, item)
            if value is not None:
                fields[fname] = value
                needs_confirmation.append({
                    "field": fname,
                    "value": value,
                    "confidence": confidence,
                    "reason": reason,
                })

        # 7. MANDATORY_EXACT — if not in fields, mark missing
        for item in cls_fields.get("MANDATORY_EXACT", []):
            fname = item.get("field")
            if not fname:
                continue
            if fname not in fields or fields[fname] is None:
                missing_required.append(fname)

        # 8. CONDITIONAL_OWN_VEHICLE — only if transport_mode is own vehicle
        transport = fields.get("transport_mode", "")
        if "Own Vehicle" in str(transport):
            for item in cls_fields.get("CONDITIONAL_OWN_VEHICLE", []):
                fname = item.get("field")
                category = item.get("category", "MANDATORY_EXACT")
                if not fname or fname in fields:
                    continue
                if category == "MANDATORY_EXACT":
                    missing_required.append(fname)
                elif category == "INFERABLE_HIGH":
                    # distance_km can be noted as needing Naver Maps lookup
                    needs_confirmation.append({
                        "field": fname,
                        "value": None,
                        "confidence": item.get("confidence", 0.95),
                        "reason": item.get("rule", "Naver Maps lookup needed"),
                    })

        ready = len(missing_required) == 0

        # Overall confidence: LOW if missing required, MEDIUM if confirmations, HIGH if ready
        if missing_required:
            confidence_level = "LOW"
        elif needs_confirmation:
            confidence_level = "MEDIUM"
        else:
            confidence_level = "HIGH"

        return {
            "form_code": form_code,
            "form_name": form_name,
            "fields": fields,
            "auto_filled": auto_filled,
            "needs_confirmation": needs_confirmation,
            "missing_required": missing_required,
            "ready": ready,
            "confidence_level": confidence_level,
        }

    # ------------------------------------------------------------------
    # Date parsing
    # ------------------------------------------------------------------

    def _parse_dates(self, text: str) -> List[str]:
        """Extract dates from natural language text. Returns list of YYYY-MM-DD strings."""
        import re
        today = datetime.now()
        results = []

        def _next_monday_base():
            skip = (7 - today.weekday()) % 7 or 7
            return today + timedelta(days=skip)

        def _this_monday_base():
            return today - timedelta(days=today.weekday())

        # Check ranges BEFORE single-day to avoid consuming first day of range
        # "다음주 화~수" — explicit next week range
        next_week_range = re.search(
            r'다음\s*주\s*([월화수목금토일])\s*[~\-]\s*([월화수목금토일])', text)
        if next_week_range:
            base = _next_monday_base()
            wd1 = self.WEEKDAY_KO[next_week_range.group(1)]
            wd2 = self.WEEKDAY_KO[next_week_range.group(2)]
            results.append((base + timedelta(days=wd1)).strftime("%Y-%m-%d"))
            results.append((base + timedelta(days=wd2)).strftime("%Y-%m-%d"))

        # "이번주 화~수"
        if not results:
            this_week_range = re.search(
                r'이번\s*주\s*([월화수목금토일])\s*[~\-]\s*([월화수목금토일])', text)
            if this_week_range:
                base = _this_monday_base()
                wd1 = self.WEEKDAY_KO[this_week_range.group(1)]
                wd2 = self.WEEKDAY_KO[this_week_range.group(2)]
                results.append((base + timedelta(days=wd1)).strftime("%Y-%m-%d"))
                results.append((base + timedelta(days=wd2)).strftime("%Y-%m-%d"))

        # Bare range "화~수" with context clue nearby
        if not results:
            range_match = re.search(r'([월화수목금토일])\s*[~\-]\s*([월화수목금토일])', text)
            if range_match:
                nearby = text[max(0, range_match.start() - 10):range_match.start()]
                base = _next_monday_base() if '다음' in nearby else _this_monday_base()
                wd1 = self.WEEKDAY_KO[range_match.group(1)]
                wd2 = self.WEEKDAY_KO[range_match.group(2)]
                results.append((base + timedelta(days=wd1)).strftime("%Y-%m-%d"))
                results.append((base + timedelta(days=wd2)).strftime("%Y-%m-%d"))

        # Single day: "다음주 화요일" / "다음주 화"
        if not results:
            next_week_match = re.search(r'다음\s*주\s*([월화수목금토일])', text)
            if next_week_match:
                base = _next_monday_base()
                wd = self.WEEKDAY_KO[next_week_match.group(1)]
                results.append((base + timedelta(days=wd)).strftime("%Y-%m-%d"))

        # "이번주 화" / "이번 주 화요일"
        if not results:
            this_week_match = re.search(r'이번\s*주\s*([월화수목금토일])', text)
            if this_week_match:
                base = _this_monday_base()
                wd = self.WEEKDAY_KO[this_week_match.group(1)]
                results.append((base + timedelta(days=wd)).strftime("%Y-%m-%d"))

        if results:
            return results

        # ISO date: 2026-03-25
        iso_dates = re.findall(r'\b(20\d{2})-(\d{1,2})-(\d{1,2})\b', text)
        for y, m, d in iso_dates:
            results.append(f"{y}-{int(m):02d}-{int(d):02d}")
        if results:
            return results

        # Short date: 3/25 or 3.25
        short_dates = re.findall(r'\b(\d{1,2})[/.](\d{1,2})\b', text)
        for m, d in short_dates:
            results.append(f"{today.year}-{int(m):02d}-{int(d):02d}")
        if results:
            return results

        return results

    # ------------------------------------------------------------------
    # Destination / location parsing
    # ------------------------------------------------------------------

    def _parse_destination(self, text: str) -> Optional[str]:
        """Extract destination venue/city from text."""
        text_lower = text.lower()

        # Known venue names (check verbatim first)
        venues = {
            "bexco": "BEXCO (부산)",
            "벡스코": "BEXCO (부산)",
            "coex": "COEX (서울)",
            "코엑스": "COEX (서울)",
            "kintex": "KINTEX (고양)",
            "킨텍스": "KINTEX (고양)",
            "dcc": "DCC (대전)",
            "송도": "인천 송도",
        }
        for kw, venue in venues.items():
            if kw in text_lower:
                return venue

        # City names
        cities = {
            "부산": "부산", "busan": "부산",
            "대전": "대전", "daejeon": "대전",
            "수원": "수원", "suwon": "수원",
            "서울": "서울", "seoul": "서울",
            "인천": "인천",
            "광주": "광주",
            "대구": "대구",
            "제주": "제주",
        }
        for kw, city in cities.items():
            if kw in text_lower:
                return city

        return None

    # ------------------------------------------------------------------
    # Purpose keyword parsing
    # ------------------------------------------------------------------

    def _parse_purpose_keywords(self, text: str) -> List[str]:
        """Extract purpose-related keywords from text."""
        keywords = []
        text_lower = text.lower()
        kw_map = {
            "conference": ["학회", "conference", "컨퍼런스", "심포지엄", "symposium"],
            "seminar": ["세미나", "seminar", "워크샵", "workshop"],
            "sampling": ["샘플링", "sampling", "채취", "collection"],
            "visit": ["방문", "visit", "미팅", "meeting"],
            "training": ["교육", "training", "훈련"],
            "presentation": ["발표", "presentation", "poster", "포스터", "paper"],
        }
        for category, words in kw_map.items():
            for w in words:
                if w.lower() in text_lower:
                    keywords.append(category)
                    break
        return keywords

    # ------------------------------------------------------------------
    # Leave type parsing
    # ------------------------------------------------------------------

    def _parse_leave_type(self, text: str) -> Optional[str]:
        """Detect leave type from Korean text."""
        leave_kw = {
            "annual": ["연차", "연가"],
            "compensatory": ["대휴", "보상휴가", "compensatory"],
            "half": ["반차", "half day", "오전반차", "오후반차"],
            "sick": ["병가", "병원", "sick"],
            "paternity": ["출산", "육아휴직", "paternity"],
            "special": ["특별휴가", "경조"],
            "official": ["공가", "공무"],
        }
        text_lower = text.lower()
        for leave_type, keywords in leave_kw.items():
            for kw in keywords:
                if kw in text_lower:
                    return leave_type
        return None

    # ------------------------------------------------------------------
    # Inference helpers
    # ------------------------------------------------------------------

    def _apply_derived(self, form_code: str, fields: dict, cls_fields: dict):
        """Calculate derived fields from other fields."""
        # nights/days from dates
        if "start_date" in fields and "end_date" in fields:
            try:
                sd = datetime.strptime(fields["start_date"], "%Y-%m-%d")
                ed = datetime.strptime(fields["end_date"], "%Y-%m-%d")
                nights = (ed - sd).days
                fields.setdefault("nights", nights)
                fields.setdefault("days", nights + 1)
            except (ValueError, TypeError):
                pass

    def _infer_high(self, form_code: str, fname: str, fields: dict,
                    parsed: dict, item: dict) -> Optional[Any]:
        """Infer INFERABLE_HIGH fields."""
        # subject
        if fname == "subject":
            return self._build_subject(form_code, fields)

        # daily_expense from nights
        if fname == "daily_expense":
            nights = fields.get("nights", 0)
            return 30000 if nights >= 1 else 20000

        # nights_days (already done in derived, skip)
        if fname in ("nights_days", "nights", "days"):
            return None  # already handled in _apply_derived

        # account_code from budget_type
        if fname == "account_code":
            btype = fields.get("budget_type", "R&D")
            return "410201" if "R&D" in str(btype) else "420312"

        # business_travel_type from purpose keywords
        if fname == "business_travel_type":
            kws = parsed.get("_purpose_keywords", [])
            if any(k in kws for k in ["conference", "seminar"]):
                return "Participation in the conference/seminar"
            if any(k in kws for k in ["sampling", "visit"]):
                return "Simple visit to vendor & etc"
            if "training" in kws:
                return "Training"
            if "presentation" in kws:
                return "Post or Paper presentation"
            return None

        # purpose_category (AppFrm-054) — same logic
        if fname == "purpose_category":
            kws = parsed.get("_purpose_keywords", [])
            if any(k in kws for k in ["conference", "seminar"]):
                return "Participation in the conference/seminar"
            if any(k in kws for k in ["sampling", "visit"]):
                return "Simple visit to vendor & etc"
            return None

        # predatory_check_confirmed (AppFrm-043) — always on
        if fname == "predatory_check_confirmed":
            return "on"

        # collaborator_approval_obtained — default Y
        if fname == "collaborator_approval_obtained":
            return "Y"

        # contains_ipk_confidential_info — default N
        if fname == "contains_ipk_confidential_info":
            return "N"

        # material_published — default N
        if fname == "material_published":
            return "N"

        # travel_with_invitation — default No
        if fname == "travel_with_invitation":
            return "No"

        # car_rent — default No
        if fname == "car_rent":
            return "No"

        # leave_type lookup for AppFrm-028
        if fname == "leave_type":
            # Try to get from original doc context (not available here, use default)
            return None

        return None

    def _infer_profile(self, fname: str, profile: Optional[dict],
                       item: dict) -> Tuple[Optional[Any], float]:
        """Infer PROFILE_DEFAULT fields from traveler profile."""
        if not profile:
            return None, 0.0

        if fname == "corp_card":
            corp = profile.get("corp_card", {})
            val = corp.get("default")
            conf = corp.get("confidence", 0.7)
            # Return last 4 digits for display
            if val and val != "---" and "-" in val:
                return val.split("-")[-1], conf
            return val, conf

        if fname == "traveler":
            return profile.get("traveler"), 1.0

        if fname == "budget_account_code":
            accounts = profile.get("budget_accounts", {}).get("ranked_by_recency", [])
            if accounts:
                return accounts[0], 0.8
            return None, 0.0

        if fname in ("substitute_name",):
            # Hardcoded from classification: Kyuwon's default is Guinam Wee (88%)
            return "Guinam Wee (00528)", 0.88

        if fname == "address":
            val = profile.get("address")
            return val, 0.9 if val else 0.0

        if fname == "telephone":
            val = profile.get("telephone")
            return val, 0.9 if val else 0.0

        return None, 0.0

    def _infer_medium(self, form_code: str, fname: str, fields: dict,
                      parsed: dict, item: dict) -> Tuple[Optional[Any], float, str]:
        """Infer INFERABLE_MEDIUM fields. Returns (value, confidence, reason)."""
        if fname == "transport_mode":
            dest = fields.get("destination", "")
            dest_lower = dest.lower()
            nights = fields.get("nights", 0)

            # Seoul day-trip: public transport
            if any(kw in dest_lower for kw in self.SEOUL_KEYWORDS) and nights == 0:
                return "Other Public Transportation", 0.85, "Seoul day-trip default"
            # Seoul overnight: still usually public
            if any(kw in dest_lower for kw in self.SEOUL_KEYWORDS):
                return "Other Public Transportation", 0.67, "Seoul default"
            # Busan: split
            if any(kw in dest_lower for kw in self.BUSAN_KEYWORDS):
                return "Other Public Transportation", 0.60, "Busan: public or own vehicle"
            # Suwon: own vehicle majority
            if any(kw in dest_lower for kw in self.GYEONGGI_SUWON_KEYWORDS):
                return "Own Vehicle - Gasoline", 0.67, "Suwon: own vehicle default"
            # Daejeon: own vehicle
            if any(kw in dest_lower for kw in self.DAEJEON_KEYWORDS):
                return "Own Vehicle - Gasoline", 0.85, "Daejeon: own vehicle default"

            return None, 0.0, ""

        if fname in ("start_time", "end_time"):
            nights = fields.get("nights", 0)
            if nights == 0:  # day-trip only
                val = "09:00" if fname == "start_time" else "18:00"
                return val, 0.66, "day-trip default time"
            return None, 0.0, ""

        if fname in ("transport_fee", "accommodation", "food_expense"):
            return 0, 0.60, "default 0, provide actual amount"

        if fname == "venue":
            return "4th floor meeting room", 0.88, "lab default venue"

        if fname == "participants":
            return None, 0.70, "recurring team members — specify"

        if fname == "budget_type":
            return "R&D", 0.84, "R&D default (84% of docs)"

        return None, 0.0, ""

    def _build_subject(self, form_code: str, fields: dict) -> Optional[str]:
        """Build subject line from available fields."""
        dest = fields.get("destination", "")
        start = fields.get("start_date", "")
        end = fields.get("end_date", "")
        purpose_kws = fields.get("_purpose_keywords", [])

        date_str = start if start == end else f"{start}~{end}"

        if form_code == "AppFrm-023":
            # [Travel] Destination Purpose dates
            purpose_label = "Conference" if "conference" in purpose_kws or "seminar" in purpose_kws else "Visit"
            if dest:
                return f"[Travel] {dest} {purpose_label} {date_str}".strip()
            return f"[Travel] Business Trip {date_str}".strip()

        if form_code == "AppFrm-054":
            return f"[Settlement] {dest} {date_str}".strip()

        if form_code == "AppFrm-073":
            leave_type = fields.get("leave_type", "Annual")
            return f"{leave_type}, {date_str}".strip()

        if form_code == "AppFrm-020":
            return f"[Card] ER_Team activities"

        if form_code == "AppFrm-028":
            original = fields.get("original_leave_doc", "")
            return f"Leave return {original}".strip()

        if form_code == "AppFrm-026":
            country = fields.get("country", "")
            conf = fields.get("conference_name", "")
            return f"[Settlement] {conf or country}".strip()

        return None

    # ------------------------------------------------------------------
    # Data loaders
    # ------------------------------------------------------------------

    def _load_profiles(self) -> Dict:
        if self._profiles is None:
            try:
                with open(self._profiles_path, "r", encoding="utf-8") as f:
                    self._profiles = json.load(f)
            except (FileNotFoundError, json.JSONDecodeError):
                self._profiles = {}
        return self._profiles

    def _load_classification(self) -> Dict:
        if self._classification is None:
            try:
                with open(self._classification_path, "r", encoding="utf-8") as f:
                    self._classification = json.load(f)
            except (FileNotFoundError, json.JSONDecodeError):
                self._classification = {}
        return self._classification

    def _get_default_profile(self, profiles: Dict) -> Optional[Dict]:
        """Return the Kyuwon Shim profile as default (primary user)."""
        for key, val in profiles.items():
            if "Kyuwon" in key or "00565" in key:
                return val
        # Fallback: first profile
        if profiles:
            return next(iter(profiles.values()))
        return None


def main():
    import argparse

    parser = argparse.ArgumentParser(description="문서 자동화 에이전트")
    parser.add_argument("form_type", nargs="?", default=None,
                        help="문서 유형 (leave/working/expense/travel/smart)")
    parser.add_argument("text", nargs="?", default=None,
                        help="smart 모드: 자연어 입력 텍스트")
    parser.add_argument("--check", "-c", action="store_true",
                        help="요구사항만 확인")
    parser.add_argument("--non-interactive", "-n", action="store_true",
                        help="비대화형 모드 (JSON 입력)")
    parser.add_argument("--json", "-j", action="store_true",
                        help="smart 모드: JSON 출력 (skill/MCP 연동용)")

    args = parser.parse_args()

    # Smart form agent mode
    if args.form_type == "smart":
        raw = args.text or ""
        if not raw:
            print("Usage: python document_agent.py smart \"<natural language input>\"")
            print("Example: python document_agent.py smart \"다음주 화 COEX 학회 BC-2026-0045\"")
            return

        agent = SmartFormAgent()
        try:
            form_code = agent.classify_form(raw)
        except ValueError as e:
            print(f"Error: {e}")
            return

        parsed = agent.parse_input(raw, form_code)
        result = agent.fill_and_validate(form_code, parsed)

        # MCP form_type mapping
        MCP_FORM_TYPE = {
            "AppFrm-023": "travel_request",
            "AppFrm-054": "travel_settlement",
            "AppFrm-073": "leave",
            "AppFrm-028": "leave_return",
            "AppFrm-020": "card_expense",
            "AppFrm-043": "seminar_disclosure",
            "AppFrm-026": "overseas_travel",
            "AppFrm-039": "budget_transfer",
        }
        result["mcp_form_type"] = MCP_FORM_TYPE.get(form_code, form_code)

        if args.json:
            # Clean fields: remove internal keys starting with _
            clean_fields = {k: v for k, v in result["fields"].items()
                           if not k.startswith("_")}
            result["fields"] = clean_fields
            print(json.dumps(result, ensure_ascii=False, indent=2, default=str))
            return

        print(f"\nForm: {result['form_code']} - {result['form_name']}")
        print(f"Confidence: {result['confidence_level']}")
        print("=" * 60)

        print("\nAuto-filled fields (green):")
        for f in result["auto_filled"]:
            print(f"  [auto] {f}: {result['fields'].get(f)}")

        print("\nNeeds confirmation (yellow):")
        for item in result["needs_confirmation"]:
            print(f"  [confirm] {item['field']}: {item['value']} ({item['confidence']:.0%}) — {item['reason']}")

        if result["missing_required"]:
            print("\nMissing required fields (red):")
            for f in result["missing_required"]:
                print(f"  [MISSING] {f}")

        print(f"\nReady to submit: {result['ready']}")
        print(f"MCP form_type: {result['mcp_form_type']}")
        return

    # Original DocumentAgent modes
    agent = DocumentAgent()
    valid_types = list(DocumentAgent.FORM_REQUIREMENTS.keys())

    if not args.form_type:
        print("\n문서 자동화 에이전트")
        print("=" * 40)
        print("\n사용 가능한 문서 유형:")
        for form_type in valid_types:
            reqs = agent.get_requirements(form_type)
            print(f"\n  {form_type}:")
            print(f"    필수: {', '.join(reqs['required'])}")
            print(f"    이력추론: {', '.join(reqs['history_infer']) or '없음'}")
        print("\n  smart: 자연어 입력 → 폼 자동 분류 및 작성")
        print("    예: python document_agent.py smart \"다음주 화 COEX 학회 BC-2026-0045\"")
        return

    if args.form_type not in valid_types:
        print(f"알 수 없는 문서 유형: {args.form_type}")
        print(f"사용 가능: {', '.join(valid_types + ['smart'])}")
        return

    if args.non_interactive:
        print("\n⚠️  비대화형 모드는 현재 지원되지 않습니다.")
        print("대화형 모드로 실행하려면 --non-interactive 옵션을 제거하세요.")
        return

    if args.check:
        reqs = agent.get_requirements(args.form_type)
        print(f"\n[{args.form_type.upper()}] 요구사항")
        print("=" * 40)
        print(f"\n필수 입력: {', '.join(reqs['required'])}")
        print(f"선택 입력: {', '.join(reqs['optional'])}")
        print(f"이력 추론 가능: {', '.join(reqs['history_infer'])}")
        print(f"자동 추론: {', '.join(reqs['auto_infer'])}")

        # 이력 기반 추론 테스트
        if HISTORY_AVAILABLE:
            print("\n현재 이력 기반 추론:")
            inferred = agent.infer_from_history(args.form_type)
            if inferred:
                for field, (value, conf, method) in inferred.items():
                    print(f"  {field}: {value} ({conf:.0%}, {method})")
            else:
                print("  (이력 없음)")
        return

    # 대화형 세션
    agent.interactive_session(args.form_type)


if __name__ == "__main__":
    main()
