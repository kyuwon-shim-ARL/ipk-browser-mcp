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
        """환경변수에서 기본값 로드"""
        return {
            "substitute_name": os.environ.get("IPK_SUBSTITUTE_NAME", ""),
            "substitute_payroll": os.environ.get("IPK_SUBSTITUTE_PAYROLL", ""),
            "substitute_position": os.environ.get("IPK_SUBSTITUTE_POSITION", ""),
            "substitute_contact": os.environ.get("IPK_SUBSTITUTE_CONTACT", ""),
            "emergency_address": os.environ.get("IPK_EMERGENCY_ADDRESS", "Seoul"),
            "emergency_telephone": os.environ.get("IPK_EMERGENCY_TELEPHONE", ""),
        }

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
        purpose: str = "personal",
        destination: str = "Seoul",
        full_day: bool = True,
        draft_only: bool = True,
    ) -> bool:
        """휴가 신청"""
        if not self.logged_in:
            raise RuntimeError("로그인이 필요합니다")

        if not start_date:
            start_date = (datetime.now() + timedelta(days=1)).strftime("%Y-%m-%d")
        if not end_date:
            end_date = start_date

        leave_code = self.LEAVE_TYPES.get(leave_type, "01")
        leave_name = {
            "annual": "Annual leave",
            "compensatory": "Compensatory leave",
            "paternity": "Paternity Leave",
            "sick": "Sick leave",
        }.get(leave_type, "Annual leave")

        subject = f"{leave_name}, {start_date}~{end_date}, {destination}, {self.user_info['name']}"
        using_type = "01" if full_day else "04"

        print(f"\n휴가 신청: {subject}")

        frame = self._navigate_to_form("leave")
        if not frame:
            print("폼 페이지 이동 실패")
            return False

        try:
            # 기본값 추출
            sub_name = self.DEFAULTS['substitute_name']
            sub_payroll = self.DEFAULTS['substitute_payroll']
            sub_position = self.DEFAULTS['substitute_position']
            sub_contact = self.DEFAULTS['substitute_contact']
            emerg_addr = self.DEFAULTS['emergency_address']
            emerg_tel = self.DEFAULTS['emergency_telephone']

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

                var purposeEl = document.querySelector('input[name="purpose"]');
                if (purposeEl) purposeEl.value = "{purpose}";

                var destEl = document.querySelector('input[name="destination"]');
                if (destEl) destEl.value = "{destination}";

                // 대리자 정보
                var subName = document.querySelector('input[name="substitute_name"]');
                if (subName) subName.value = "{sub_name}";

                var subPayroll = document.querySelector('input[name="substitute_payroll"]');
                if (subPayroll) subPayroll.value = "{sub_payroll}";

                var subPosition = document.querySelector('input[name="substitute_position"]');
                if (subPosition) subPosition.value = "{sub_position}";

                var subContact = document.querySelector('input[name="substitute_contact"]');
                if (subContact) subContact.value = "{sub_contact}";

                // 비상연락처
                var emergAddr = document.querySelector('input[name="emergency_address"]');
                if (emergAddr) emergAddr.value = "{emerg_addr}";

                var emergTel = document.querySelector('input[name="emergency_telephone"]');
                if (emergTel) emergTel.value = "{emerg_tel}";

                // 2. subject는 마지막에 설정 (change 이벤트가 덮어쓰지 않도록)
                document.querySelector('input[name="subject"]').value = "{subject}";
            """
            frame.evaluate(js_code)

            time.sleep(1)
            self.page.screenshot(path="screenshots/leave_form_filled.png")
            print("폼 작성 완료 (screenshots/leave_form_filled.png)")

            if draft_only:
                # 드래프트로 저장
                frame.evaluate("""
                    document.all('mode1').value = 'draft';
                    Check_Form_Request('insert');
                """)
                time.sleep(2)
                self.page.screenshot(path="screenshots/leave_draft_saved.png")
                print("드래프트 저장 완료")
            else:
                # 결재요청
                frame.evaluate("""
                    document.all('mode1').value = 'request';
                    Check_Form_Request('insert');
                """)
                time.sleep(2)
                print("결재요청 완료")

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
        budget_code: str = "",
        draft_only: bool = True,
    ) -> bool:
        """야근식대 신청"""
        if not self.logged_in:
            raise RuntimeError("로그인이 필요합니다")

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
            js_code = f"""
                document.querySelector('input[name="subject"]').value = "{subject}";

                var budgetType = document.querySelector('select[name="budget_type"]');
                if (budgetType) {{
                    budgetType.value = "02";
                    budgetType.dispatchEvent(new Event('change', {{ bubbles: true }}));
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
            """
            frame.evaluate(js_code)

            time.sleep(1)
            self.page.screenshot(path="screenshots/expense_form_filled.png")
            print("폼 작성 완료 (screenshots/expense_form_filled.png)")

            if draft_only:
                frame.evaluate("""
                    document.all('mode1').value = 'draft';
                    Check_Form_Request('insert');
                """)
                time.sleep(2)
                print("드래프트 저장 완료")
            else:
                frame.evaluate("""
                    document.all('mode1').value = 'request';
                    Check_Form_Request('insert');
                """)
                time.sleep(2)
                print("결재요청 완료")

            return True

        except Exception as e:
            print(f"야근식대 신청 실패: {e}")
            return False

    def submit_work_request(
        self,
        work_date: str = None,
        reason: str = "experiment",
        work_place: str = "IPK",
        details: str = "",
        draft_only: bool = True,
    ) -> bool:
        """휴일근무 신청"""
        if not self.logged_in:
            raise RuntimeError("로그인이 필요합니다")

        if not work_date:
            today = datetime.now()
            days_until_saturday = (5 - today.weekday()) % 7
            if days_until_saturday == 0:
                days_until_saturday = 7
            work_date = (today + timedelta(days=days_until_saturday)).strftime("%Y-%m-%d")

        subject = f"Application for Working on {work_date}, {self.user_info['name']}"

        print(f"\n휴일근무 신청: {subject}")

        frame = self._navigate_to_form("working")
        if not frame:
            return False

        try:
            js_code = f"""
                document.querySelector('input[name="subject"]').value = "{subject}";

                var desiredDate = document.querySelector('input[name="desired_date"]');
                if (desiredDate) desiredDate.value = "{work_date}";

                var workPlace = document.querySelector('input[name="wroking_place"]');
                if (workPlace) workPlace.value = "{work_place}";

                var subSubject = document.querySelector('input[name="sub_subject"]');
                if (subSubject) subSubject.value = "{reason}";

                var contents = document.querySelector('textarea[name="contents1"]');
                if (contents) contents.value = "{details}";
            """
            frame.evaluate(js_code)

            time.sleep(1)
            self.page.screenshot(path="screenshots/working_form_filled.png")
            print("폼 작성 완료 (screenshots/working_form_filled.png)")

            if draft_only:
                frame.evaluate("""
                    document.all('mode1').value = 'draft';
                    Check_Form_Request('insert');
                """)
                time.sleep(2)
                print("드래프트 저장 완료")
            else:
                frame.evaluate("""
                    document.all('mode1').value = 'request';
                    Check_Form_Request('insert');
                """)
                time.sleep(2)
                print("결재요청 완료")

            return True

        except Exception as e:
            print(f"휴일근무 신청 실패: {e}")
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
            js_code = f"""
                document.querySelector('input[name="subject"]').value = "{title}";

                var reportDate = document.querySelector('input[name="report_date"]');
                if (reportDate) reportDate.value = "{report_date}";

                var reportName = document.querySelector('input[name="report_name"]');
                if (reportName) reportName.value = "{self.user_info['name']}";

                var reportGroup = document.querySelector('input[name="report_group"]');
                if (reportGroup) reportGroup.value = "{self.user_info['dept']}";

                var startDay = document.querySelector('input[name="start_day"]');
                if (startDay) startDay.value = "{start_date}";

                var endDay = document.querySelector('input[name="end_day"]');
                if (endDay) endDay.value = "{end_date}";

                var reportDest = document.querySelector('textarea[name="report_dest"]');
                if (reportDest) reportDest.value = "{destination}";

                var purposeField = document.querySelector('textarea[name="purpose_field"]');
                if (purposeField) purposeField.value = "{purpose}";

                var dateField = document.querySelector('textarea[name="date_field"]');
                if (dateField) dateField.value = "{schedule}";

                var orgField = document.querySelector('textarea[name="org_field"]');
                if (orgField) orgField.value = "{organization}";

                var personField = document.querySelector('textarea[name="person_field"]');
                if (personField) personField.value = "{attendees}";
            """
            frame.evaluate(js_code)

            time.sleep(1)
            self.page.screenshot(path="screenshots/travel_form_filled.png")
            print("폼 작성 완료 (screenshots/travel_form_filled.png)")

            if draft_only:
                frame.evaluate("""
                    document.all('mode1').value = 'draft';
                    Check_Form_Request('insert');
                """)
                time.sleep(2)
                print("드래프트 저장 완료")
            else:
                frame.evaluate("""
                    document.all('mode1').value = 'request';
                    Check_Form_Request('insert');
                """)
                time.sleep(2)
                print("결재요청 완료")

            return True

        except Exception as e:
            print(f"출장 신청 실패: {e}")
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
                              choices=["annual", "compensatory", "paternity", "sick"],
                              help="휴가 종류")
    leave_parser.add_argument("--date", "-d", help="시작일 (YYYY-MM-DD)")
    leave_parser.add_argument("--end", "-e", help="종료일 (YYYY-MM-DD)")
    leave_parser.add_argument("--purpose", "-p", default="personal", help="사유")
    leave_parser.add_argument("--dest", default="Seoul", help="목적지")
    leave_parser.add_argument("--submit", "-s", action="store_true", help="바로 결재요청")

    # 야근식대
    meal_parser = subparsers.add_parser("meal", help="야근식대 신청")
    meal_parser.add_argument("--date", "-d", help="날짜 (YYYY-MM-DD)")
    meal_parser.add_argument("--amount", "-a", type=int, default=15000, help="금액")
    meal_parser.add_argument("--participants", "-p", default="", help="참석자")
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

    # 자격증명 설정
    setup_parser = subparsers.add_parser("setup", help="자격증명을 OS keyring에 저장")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return

    # setup 명령어 처리
    if args.command == "setup":
        print("IPK 그룹웨어 자격증명 설정")
        print("=" * 40)
        username = input("Username: ")
        password = getpass.getpass("Password: ")
        user_name = input("이름 (예: Kyuwon Shim): ")

        save_credential("username", username)
        save_credential("password", password)
        if user_name:
            save_credential("user_name", user_name)

        print("\n설정 완료! 이제 아이디/비번 입력 없이 사용 가능합니다.")
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
            purpose=args.purpose,
            destination=args.dest,
            draft_only=not args.submit
        )
    elif args.command == "meal":
        gw.submit_overtime_meal(
            date=args.date,
            amount=args.amount,
            participants=args.participants,
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
