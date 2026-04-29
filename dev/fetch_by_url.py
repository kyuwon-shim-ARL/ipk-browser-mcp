"""URL로 직접 여러 페이지 가져오기"""
from playwright.sync_api import sync_playwright
import os
import time
import json

os.makedirs("screenshots/all_docs", exist_ok=True)

# 페이지 URL 패턴 확인용
BASE_URLS = {
    "my": "https://gw.ip-korea.org/Document/document_list.php?type=approved",
    "team": "https://gw.ip-korea.org/Document/document_list.php?type=groupapproved"
}

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

    print(f"   로그인 완료")

    all_docs = []

    # main_menu 프레임에서 작업
    def fetch_docs_from_frame(doc_type, max_pages=10):
        docs = []
        left_frame = page.frame("left_menu")

        # Document List 메뉴 열기
        if left_frame:
            doc_list = left_frame.query_selector("b:has-text('Document List')")
            if doc_list:
                doc_list.click()
                time.sleep(1)

            # 해당 메뉴 클릭
            if doc_type == "team":
                menu_link = left_frame.query_selector("a[href*='groupapproved']")
            else:
                menu_link = left_frame.query_selector("a[href*='type=approved']:not([href*='approved_cc']):not([href*='groupapproved'])")

            if menu_link:
                # JavaScript로 강제 클릭
                left_frame.evaluate("""(selector) => {
                    const el = document.querySelector(selector);
                    if (el) el.click();
                }""", "a[href*='groupapproved']" if doc_type == "team" else "a[href*='type=approved']")
                time.sleep(2)

        main_frame = page.frame("main_menu")
        if not main_frame:
            return docs

        main_frame.wait_for_load_state("networkidle")
        time.sleep(1)

        for page_num in range(1, max_pages + 1):
            print(f"      페이지 {page_num}...")

            # 문서 파싱
            rows = main_frame.query_selector_all("tr")
            page_doc_count = 0
            for row in rows:
                cells = row.query_selector_all("td")
                if len(cells) >= 5:
                    link = row.query_selector("a")
                    if link and link.get_attribute("href"):
                        doc_no = cells[0].inner_text().strip()
                        subject = cells[1].inner_text().strip()
                        dept = cells[2].inner_text().strip()
                        writer = cells[3].inner_text().strip()
                        status = cells[4].inner_text().strip()
                        date = cells[5].inner_text().strip() if len(cells) > 5 else ""
                        if doc_no.startswith("ARL"):
                            docs.append({
                                "doc_no": doc_no,
                                "subject": subject[:200],
                                "dept": dept,
                                "writer": writer,
                                "status": status,
                                "date": date,
                                "source": doc_type
                            })
                            page_doc_count += 1

            print(f"         {page_doc_count}건")

            if page_doc_count == 0:
                break

            # 다음 페이지로 이동 - JavaScript로 클릭
            next_found = main_frame.evaluate(f"""() => {{
                const links = document.querySelectorAll('a');
                for (let link of links) {{
                    if (link.innerText.trim() === '{page_num + 1}') {{
                        link.click();
                        return true;
                    }}
                }}
                return false;
            }}""")

            if not next_found:
                print(f"         마지막 페이지")
                break

            time.sleep(2)
            main_frame.wait_for_load_state("networkidle")

        return docs

    # 내 문서 가져오기
    print("\n2. 내 문서 (Approved)...")
    my_docs = fetch_docs_from_frame("my", max_pages=5)
    print(f"   총 {len(my_docs)}건")
    all_docs.extend(my_docs)

    # 팀 문서 가져오기 - 새로 로그인해서 시도
    print("\n3. 팀 문서 (Approved Group)...")

    # 메인 페이지로 돌아가서 다시 시도
    page.goto("https://gw.ip-korea.org/main.php", timeout=30000)
    time.sleep(2)

    team_docs = fetch_docs_from_frame("team", max_pages=10)
    print(f"   총 {len(team_docs)}건")
    all_docs.extend(team_docs)

    # 중복 제거
    seen = set()
    unique_docs = []
    for doc in all_docs:
        if doc['doc_no'] not in seen:
            seen.add(doc['doc_no'])
            unique_docs.append(doc)

    print(f"\n4. 총 {len(unique_docs)}건 (중복 제거)")

    # 저장
    with open("screenshots/all_docs/all_documents.json", "w", encoding="utf-8") as f:
        json.dump(unique_docs, f, ensure_ascii=False, indent=2)

    browser.close()
    print("\n완료!")
