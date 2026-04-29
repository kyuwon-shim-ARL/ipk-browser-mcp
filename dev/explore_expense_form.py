"""R&D Expense Request 폼 탐색"""
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

    # R&D Expense Request 폼 페이지
    print("\n2. R&D Expense Request 폼 탐색...")
    page.goto("https://gw.ip-korea.org/Document/document_write.php?approve_type=AppFrm-021", timeout=30000)
    page.wait_for_load_state("networkidle")
    time.sleep(2)
    page.screenshot(path="screenshots/rnd_expense_form.png", full_page=True)

    # HTML 저장
    with open("screenshots/rnd_expense_form.html", "w", encoding="utf-8") as f:
        f.write(page.content())

    # 폼 필드 분석
    print("\n   폼 필드 분석:")
    inputs = page.query_selector_all("input, select, textarea")
    for inp in inputs:
        tag = inp.evaluate("el => el.tagName")
        name = inp.get_attribute("name") or inp.get_attribute("id") or ""
        inp_type = inp.get_attribute("type") or ""
        value = inp.get_attribute("value") or ""
        if name:
            print(f"   - {tag} name={name} type={inp_type} value={value[:30]}")

    # 과거 R&D Expense 문서 찾기
    print("\n3. 과거 R&D Expense 문서 확인...")
    page.goto("https://gw.ip-korea.org/Document/document_list.php?type=approved", timeout=30000)
    page.wait_for_load_state("networkidle")
    time.sleep(1)

    # R&D expense 관련 문서 찾기
    rows = page.query_selector_all("tr")
    expense_docs = []
    for row in rows:
        text = row.inner_text().lower()
        if "card" in text or "expense" in text or "[card]" in text:
            cells = row.query_selector_all("td")
            if cells:
                doc_link = row.query_selector("a")
                if doc_link:
                    href = doc_link.get_attribute("href") or ""
                    doc_text = row.inner_text().strip()[:100]
                    expense_docs.append((doc_text, href))
                    print(f"   - {doc_text}")

    # 첫 번째 expense 문서 상세 보기
    if expense_docs:
        print(f"\n4. Expense 문서 상세 확인...")
        href = expense_docs[0][1]
        if not href.startswith("http"):
            href = "https://gw.ip-korea.org/Document/" + href
        page.goto(href, timeout=30000)
        page.wait_for_load_state("networkidle")
        time.sleep(1)
        page.screenshot(path="screenshots/expense_doc_detail.png", full_page=True)
        with open("screenshots/expense_doc_detail.html", "w", encoding="utf-8") as f:
            f.write(page.content())

    browser.close()
    print("\n완료!")
