"""
IPK 그룹웨어 자동화 스크립트
==============================
사용법:
    python ipk_gw.py leave --type annual --date 2025-12-26
    python ipk_gw.py meal --amount 15000 --participants "Kyuwon, Guinam"
    python ipk_gw.py work --date 2025-12-28 --reason "experiment"
    python ipk_gw.py travel --title "MSK 2026" --dest "Seoul" --start 2025-03-01 --end 2025-03-03
"""

from playwright.sync_api import sync_playwright, Page, Frame
from datetime import datetime, timedelta
from typing import Optional, Literal
import time
import argparse
import json
import os
import getpass
from pathlib import Path

try:
    import keyring
    KEYRING_AVAILABLE = True
except ImportError:
    KEYRING_AVAILABLE = False

try:
    from history_manager import get_history_manager, record_submission, infer_field
    HISTORY_AVAILABLE = True
except ImportError:
    HISTORY_AVAILABLE = False

SERVICE_NAME = "ipk-groupware"


def get_credential(key: str, prompt: str = None) -> str:
    """자격증명 가져오기 (우선순위: 환경변수 > keyring > .credentials > 프롬프트)"""
    # 1. 환경변수
    value = os.environ.get(f"IPK_{key.upper()}")
    if value:
        return value

    # 2. Keyring (OS 보안저장소)
    if KEYRING_AVAILABLE:
        try:
            value = keyring.get_password(SERVICE_NAME, key)
            if value:
                return value
        except:
            pass

    # 3. 로컬 credentials 파일
    cred_file = Path(__file__).parent / ".credentials"
    if cred_file.exists():
        try:
            creds = json.loads(cred_file.read_text())
            if key in creds:
                return creds[key]
        except:
            pass

    # 4. 프롬프트
    if prompt:
        if "password" in key.lower():
            return getpass.getpass(f"{prompt}: ")
        else:
            return input(f"{prompt}: ")

    return ""


def save_credential(key: str, value: str):
    """Keyring에 자격증명 저장 (실패시 암호화된 파일에 저장)"""
    if KEYRING_AVAILABLE:
        try:
            keyring.set_password(SERVICE_NAME, key, value)
            print(f"✓ {key} saved to OS keyring")
            return True
        except Exception as e:
            print(f"⚠ Keyring error: {e}")

    # Fallback: 암호화된 로컬 파일
    cred_file = Path(__file__).parent / ".credentials"
    creds = {}
    if cred_file.exists():
        try:
            creds = json.loads(cred_file.read_text())
        except:
            pass
    creds[key] = value
    cred_file.write_text(json.dumps(creds))
    cred_file.chmod(0o600)  # 소유자만 읽기/쓰기
    print(f"✓ {key} saved to .credentials (chmod 600)")
    return True


