"""샘플 문서 상세 조회 - 각 종류별"""
from playwright.sync_api import sync_playwright
import os
import time
import json

os.makedirs("screenshots/samples", exist_ok=True)

# 가져올 문서 목록 (내 문서 + 팀 문서에서 선별)
target_docs = [
    # 휴가 관련
    {"type": "leave_annual", "url_suffix": "type=approved", "doc_no": "ARL-251223-04", "desc": "연차"},
    {"type": "leave_compensatory", "url_suffix": "type=approved", "doc_no": "ARL-251222-01", "desc": "보상휴가"},
    # 경비 관련
    {"type": "expense_card", "url_suffix": "type=approved", "doc_no": "ARL-251215-12", "desc": "카드경비"},
    # 근무 관련
    {"type": "working", "url_suffix": "type=approved", "doc_no": "ARL-251222-10", "desc": "휴일근무"},
    # 팀 문서 - 그룹에서
    {"type": "expense_team", "url_suffix": "type=groupapproved", "doc_no": "ARL-251223-05", "desc": "팀원경비"},
    {"type": "request_team", "url_suffix": "type=groupapproved", "doc_no": "ARL-251219-01", "desc": "출장요청"},
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

    print(f"   로그인 완료: {page.url}")

    # 각 문서 상세 조회
    for target in target_docs:
        print(f"\n2. [{target['type']}] {target['doc_no']} 조회...")

        # 해당 목록 페이지로 이동
        left_frame = page.frame("left_menu")
        if left_frame:
            # Document List 메뉴 열기
            doc_list = left_frame.query_selector("b:has-text('Document List')")
            if doc_list:
                doc_list.click()
                time.sleep(0.5)

            # 해당 메뉴 클릭
            if "groupapproved" in target['url_suffix']:
                menu = left_frame.query_selector("a[href*='groupapproved']")
            else:
                menu = left_frame.query_selector("a[href*='type=approved']:not([href*='approved_cc']):not([href*='groupapproved'])")

            if menu:
                menu.click()
                time.sleep(2)

        main_frame = page.frame("main_menu")
        if not main_frame:
            print("   main_menu 없음")
            continue

        main_frame.wait_for_load_state("networkidle")
        time.sleep(1)

        # 해당 문서 찾아서 클릭
        found = False
        links = main_frame.query_selector_all("a")
        for link in links:
            text = link.inner_text() or ""
            if target['doc_no'] in text:
                link.click()
                time.sleep(2)
                main_frame.wait_for_load_state("networkidle")
                found = True
                break

        if not found:
            print(f"   문서를 찾지 못함")
            continue

        # 스크린샷 저장
        filename = f"screenshots/samples/{target['type']}_{target['doc_no']}.png"
        page.screenshot(path=filename, full_page=True)

        # HTML 저장
        html_file = f"screenshots/samples/{target['type']}_{target['doc_no']}.html"
        with open(html_file, "w", encoding="utf-8") as f:
            f.write(main_frame.content())

        print(f"   -> {filename} 저장 완료")

    browser.close()
    print("\n모든 샘플 문서 조회 완료!")
