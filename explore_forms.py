"""폼 목록 및 승인된 문서 탐색"""
from playwright.sync_api import sync_playwright
import os
import time

os.makedirs("screenshots", exist_ok=True)

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
    time.sleep(2)
    page.wait_for_load_state("networkidle")
    print(f"   로그인 완료: {page.url}")

    # 2. Document Form List 페이지
    print("\n2. Document Form List 탐색...")
    page.goto("https://gw.ip-korea.org/Document/apporval_list.php", timeout=30000)
    page.wait_for_load_state("networkidle")
    time.sleep(1)
    page.screenshot(path="screenshots/form_list.png", full_page=True)

    # HTML 저장
    with open("screenshots/form_list.html", "w", encoding="utf-8") as f:
        f.write(page.content())

    # 폼 목록 추출
    print("   발견된 폼들:")
    links = page.query_selector_all("a")
    form_links = []
    for link in links:
        text = link.inner_text().strip() if link.inner_text() else ""
        href = link.get_attribute("href") or ""
        if text and ("request" in text.lower() or "leave" in text.lower() or
                    "expense" in text.lower() or "r&d" in text.lower() or
                    "travel" in text.lower() or "form" in text.lower()):
            print(f"   - {text}: {href}")
            form_links.append((text, href))

    # 3. Approved 문서 목록
    print("\n3. Approved 문서 목록 탐색...")
    page.goto("https://gw.ip-korea.org/Document/document_list.php?type=approved", timeout=30000)
    page.wait_for_load_state("networkidle")
    time.sleep(1)
    page.screenshot(path="screenshots/approved_list.png", full_page=True)

    # HTML 저장
    with open("screenshots/approved_list.html", "w", encoding="utf-8") as f:
        f.write(page.content())

    # 문서 목록 추출
    print("   승인된 문서들:")
    rows = page.query_selector_all("tr")
    for row in rows[:20]:  # 처음 20개만
        text = row.inner_text().strip().replace("\n", " | ")[:100]
        if text and len(text) > 10:
            print(f"   - {text}")

    # 4. 첫 번째 승인된 문서 상세 보기 (있다면)
    print("\n4. 승인된 문서 상세 확인...")
    detail_links = page.query_selector_all("a[href*='document_view'], a[href*='view']")
    if detail_links:
        first_doc = detail_links[0]
        href = first_doc.get_attribute("href")
        if href:
            if not href.startswith("http"):
                href = "https://gw.ip-korea.org" + href if href.startswith("/") else "https://gw.ip-korea.org/Document/" + href
            print(f"   첫 번째 문서: {href}")
            page.goto(href, timeout=30000)
            page.wait_for_load_state("networkidle")
            time.sleep(1)
            page.screenshot(path="screenshots/approved_doc_detail.png", full_page=True)
            with open("screenshots/approved_doc_detail.html", "w", encoding="utf-8") as f:
                f.write(page.content())

    browser.close()
    print("\n탐색 완료!")