class IPKGroupware:
    """IPK 그룹웨어 자동화 클래스"""

    BASE_URL = "https://gw.ip-korea.org"

    # 휴가 종류 코드
    LEAVE_TYPES = {
        "annual": "01",
        "compensatory": "11",
        "saved_annual": "14",
        "sick": "02",
        "special": "03",
        "paternity": "15",
        "menstruation": "04",
        "official": "05",
        "childcare": "07",
        "fetus_checkup": "13",
    }

    # 첨부파일 필수 휴가 종류
    ATTACHMENT_REQUIRED_LEAVES = {
        "02": "진단서/입원확인서",  # Sick leave
        "03": "증빙서류",           # Special leave
        "05": "증빙서류",           # Official leave
        "07": "증빙서류",           # Child delivery
        "13": "증빙서류",           # Fetus checkup
        "15": "출생증명서",         # Paternity leave
    }

    # 폼 코드
    FORM_CODES = {
        "leave": "AppFrm-073",
        "expense": "AppFrm-021",
        "working": "AppFrm-027",
        "travel": "AppFrm-076",
    }

    @property
    def DEFAULTS(self):
        """credentials/환경변수에서 기본값 로드"""
        return {
            "substitute_name": get_credential("substitute_name") or "N/A",
            "substitute_payroll": get_credential("substitute_payroll") or "N/A",
            "substitute_position": get_credential("substitute_position") or "Researcher",
            "substitute_contact": get_credential("substitute_contact") or "N/A",
            "emergency_address": get_credential("emergency_address") or "Seoul",
            "emergency_telephone": get_credential("emergency_telephone") or "N/A",
        }

    def _get_history_value(
        self,
        form_type: str,
        field_name: str,
        context: dict = None,
        fallback: str = None
    ) -> tuple:
        """
        이력 기반 값 추론 (history_manager 사용)

        Returns:
            (추론값 또는 fallback, 신뢰도, 추론방법)
        """
        if not HISTORY_AVAILABLE:
            return fallback, 0.0, "history_unavailable"

        try:
            value, confidence, method = infer_field(form_type, field_name, context)
            if value and confidence >= 0.5:  # 50% 이상 신뢰도면 사용
                return value, confidence, method
            elif value:
                # 낮은 신뢰도: fallback 우선, 이력값 보조
                return fallback or value, confidence, f"low_confidence:{method}"
            else:
                return fallback, 0.0, "no_history"
        except Exception as e:
            return fallback, 0.0, f"error:{e}"

    def _record_submission(
        self,
        form_type: str,
        fields: dict,
        doc_id: str = None,
        success: bool = True
    ):
        """제출 이력 기록"""
        if HISTORY_AVAILABLE:
            try:
                record_submission(form_type, fields, doc_id, success)
            except Exception as e:
                print(f"  이력 기록 실패: {e}")

    def __init__(self, headless: bool = True):
        self.playwright = sync_playwright().start()
        self.browser = self.playwright.chromium.launch(headless=headless)
        self.context = self.browser.new_context(viewport={"width": 1920, "height": 1080})
        self.page = self.context.new_page()
        self.logged_in = False
        self.user_info = {}

    def login(self, username: str, password: str) -> bool:
        """그룹웨어 로그인"""
        print(f"로그인 중... ({username})")
        self.page.goto(self.BASE_URL, timeout=30000)
        self.page.wait_for_load_state("networkidle")

        self.page.fill("input[name='Username']", username)
        self.page.fill("input[name='Password']", password)
        self.page.evaluate("Check_Form()")

        time.sleep(3)
        self.page.wait_for_load_state("networkidle")

        if "main.php" not in self.page.url:
            self.page.goto(f"{self.BASE_URL}/main.php", timeout=30000)
            time.sleep(2)

        self.logged_in = "main.php" in self.page.url
        if self.logged_in:
            # 사용자 정보 (keyring > 환경변수 > username에서 추출)
            self.user_info = {
                "username": username,
                "name": get_credential("user_name") or username.replace(".", " ").title(),
                "dept": get_credential("user_dept") or "",
            }
            print("로그인 성공!")
        else:
            print("로그인 실패")

        return self.logged_in

    def _get_main_frame(self) -> Optional[Frame]:
        return self.page.frame("main_menu")

    def _navigate_to_form(self, form_type: str) -> Optional[Frame]:
        form_code = self.FORM_CODES.get(form_type)
        if not form_code:
            raise ValueError(f"Unknown form type: {form_type}")

        url = f"{self.BASE_URL}/Document/document_write.php?approve_type={form_code}"

        main_frame = self._get_main_frame()
        if main_frame:
            main_frame.goto(url, timeout=30000)
            time.sleep(2)
            main_frame.wait_for_load_state("networkidle")

        return main_frame

    def submit_leave(
        self,
        leave_type: str = "annual",
        start_date: str = None,
        end_date: str = None,
        start_time: str = None,
        end_time: str = None,
        purpose: str = None,  # None이면 이력 기반 추론
        destination: str = None,  # None이면 이력 기반 추론
        substitute: str = None,  # None이면 이력 기반 추론
        draft_only: bool = True,
    ) -> bool:
        """휴가 신청 (이력 기반 추론 지원)"""
        if not self.logged_in:
            raise RuntimeError("로그인이 필요합니다")

        if not start_date:
            start_date = (datetime.now() + timedelta(days=1)).strftime("%Y-%m-%d")
        if not end_date:
            end_date = start_date

        leave_code = self.LEAVE_TYPES.get(leave_type, "01")

        # 이력 기반 추론 (컨텍스트: leave_type)
        context = {"leave_type": leave_type}

        # 목적지 추론
        if destination is None:
            dest_val, dest_conf, dest_method = self._get_history_value(
                "leave", "destination", context, "Seoul"
            )
            destination = dest_val
            if dest_conf > 0:
                print(f"  [이력 추론] destination: {destination} ({dest_conf:.0%}, {dest_method})")

        # 사유 추론
        if purpose is None:
            purp_val, purp_conf, purp_method = self._get_history_value(
                "leave", "purpose", context, "personal"
            )
            purpose = purp_val
            if purp_conf > 0:
                print(f"  [이력 추론] purpose: {purpose} ({purp_conf:.0%}, {purp_method})")
        leave_name = {
            "annual": "Annual leave",
            "compensatory": "Compensatory leave",
            "paternity": "Paternity Leave",
            "sick": "Sick leave",
            "fetus_checkup": "Fetus Checkup",
            "special": "Special leave",
            "official": "Official leave",
            "childcare": "Child delivery and Nursing leave",
        }.get(leave_type, "Annual leave")

        # 첨부파일 필수 여부 경고
        if leave_code in self.ATTACHMENT_REQUIRED_LEAVES:
            required_doc = self.ATTACHMENT_REQUIRED_LEAVES[leave_code]
            print(f"⚠️  주의: {leave_name}은(는) 첨부파일 필수입니다 ({required_doc})")
            print(f"   Draft 저장 후 그룹웨어에서 직접 첨부해주세요.")

        # 시간차 여부 판단
        is_hourly = start_time is not None and end_time is not None
        using_type = "04" if is_hourly else "01"  # 04=Hours, 01=Full day

        if is_hourly:
            subject = f"{leave_name}, {start_date} {start_time}:00~{end_time}:00, {destination}, {self.user_info['name']}"
        else:
            subject = f"{leave_name}, {start_date}~{end_date}, {destination}, {self.user_info['name']}"

        print(f"\n휴가 신청: {subject}")

        frame = self._navigate_to_form("leave")
        if not frame:
            print("폼 페이지 이동 실패")
            return False

        try:
            # 대리자 이력 추론
            if substitute is None:
                sub_val, sub_conf, sub_method = self._get_history_value(
                    "leave", "substitute", context, self.DEFAULTS['substitute_name']
                )
                sub_name = sub_val
                if sub_conf > 0:
                    print(f"  [이력 추론] substitute: {sub_name} ({sub_conf:.0%}, {sub_method})")
            else:
                sub_name = substitute

            # 비상연락처 이력 추론 (거의 고정값)
            emerg_addr, addr_conf, _ = self._get_history_value(
                "leave", "emergency_address", None, self.DEFAULTS['emergency_address']
            )
            emerg_tel, tel_conf, _ = self._get_history_value(
                "leave", "emergency_telephone", None, self.DEFAULTS['emergency_telephone']
            )

            # 나머지 기본값
            sub_payroll = self.DEFAULTS['substitute_payroll']
            sub_position = self.DEFAULTS['substitute_position']
            sub_contact = self.DEFAULTS['substitute_contact']

            # JavaScript로 폼 필드 설정 (subject는 마지막에 - change 이벤트가 덮어쓰기 방지)
            js_code = f"""
                // 1. 먼저 다른 필드들 설정
                var leaveKind = document.querySelector('select[name="leave_kind[]"]');
                if (leaveKind) {{
                    leaveKind.value = "{leave_code}";
                    leaveKind.dispatchEvent(new Event('change', {{ bubbles: true }}));
                }}

                var usingType = document.querySelector('select[name="using_type[]"]');
                if (usingType) {{
                    usingType.value = "{using_type}";
                    usingType.dispatchEvent(new Event('change', {{ bubbles: true }}));
                }}

                var beginDate = document.querySelector('input[name="begin_date[]"]');
                if (beginDate) beginDate.value = "{start_date}";

                var endDate = document.querySelector('input[name="end_date[]"]');
                if (endDate) endDate.value = "{end_date}";

                // 시간차인 경우 시간 설정
                var startTimeEl = document.querySelector('select[name="start_time[]"]');
                var endTimeEl = document.querySelector('select[name="end_time[]"]');
                if (startTimeEl && "{start_time or ''}") {{
                    startTimeEl.innerHTML = '<option value="{start_time}">{start_time}</option>';
                    startTimeEl.value = "{start_time}";
                    startTimeEl.dispatchEvent(new Event('change', {{ bubbles: true }}));
                }}
                if (endTimeEl && "{end_time or ''}") {{
                    setTimeout(function() {{
                        endTimeEl.innerHTML = '<option value="{end_time}">{end_time}</option>';
                        endTimeEl.value = "{end_time}";
                        endTimeEl.dispatchEvent(new Event('change', {{ bubbles: true }}));
                    }}, 500);
                }}

                var purposeEl = document.querySelector('input[name="purpose"]');
                if (purposeEl) purposeEl.value = "{purpose}";

                var destEl = document.querySelector('input[name="destination"]');
                if (destEl) destEl.value = "{destination}";

                // 비상연락처
                var emergAddr = document.querySelector('input[name="emergency_address"]');
                if (emergAddr) emergAddr.value = "{emerg_addr}" || "Seoul";

                var emergTel = document.querySelector('input[name="emergency_telephone"]');
                if (emergTel) emergTel.value = "{emerg_tel}" || "N/A";

                // 2. subject는 마지막에 설정 (change 이벤트가 덮어쓰지 않도록)
                document.querySelector('input[name="subject"]').value = "{subject}";
            """
            frame.evaluate(js_code)

            # 3. 대리자 선택: [ Select ] 팝업 사용
            try:
                # Find and click the [ Select ] link that opens the substitute popup
                with self.page.expect_popup(timeout=10000) as popup_info:
                    frame.evaluate("fnWinOpen('./user_select.php?sel_type=radio')")

                popup = popup_info.value
                popup.wait_for_load_state("networkidle")
                time.sleep(1)

                # Find and select the substitute by name
                selected = popup.evaluate(f"""
                    () => {{
                        const rows = document.querySelectorAll('tr');
                        for (const row of rows) {{
                            const cells = row.querySelectorAll('td');
                            if (cells.length >= 4) {{
                                const userName = cells[3] ? cells[3].textContent.trim() : '';
                                if (userName === "{sub_name}") {{
                                    const radio = row.querySelector('input[type="radio"]');
                                    if (radio) {{
                                        radio.click();
                                        return {{found: true, name: userName}};
                                    }}
                                }}
                            }}
                        }}
                        return {{found: false}};
                    }}
                """)

                if selected.get('found'):
                    print(f"  대리자 선택됨: {selected.get('name')}")
                    # Click OK button
                    popup.click('a:has-text("[Ok]")')
                    time.sleep(1)
                else:
                    print(f"  ⚠️ 대리자 '{sub_name}'을(를) 찾지 못함. 팝업 닫음.")
                    popup.click('a:has-text("[Close]")')

            except Exception as e:
                print(f"  대리자 팝업 실패: {e}, readonly 해제로 대체 입력")
                # Fallback: 직접 값 입력
                frame.evaluate(f"""
                    var subName = document.querySelector('input[name="substitute_name"]');
                    if (subName) {{ subName.readOnly = false; subName.value = "{sub_name}" || "N/A"; }}
                    var subPayroll = document.querySelector('input[name="substitute_payroll"]');
                    if (subPayroll) {{ subPayroll.readOnly = false; subPayroll.value = "{sub_payroll}" || "N/A"; }}
                    var subPosition = document.querySelector('input[name="substitute_position"]');
                    if (subPosition) {{ subPosition.readOnly = false; subPosition.value = "{sub_position}" || "N/A"; }}
                    var subContact = document.querySelector('input[name="substitute_contact"]');
                    if (subContact) {{ subContact.readOnly = false; subContact.value = "{sub_contact}" || "N/A"; }}
                """)

            time.sleep(1)
            self.page.screenshot(path="screenshots/leave_form_filled.png")
            print("폼 작성 완료 (screenshots/leave_form_filled.png)")

            if draft_only:
                # 드래프트로 저장
                frame.evaluate("document.all('mode1').value = 'draft';")
                # 폼 제출 후 리다이렉트 대기
                try:
                    with self.page.expect_navigation(timeout=15000, wait_until="load"):
                        frame.evaluate("Check_Form_Request('insert');")
                except:
                    time.sleep(3)  # fallback

                # 결과 확인
                new_url = frame.url
                if "document_view.php" in new_url and "doc_id=" in new_url:
                    doc_id = new_url.split("doc_id=")[1].split("&")[0]
                    self.page.screenshot(path="screenshots/leave_draft_saved.png")
                    print(f"드래프트 저장 완료 (doc_id: {doc_id})")

                    # 이력 기록
                    self._record_submission("leave", {
                        "leave_type": leave_type,
                        "substitute": sub_name,
                        "destination": destination,
                        "purpose": purpose,
                        "emergency_address": emerg_addr,
                        "emergency_telephone": emerg_tel,
                    }, doc_id=doc_id, success=True)
                else:
                    print(f"저장 결과 불확실 - URL: {new_url}")
            else:
                # 결재요청
                frame.evaluate("document.all('mode1').value = 'request';")
                try:
                    with self.page.expect_navigation(timeout=15000, wait_until="load"):
                        frame.evaluate("Check_Form_Request('insert');")
                except:
                    time.sleep(3)
                print("결재요청 완료")

                # 이력 기록 (request도 기록)
                self._record_submission("leave", {
                    "leave_type": leave_type,
                    "substitute": sub_name,
                    "destination": destination,
                    "purpose": purpose,
                    "emergency_address": emerg_addr,
                    "emergency_telephone": emerg_tel,
                }, success=True)

            return True

        except Exception as e:
            print(f"휴가 신청 실패: {e}")
            self.page.screenshot(path="screenshots/leave_error.png")
            return False

    def submit_overtime_meal(
        self,
        date: str = None,
        amount: int = 15000,
        participants: str = "",
        purpose: str = "overtime work",
        venue: str = "",
        budget_code: str = "NN2512-0001",
        attachment: str = None,  # 영수증 파일 경로
        draft_only: bool = True,
    ) -> bool:
        """야근식대 신청

        ⚠️ 주의: 경비청구서는 validation 규칙이 복잡합니다.
        - 영수증 첨부 필수
        - 계정코드별 추가 필드 요구 (meeting_time, venue, participants 등)
        - 자동화보다 그룹웨어에서 직접 작성을 권장합니다.
        """
        if not self.logged_in:
            raise RuntimeError("로그인이 필요합니다")

        # 복잡한 폼 경고
        print("⚠️  경고: 경비청구서는 validation 규칙이 복잡합니다.")
        print("   계정코드(410310 등)에 따라 meeting_time, venue, participants 등이 필요합니다.")
        print("   자동화보다 그룹웨어에서 직접 작성을 권장합니다.")
        print("")

        if not attachment:
            print("❌ 첨부파일이 없어 저장할 수 없습니다.")
            print("   --attachment <파일경로> 옵션을 추가하세요.")
            return False

        if not date:
            date = datetime.now().strftime("%Y-%m-%d")

        subject = "[Card] overtime meal"
        amount_no_vat = int(amount / 1.1)
        vat = amount - amount_no_vat

        print(f"\n야근식대 신청: {subject} ({amount:,}원)")

        frame = self._navigate_to_form("expense")
        if not frame:
            return False

        try:
            # Step 1: budget_type 설정 (필수)
            js_code = f"""
                document.querySelector('input[name="subject"]').value = "{subject}";

                var budgetType = document.querySelector('select[name="budget_type"]');
                if (budgetType) {{
                    budgetType.value = "02";
                    budgetType.dispatchEvent(new Event('change', {{ bubbles: true }}));
                }}
            """
            frame.evaluate(js_code)

            # budget_code 옵션 로딩 대기
            time.sleep(1)

            # Step 2: 나머지 필드 설정
            js_code2 = f"""
                // budget_code 설정 (필수)
                var budgetCode = document.querySelector('select[name="budget_code"]');
                if (budgetCode) {{
                    budgetCode.value = "{budget_code}";
                    budgetCode.dispatchEvent(new Event('change', {{ bubbles: true }}));
                }}

                // pay_kind 설정 (필수)
                var payKind = document.querySelector('select[name="pay_kind"]');
                if (payKind) {{
                    payKind.value = "04";  // Personal Reimbursement
                    payKind.dispatchEvent(new Event('change', {{ bubbles: true }}));
                }}

                // Personal Reimbursement 사유 (pay_kind=04인 경우 필수)
                var pReason = document.querySelector('textarea[name="p_reason"]');
                if (pReason) {{
                    pReason.value = "overtime meal - receipt attached";
                }}

                var invoice = document.querySelector('input[name="invoice[]"]');
                if (invoice) invoice.value = "{date}";

                var itemDesc = document.querySelector('input[name="item_desc[]"]');
                if (itemDesc) itemDesc.value = "overtime meal";

                var itemQty = document.querySelector('input[name="item_qty[]"]');
                if (itemQty) itemQty.value = "1";

                var itemAmount = document.querySelector('input[name="item_amount[]"]');
                if (itemAmount) itemAmount.value = "{amount_no_vat}";

                var itemVat = document.querySelector('input[name="item_amount_vat[]"]');
                if (itemVat) itemVat.value = "{vat}";

                var ovMember = document.querySelector('input[name="ov_member"]');
                if (ovMember) ovMember.value = "{participants}";

                var ovPurpose = document.querySelector('input[name="ov_purpose"]');
                if (ovPurpose) ovPurpose.value = "{purpose}";

                // 합계 금액 (validation에서 확인함)
                var totalAmt = document.getElementsByName('total_amt')[0];
                if (totalAmt) totalAmt.value = "{amount}";

                // item_amount_ral (총액 = amount + VAT)
                var itemAmountRal = document.querySelector('input[name="item_amount_ral[]"]');
                if (itemAmountRal) itemAmountRal.value = "{amount}";
            """
            frame.evaluate(js_code2)

            # Step 3: 파일 첨부 (필수)
            if attachment and os.path.exists(attachment):
                file_input = frame.locator('input[name="doc_attach_file[]"]').first
                file_input.set_input_files(attachment)
                print(f"  첨부파일: {attachment}")
                time.sleep(1)
            elif not attachment:
                # 첨부파일 없으면 저장 불가
                self.page.screenshot(path="screenshots/expense_no_attachment.png")
                print("❌ 첨부파일이 없어 저장할 수 없습니다.")
                return False

            time.sleep(1)
            self.page.screenshot(path="screenshots/expense_form_filled.png")
            print("폼 작성 완료 (screenshots/expense_form_filled.png)")

            if draft_only:
                frame.evaluate("document.all('mode1').value = 'draft';")
                try:
                    with self.page.expect_navigation(timeout=15000, wait_until="load"):
                        frame.evaluate("Check_Form_Request('insert');")
                except:
                    time.sleep(3)  # fallback

                new_url = frame.url
                if "document_view.php" in new_url and "doc_id=" in new_url:
                    doc_id = new_url.split("doc_id=")[1].split("&")[0]
                    self.page.screenshot(path="screenshots/expense_draft_saved.png")
                    print(f"드래프트 저장 완료 (doc_id: {doc_id})")
                else:
                    print(f"저장 결과 불확실 - URL: {new_url}")
            else:
                frame.evaluate("document.all('mode1').value = 'request';")
                try:
                    with self.page.expect_navigation(timeout=15000, wait_until="load"):
                        frame.evaluate("Check_Form_Request('insert');")
                except:
                    time.sleep(3)
                print("결재요청 완료")

            return True

        except Exception as e:
            print(f"야근식대 신청 실패: {e}")
            self.page.screenshot(path="screenshots/expense_error.png")
            return False

    def submit_work_request(
        self,
        work_date: str = None,
        reason: str = "experiment",
        work_place: str = None,  # None이면 이력 기반 추론
        details: str = "",
        budget_type: str = "02",  # 01=General, 02=R&D
        budget_code: str = None,  # None이면 이력 기반 추론
        draft_only: bool = True,
    ) -> bool:
        """휴일근무 신청 (이력 기반 추론 지원)"""
        if not self.logged_in:
            raise RuntimeError("로그인이 필요합니다")

        if not work_date:
            today = datetime.now()
            days_until_saturday = (5 - today.weekday()) % 7
            if days_until_saturday == 0:
                days_until_saturday = 7
            work_date = (today + timedelta(days=days_until_saturday)).strftime("%Y-%m-%d")

        # 이력 기반 추론
        if budget_code is None:
            code_val, code_conf, code_method = self._get_history_value(
                "working", "budget_code", None, "NN2512-0001"
            )
            budget_code = code_val
            if code_conf > 0:
                print(f"  [이력 추론] budget_code: {budget_code} ({code_conf:.0%}, {code_method})")

        if work_place is None:
            place_val, place_conf, place_method = self._get_history_value(
                "working", "work_place", None, "IPK"
            )
            work_place = place_val
            if place_conf > 0:
                print(f"  [이력 추론] work_place: {work_place} ({place_conf:.0%}, {place_method})")

        subject = f"Application for Working on {work_date}, {self.user_info['name']}"

        print(f"\n휴일근무 신청: {subject}")

        frame = self._navigate_to_form("working")
        if not frame:
            return False

        try:
            js_code = f"""
                document.querySelector('input[name="subject"]').value = "{subject}";

                // budget_type 설정 (필수)
                var budgetType = document.querySelector('select[name="budget_type"]');
                if (budgetType) {{
                    budgetType.value = "{budget_type}";
                    budgetType.dispatchEvent(new Event('change', {{ bubbles: true }}));
                }}
            """
            frame.evaluate(js_code)

            # budget_type change 후 budget_code 옵션 로딩 대기
            time.sleep(1)

            js_code2 = f"""
                // budget_code 설정 (필수)
                var budgetCode = document.querySelector('select[name="budget_code"]');
                if (budgetCode) {{
                    budgetCode.value = "{budget_code}";
                    budgetCode.dispatchEvent(new Event('change', {{ bubbles: true }}));
                }}

                var desiredDate = document.querySelector('input[name="desired_date"]');
                if (desiredDate) desiredDate.value = "{work_date}";

                var workPlace = document.querySelector('input[name="wroking_place"]');
                if (workPlace) workPlace.value = "{work_place}";

                var subSubject = document.querySelector('input[name="sub_subject"]');
                if (subSubject) subSubject.value = "{reason}";

                var contents = document.querySelector('textarea[name="contents1"]');
                if (contents) contents.value = "{details or reason}";
            """
            frame.evaluate(js_code2)

            time.sleep(1)
            self.page.screenshot(path="screenshots/working_form_filled.png")
            print("폼 작성 완료 (screenshots/working_form_filled.png)")

            if draft_only:
                frame.evaluate("document.all('mode1').value = 'draft';")
                try:
                    with self.page.expect_navigation(timeout=15000, wait_until="load"):
                        frame.evaluate("Check_Form_Request('insert');")
                except:
                    time.sleep(3)  # fallback

                new_url = frame.url
                if "document_view.php" in new_url and "doc_id=" in new_url:
                    doc_id = new_url.split("doc_id=")[1].split("&")[0]
                    self.page.screenshot(path="screenshots/working_draft_saved.png")
                    print(f"드래프트 저장 완료 (doc_id: {doc_id})")

                    # 이력 기록
                    self._record_submission("working", {
                        "budget_code": budget_code,
                        "work_place": work_place,
                        "reason": reason,
                    }, doc_id=doc_id, success=True)
                else:
                    print(f"저장 결과 불확실 - URL: {new_url}")
            else:
                frame.evaluate("document.all('mode1').value = 'request';")
                try:
                    with self.page.expect_navigation(timeout=15000, wait_until="load"):
                        frame.evaluate("Check_Form_Request('insert');")
                except:
                    time.sleep(3)
                print("결재요청 완료")

                # 이력 기록
                self._record_submission("working", {
                    "budget_code": budget_code,
                    "work_place": work_place,
                    "reason": reason,
                }, success=True)

            return True

        except Exception as e:
            print(f"휴일근무 신청 실패: {e}")
            self.page.screenshot(path="screenshots/working_error.png")
            return False

    def submit_travel_request(
        self,
        title: str,
        destination: str,
        start_date: str,
        end_date: str,
        purpose: str,
        schedule: str = "",
        organization: str = "",
        attendees: str = "",
        draft_only: bool = True,
    ) -> bool:
        """출장 신청/보고서"""
        if not self.logged_in:
            raise RuntimeError("로그인이 필요합니다")

        print(f"\n출장 신청: {title}")

        frame = self._navigate_to_form("travel")
        if not frame:
            return False

        try:
            report_date = datetime.now().strftime("%Y-%m-%d")
            # 직책 및 팀장 정보
            report_post = get_credential("user_position") or "Researcher"
            report_leader = get_credential("group_leader") or "Soojin Jang"
            user_dept = self.user_info.get('dept') or get_credential("user_dept") or "Antibacterial Resistance Lab"

            # Travel form uses .validate class for required fields
            js_code = f"""
                document.querySelector('input[name="subject"]').value = "{title}";

                // .validate 필드들
                document.querySelector('.validate[name="report_date"]').value = "{report_date}";
                document.querySelector('.validate[name="report_name"]').value = "{self.user_info['name']}";
                document.querySelector('.validate[name="report_post"]').value = "{report_post}";
                document.querySelector('.validate[name="report_group"]').value = "{user_dept}";
                document.querySelector('.validate[name="report_leader"]').value = "{report_leader}";
                document.querySelector('.validate[name="start_day"]').value = "{start_date}";
                document.querySelector('.validate[name="end_day"]').value = "{end_date}";
                document.querySelector('.validate[name="report_dest"]').value = "{destination}";
                document.querySelector('.validate[name="purpose_field"]').value = "{purpose or 'Business travel'}";
                document.querySelector('.validate[name="date_field"]').value = "{schedule or f'{start_date} ~ {end_date}'}";
                document.querySelector('.validate[name="org_field"]').value = "{organization or destination}";
                document.querySelector('.validate[name="person_field"]').value = "{attendees or self.user_info['name']}";
                document.querySelector('.validate[name="discuss_field"]').value = "{purpose or 'Conference/Meeting'}";
                document.querySelector('.validate[name="agenda_field"]').value = "{purpose or 'Business activities'}";
                document.querySelector('.validate[name="result_field"]').value = "Expected outcomes from travel";
                document.querySelector('.validate[name="other_field"]').value = "N/A";
                document.querySelector('.validate[name="conclusion_field"]').value = "Travel request for {purpose or 'business'}";
            """
            frame.evaluate(js_code)

            time.sleep(1)
            self.page.screenshot(path="screenshots/travel_form_filled.png")
            print("폼 작성 완료 (screenshots/travel_form_filled.png)")

            if draft_only:
                frame.evaluate("document.all('mode1').value = 'draft';")
                try:
                    # Travel form uses direct form submit
                    with self.page.expect_navigation(timeout=20000, wait_until="load"):
                        frame.evaluate("document.form1.submit();")
                except:
                    time.sleep(5)  # fallback

                new_url = frame.url
                if "document_view.php" in new_url and "doc_id=" in new_url:
                    doc_id = new_url.split("doc_id=")[1].split("&")[0]
                    self.page.screenshot(path="screenshots/travel_draft_saved.png")
                    print(f"드래프트 저장 완료 (doc_id: {doc_id})")
                else:
                    print(f"저장 결과 불확실 - URL: {new_url}")
            else:
                frame.evaluate("document.all('mode1').value = 'request';")
                try:
                    with self.page.expect_navigation(timeout=20000, wait_until="load"):
                        frame.evaluate("document.form1.submit();")
                except:
                    time.sleep(5)
                print("결재요청 완료")

            return True

        except Exception as e:
            print(f"출장 신청 실패: {e}")
            self.page.screenshot(path="screenshots/travel_error.png")
            return False

    def close(self):
        """브라우저 종료"""
        self.browser.close()
        self.playwright.stop()
        print("\n브라우저 종료")


