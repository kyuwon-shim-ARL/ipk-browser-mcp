"""각 폼의 필드 상세 분석"""
from playwright.sync_api import sync_playwright
import os
import time
import json

os.makedirs("screenshots/forms", exist_ok=True)

# 분석할 폼 목록
FORMS = [
    {"name": "leave_request", "code": "AppFrm-073", "desc": "휴가신청"},
    {"name": "rnd_expense", "code": "AppFrm-021", "desc": "R&D 경비청구"},
    {"name": "working_request", "code": "AppFrm-027", "desc": "휴일근무신청"},
    {"name": "travel_report", "code": "AppFrm-076", "desc": "출장보고서"},
]

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1920, "height": 1080})
    page = context.new_page()

    # 로그인
    print("1. 로그인...")
    page.goto("https://gw.ip-korea.org", timeout=30000)
    page.wait_for_load_state("networkidle")
    page.fill("input[name='Username']", "kyuwon.shim")
    page.fill("input[name='Password']", "1111")
    page.evaluate("Check_Form()")
    time.sleep(3)

    if "main.php" not in page.url:
        page.goto("https://gw.ip-korea.org/main.php", timeout=30000)
        time.sleep(2)

    all_forms = {}

    for form in FORMS:
        print(f"\n2. {form['desc']} ({form['code']}) 분석...")

        # 폼 페이지로 이동
        url = f"https://gw.ip-korea.org/Document/document_write.php?approve_type={form['code']}"

        # main_menu 프레임에서 로드
        main_frame = page.frame("main_menu")
        if main_frame:
            main_frame.goto(url, timeout=30000)
            time.sleep(2)
            main_frame.wait_for_load_state("networkidle")

            # 스크린샷
            page.screenshot(path=f"screenshots/forms/{form['name']}.png", full_page=True)

            # 필드 분석
            fields = []

            # input 필드
            inputs = main_frame.query_selector_all("input")
            for inp in inputs:
                name = inp.get_attribute("name") or ""
                inp_type = inp.get_attribute("type") or "text"
                value = inp.get_attribute("value") or ""
                placeholder = inp.get_attribute("placeholder") or ""

                if name and inp_type not in ["hidden", "submit", "button"]:
                    fields.append({
                        "tag": "input",
                        "type": inp_type,
                        "name": name,
                        "value": value,
                        "placeholder": placeholder
                    })

            # select 필드
            selects = main_frame.query_selector_all("select")
            for sel in selects:
                name = sel.get_attribute("name") or ""
                if name:
                    # 옵션들 가져오기
                    options = []
                    opts = sel.query_selector_all("option")
                    for opt in opts[:10]:  # 최대 10개
                        opt_val = opt.get_attribute("value") or ""
                        opt_text = opt.inner_text().strip()
                        if opt_val or opt_text:
                            options.append({"value": opt_val, "text": opt_text[:50]})

                    fields.append({
                        "tag": "select",
                        "name": name,
                        "options": options
                    })

            # textarea 필드
            textareas = main_frame.query_selector_all("textarea")
            for ta in textareas:
                name = ta.get_attribute("name") or ""
                if name:
                    fields.append({
                        "tag": "textarea",
                        "name": name
                    })

            # 중복 제거 (name 기준)
            seen = set()
            unique_fields = []
            for f in fields:
                if f['name'] not in seen:
                    seen.add(f['name'])
                    unique_fields.append(f)

            all_forms[form['name']] = {
                "code": form['code'],
                "desc": form['desc'],
                "fields": unique_fields
            }

            print(f"   {len(unique_fields)}개 필드 발견")

            # HTML 저장
            with open(f"screenshots/forms/{form['name']}.html", "w", encoding="utf-8") as f:
                f.write(main_frame.content())

    # JSON 저장
    with open("screenshots/forms/form_fields.json", "w", encoding="utf-8") as f:
        json.dump(all_forms, f, ensure_ascii=False, indent=2)

    browser.close()
    print("\n\n분석 완료! screenshots/forms/form_fields.json")
