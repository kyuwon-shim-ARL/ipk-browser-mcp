"""프레임 내에서 문서 상세 조회"""
from playwright.sync_api import sync_playwright
import os
import time

os.makedirs("screenshots/approved_docs", exist_ok=True)

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
    page.wait_for_load_state("networkidle")

    # 메인 페이지에서 left 메뉴 프레임 찾기
    print("\n2. 프레임 구조 확인...")
    print(f"   현재 URL: {page.url}")

    # 메인 페이지 (frameset)
    page.screenshot(path="screenshots/approved_docs/main_page.png")

    # left_menu 프레임에서 Document List 클릭
    print("\n3. Document List > Approved 이동...")
    left_frame = page.frame("left_menu")
    if left_frame:
        # Document List 메뉴 클릭하여 서브메뉴 열기
        doc_list_menu = left_frame.query_selector("text=Document List")
        if doc_list_menu:
            doc_list_menu.click()
            time.sleep(1)

        # Approved 클릭
        approved_link = left_frame.query_selector("a[href*='type=approved']")
        if approved_link:
            approved_link.click()
            time.sleep(2)

    # main_menu 프레임에서 목록 확인
    print("\n4. Approved 목록 확인...")
    main_frame = page.frame("main_menu")
    if main_frame:
        main_frame.wait_for_load_state("networkidle")
        time.sleep(1)

        # 스크린샷
        # 프레임 내용 캡처를 위해 전체 페이지 캡처
        page.screenshot(path="screenshots/approved_docs/approved_list_frame.png")

        # 문서 링크 찾기
        doc_links = main_frame.query_selector_all("a[href*='document_view']")
        print(f"   문서 링크 {len(doc_links)}개 발견")

        # 첫 3개 문서 상세 보기
        for i, link in enumerate(doc_links[:3]):
            doc_text = link.inner_text().strip()[:50]
            print(f"\n   [{i+1}] {doc_text}")

            link.click()
            time.sleep(2)
            main_frame.wait_for_load_state("networkidle")

            # 상세 페이지 캡처
            page.screenshot(path=f"screenshots/approved_docs/doc_detail_{i+1}.png", full_page=True)

            # HTML 저장
            with open(f"screenshots/approved_docs/doc_detail_{i+1}.html", "w", encoding="utf-8") as f:
                f.write(main_frame.content())

            print(f"   -> doc_detail_{i+1}.png 저장")

            # 목록으로 돌아가기
            back_link = main_frame.query_selector("a:has-text('Document List')")
            if back_link:
                back_link.click()
                time.sleep(2)
                main_frame.wait_for_load_state("networkidle")

    browser.close()
    print("\n완료!")
