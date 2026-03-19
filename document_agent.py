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


def main():
    import argparse

    parser = argparse.ArgumentParser(description="문서 자동화 에이전트")
    parser.add_argument("form_type", nargs="?", default=None,
                        choices=["leave", "working", "expense", "travel"],
                        help="문서 유형")
    parser.add_argument("--check", "-c", action="store_true",
                        help="요구사항만 확인")
    parser.add_argument("--non-interactive", "-n", action="store_true",
                        help="비대화형 모드 (JSON 입력)")

    args = parser.parse_args()

    agent = DocumentAgent()

    if not args.form_type:
        print("\n문서 자동화 에이전트")
        print("=" * 40)
        print("\n사용 가능한 문서 유형:")
        for form_type in DocumentAgent.FORM_REQUIREMENTS.keys():
            reqs = agent.get_requirements(form_type)
            print(f"\n  {form_type}:")
            print(f"    필수: {', '.join(reqs['required'])}")
            print(f"    이력추론: {', '.join(reqs['history_infer']) or '없음'}")
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
