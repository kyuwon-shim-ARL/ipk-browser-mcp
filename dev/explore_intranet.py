"""인트라넷 탐색 스크립트 v2"""
from playwright.sync_api import sync_playwright
import os
import time

os.makedirs("screenshots", exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1920, "height": 1080})
    page = context.new_page()

    # 1. 로그인 페이지 접속
    print("1. 로그인 페이지 접속...")
    page.goto("https://gw.ip-korea.org", timeout=30000)
    page.wait_for_load_state("networkidle")

    # 2. 로그인
    print("2. 로그인...")
    page.fill("input[name='Username']", "kyuwon.shim")
    page.fill("input[name='Password']", "1111")
    page.screenshot(path="screenshots/01_login_filled.png")

    # Check_Form() 자바스크립트 함수 직접 호출
    page.evaluate("Check_Form()")
    print("   Check_Form() 호출")

    # 페이지 로드 대기
    time.sleep(3)
    page.wait_for_load_state("networkidle")
    page.screenshot(path="screenshots/02_after_login.png")
    print(f"   로그인 후 URL: {page.url}")
    print(f"   Title: {page.title()}")

    # 로그인 성공 확인
    if "index.php" in page.url or page.url != "https://gw.ip-korea.org/":
        print("   로그인 성공!")
    else:
        print("   로그인 실패 가능성 - 페이지 확인 필요")

    # 3. 메인 페이지 탐색
    print("\n3. 메인 페이지 구조 분석...")

    # 프레임 확인 (그룹웨어는 보통 iframe 사용)
    frames = page.frames
    print(f"   프레임 개수: {len(frames)}")
    for i, frame in enumerate(frames):
        print(f"   - Frame {i}: {frame.name or 'main'} - {frame.url[:80]}")

    # 모든 링크 출력
    links = page.query_selector_all("a")
    print(f"\n   링크 개수: {len(links)}")
    for link in links[:30]:
        href = link.get_attribute("href") or ""
        text = link.inner_text().strip()[:50] if link.inner_text() else ""
        if text or href:
            print(f"   - {text}: {href[:60]}")

    # 4. Document 관련 메뉴 찾기
    print("\n4. Document 관련 메뉴 찾기...")

    # 텍스트로 찾기
    keywords = ["Document", "document", "Form", "form", "List", "문서"]
    for kw in keywords:
        elements = page.query_selector_all(f"text={kw}")
        if elements:
            print(f"   '{kw}' 포함 요소: {len(elements)}개")
            for el in elements[:5]:
                print(f"      - {el.inner_text()[:60]}")

    # 5. 페이지 전체 HTML 저장
    print("\n5. HTML 저장...")
    with open("screenshots/main_page.html", "w", encoding="utf-8") as f:
        f.write(page.content())

    # 모든 프레임 HTML도 저장
    for i, frame in enumerate(frames):
        try:
            with open(f"screenshots/frame_{i}.html", "w", encoding="utf-8") as f:
                f.write(frame.content())
        except:
            pass

    browser.close()
    print("\n완료!")