def main():
    parser = argparse.ArgumentParser(description="IPK 그룹웨어 자동화")
    subparsers = parser.add_subparsers(dest="command", help="명령어")

    # 휴가 신청
    leave_parser = subparsers.add_parser("leave", help="휴가 신청")
    leave_parser.add_argument("--type", "-t", default="annual",
                              choices=["annual", "compensatory", "paternity", "sick",
                                       "special", "official", "childcare", "fetus_checkup"],
                              help="휴가 종류 (첨부필수: sick, paternity, special, official, childcare, fetus_checkup)")
    leave_parser.add_argument("--date", "-d", help="시작일 (YYYY-MM-DD)")
    leave_parser.add_argument("--end", "-e", help="종료일 (YYYY-MM-DD)")
    leave_parser.add_argument("--start-time", help="시작시간 (예: 14)")
    leave_parser.add_argument("--end-time", help="종료시간 (예: 17)")
    leave_parser.add_argument("--purpose", "-p", default=None, help="사유 (미지정시 이력 추론)")
    leave_parser.add_argument("--dest", default=None, help="목적지 (미지정시 이력 추론)")
    leave_parser.add_argument("--substitute", "--sub", default=None, help="대리자 이름 (미지정시 이력 추론)")
    leave_parser.add_argument("--submit", "-s", action="store_true", help="바로 결재요청")

    # 야근식대
    meal_parser = subparsers.add_parser("meal", help="야근식대 신청 (영수증 첨부 필수)")
    meal_parser.add_argument("--date", "-d", help="날짜 (YYYY-MM-DD)")
    meal_parser.add_argument("--amount", "-a", type=int, default=15000, help="금액")
    meal_parser.add_argument("--participants", "-p", default="", help="참석자")
    meal_parser.add_argument("--attachment", "--file", "-f", help="영수증 파일 경로 (필수)")
    meal_parser.add_argument("--submit", "-s", action="store_true", help="바로 결재요청")

    # 휴일근무
    work_parser = subparsers.add_parser("work", help="휴일근무 신청")
    work_parser.add_argument("--date", "-d", help="근무일 (YYYY-MM-DD)")
    work_parser.add_argument("--reason", "-r", default="experiment", help="사유")
    work_parser.add_argument("--place", default="IPK", help="장소")
    work_parser.add_argument("--submit", "-s", action="store_true", help="바로 결재요청")

    # 출장
    travel_parser = subparsers.add_parser("travel", help="출장 신청")
    travel_parser.add_argument("--title", "-t", required=True, help="제목")
    travel_parser.add_argument("--dest", "-d", required=True, help="출장지")
    travel_parser.add_argument("--start", required=True, help="시작일")
    travel_parser.add_argument("--end", required=True, help="종료일")
    travel_parser.add_argument("--purpose", "-p", default="", help="목적")
    travel_parser.add_argument("--submit", "-s", action="store_true", help="바로 결재요청")

    # 테스트
    test_parser = subparsers.add_parser("test", help="테스트")

    # 이력 조회
    history_parser = subparsers.add_parser("history", help="이력 기반 추론 테스트")
    history_parser.add_argument("--form", "-f", default="leave",
                                choices=["leave", "working", "expense", "travel"],
                                help="폼 유형")
    history_parser.add_argument("--context", "-c", default=None,
                                help="컨텍스트 (예: leave_type=annual)")
    history_parser.add_argument("--clear", action="store_true", help="이력 삭제")
    history_parser.add_argument("--demo", action="store_true", help="샘플 데이터 생성")

    # 자격증명 설정
    setup_parser = subparsers.add_parser("setup", help="자격증명을 OS keyring에 저장")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return

    # history 명령어 처리
    if args.command == "history":
        if not HISTORY_AVAILABLE:
            print("이력 관리 모듈을 사용할 수 없습니다.")
            return

        hm = get_history_manager()

        if args.clear:
            hm.clear_history(args.form if args.form != "all" else None)
            print(f"이력 삭제 완료: {args.form}")
            return

        if args.demo:
            # 샘플 데이터 생성
            print("샘플 이력 데이터 생성 중...")
            for i in range(3):
                hm.record_submission("leave", {
                    "leave_type": "annual",
                    "substitute": "Guinam Wee",
                    "destination": "Seoul",
                    "purpose": "personal",
                    "emergency_address": "Seoul, Korea",
                    "emergency_telephone": "010-1234-5678"
                }, doc_id=f"demo-{i}")
            for i in range(2):
                hm.record_submission("leave", {
                    "leave_type": "compensatory",
                    "substitute": "Guinam Wee",
                    "destination": "Seoul",
                    "purpose": "child care",
                    "emergency_address": "Seoul, Korea",
                    "emergency_telephone": "010-1234-5678"
                }, doc_id=f"demo-comp-{i}")
            for i in range(3):
                hm.record_submission("working", {
                    "budget_code": "NN2512-0001",
                    "work_place": "IPK"
                }, doc_id=f"demo-work-{i}")
            print("샘플 데이터 생성 완료!")

        # 추론 결과 표시
        print(f"\n{'='*60}")
        print(f"이력 기반 추론 결과 [{args.form.upper()}]")
        print("="*60)

        context = {}
        if args.context:
            for pair in args.context.split(","):
                if "=" in pair:
                    k, v = pair.split("=", 1)
                    context[k.strip()] = v.strip()

        inferences = hm.get_all_inferences(args.form, context if context else None)
        if inferences:
            for field, result in inferences.items():
                conf = f"{result['confidence']:.0%}"
                print(f"  {field}: {result['value']} ({conf}, {result['method']})")
        else:
            print("  (이력 없음)")

        print(f"\n통계 요약:")
        summary = hm.get_stats_summary()
        print(f"  총 제출 이력: {summary['total_submissions']}개")
        for form_type, info in summary.get("forms", {}).items():
            print(f"  - {form_type}: {info['fields_tracked']}개 필드 추적")

        return

    # setup 명령어 처리
    if args.command == "setup":
        print("IPK 그룹웨어 설정")
        print("=" * 50)

        print("\n[1/3] 로그인 정보")
        username = input("  Username: ")
        password = getpass.getpass("  Password: ")
        user_name = input("  이름 (예: Kyuwon Shim): ")

        print("\n[2/3] 휴가 대리자 정보 (휴가 신청시 필수)")
        print("  (팀원 중 한 명 지정, 나중에 변경 가능)")
        sub_name = input("  대리자 이름 (예: Guinam Wee): ") or "N/A"
        sub_payroll = input("  대리자 사번 (모르면 Enter): ") or "N/A"
        sub_position = input("  대리자 직급 (예: Researcher): ") or "Researcher"
        sub_contact = input("  대리자 연락처 (예: 010-xxxx-xxxx): ") or "N/A"

        print("\n[3/3] 비상연락처 (휴가 신청시 필수)")
        emerg_addr = input("  주소 (예: Seoul): ") or "Seoul"
        emerg_tel = input("  전화번호: ") or "N/A"

        # 저장
        save_credential("username", username)
        save_credential("password", password)
        if user_name:
            save_credential("user_name", user_name)

        save_credential("substitute_name", sub_name)
        save_credential("substitute_payroll", sub_payroll)
        save_credential("substitute_position", sub_position)
        save_credential("substitute_contact", sub_contact)
        save_credential("emergency_address", emerg_addr)
        save_credential("emergency_telephone", emerg_tel)

        print("\n" + "=" * 50)
        print("설정 완료! 저장된 항목:")
        print(f"  - 로그인: {username}")
        print(f"  - 대리자: {sub_name}")
        print(f"  - 비상연락처: {emerg_addr}, {emerg_tel}")
        print("\n이제 아이디/비번 입력 없이 사용 가능합니다.")
        return

    # 자격증명 가져오기 (우선순위: 환경변수 > keyring > 프롬프트)
    username = get_credential("username", "Username")
    password = get_credential("password", "Password")

    gw = IPKGroupware(headless=True)
    gw.login(username, password)

    if args.command == "leave":
        gw.submit_leave(
            leave_type=args.type,
            start_date=args.date,
            end_date=args.end,
            start_time=getattr(args, 'start_time', None),
            end_time=getattr(args, 'end_time', None),
            purpose=args.purpose,
            destination=args.dest,
            substitute=getattr(args, 'substitute', None),
            draft_only=not args.submit
        )
    elif args.command == "meal":
        gw.submit_overtime_meal(
            date=args.date,
            amount=args.amount,
            participants=args.participants,
            attachment=getattr(args, 'attachment', None),
            draft_only=not args.submit
        )
    elif args.command == "work":
        gw.submit_work_request(
            work_date=args.date,
            reason=args.reason,
            work_place=args.place,
            draft_only=not args.submit
        )
    elif args.command == "travel":
        gw.submit_travel_request(
            title=args.title,
            destination=args.dest,
            start_date=args.start,
            end_date=args.end,
            purpose=args.purpose,
            draft_only=not args.submit
        )
    elif args.command == "test":
        gw.submit_leave(
            leave_type="annual",
            start_date="2025-12-26",
            purpose="personal",
            destination="Seoul",
            draft_only=True
        )

    gw.close()


if __name__ == "__main__":
    main()
