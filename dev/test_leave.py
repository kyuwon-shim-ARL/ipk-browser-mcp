"""휴가 신청 디버깅"""
from playwright.sync_api import sync_playwright
import time

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1920, "height": 1080})
    page = context.new_page()

    # 로그인
    print("로그인...")
    page.goto("https://gw.ip-korea.org", timeout=30000)
    page.wait_for_load_state("networkidle")
    page.fill("input[name='Username']", "kyuwon.shim")
    page.fill("input[name='Password']", "1111")
    page.evaluate("Check_Form()")
    time.sleep(3)

    if "main.php" not in page.url:
        page.goto("https://gw.ip-korea.org/main.php", timeout=30000)
        time.sleep(2)

    # 휴가 폼으로 이동
    print("폼 이동...")
    frame = page.frame("main_menu")
    frame.goto("https://gw.ip-korea.org/Document/document_write.php?approve_type=AppFrm-073", timeout=30000)
    time.sleep(2)
    frame.wait_for_load_state("networkidle")

    # 값 설정 전 확인
    before = frame.evaluate("document.querySelector('input[name=\"subject\"]').value")
    print(f"설정 전 subject: '{before}'")

    # 값 설정
    subject = "Annual leave, 2025-12-26~2025-12-26, Seoul, Kyuwon Shim"
    print(f"설정할 값: '{subject}'")

    frame.evaluate(f'document.querySelector(\'input[name="subject"]\').value = "{subject}"')

    # 값 설정 후 확인
    after = frame.evaluate("document.querySelector('input[name=\"subject\"]').value")
    print(f"설정 후 subject: '{after}'")

    time.sleep(1)

    # 스크린샷
    page.screenshot(path="screenshots/leave_debug.png")
    print("스크린샷 저장: screenshots/leave_debug.png")

    browser.close()
