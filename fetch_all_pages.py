"""여러 페이지의 서류 가져오기"""
from playwright.sync_api import sync_playwright
import os
import time
import json

os.makedirs("screenshots/all_docs", exist_ok=True)

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

    all_my_docs = []
    all_team_docs = []

    # === 내 문서 (Approved) - 여러 페이지 ===
    print("\n2. 내 문서 (Approved) 가져오기...")
    left_frame = page.frame("left_menu")
    if left_frame:
        doc_list = left_frame.query_selector("b:has-text('Document List')")
        if doc_list:
            doc_list.click()
            time.sleep(1)
        approved = left_frame.query_selector("a[href*='type=approved']:not([href*='approved_cc']):not([href*='groupapproved'])")
        if approved:
            approved.click()
            time.sleep(2)

    main_frame = page.frame("main_menu")
    if main_frame:
        main_frame.wait_for_load_state("networkidle")
        time.sleep(1)

        for page_num in range(1, 6):  # 최대 5페이지
            print(f"   페이지 {page_num} 처리 중...")

            # 문서 파싱
            rows = main_frame.query_selector_all("tr")
            page_docs = []
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
                            page_docs.append({
                                "doc_no": doc_no,
                                "subject": subject[:200],
                                "dept": dept,
                                "writer": writer,
                                "status": status,
                                "date": date,
                                "source": "my"
                            })

            print(f"      {len(page_docs)}건 발견")
            all_my_docs.extend(page_docs)

            # 다음 페이지 클릭
            next_page = main_frame.query_selector(f"a:has-text('{page_num + 1}')")
            if not next_page:
                # 다른 방식으로 찾기
                page_links = main_frame.query_selector_all("a")
                found_next = False
                for pl in page_links:
                    text = pl.inner_text().strip()
                    if text == str(page_num + 1):
                        pl.click()
                        time.sleep(2)
                        main_frame.wait_for_load_state("networkidle")
                        found_next = True
                        break
                if not found_next:
                    print(f"      다음 페이지 없음, 종료")
                    break
            else:
                next_page.click()
                time.sleep(2)
                main_frame.wait_for_load_state("networkidle")

    print(f"   내 문서 총 {len(all_my_docs)}건")

    # === 팀 문서 (Approved Group) - 여러 페이지 ===
    print("\n3. 팀 문서 (Approved Group) 가져오기...")
    left_frame = page.frame("left_menu")
    if left_frame:
        doc_list = left_frame.query_selector("b:has-text('Document List')")
        if doc_list:
            doc_list.click()
            time.sleep(1)
        approved_group = left_frame.query_selector("a[href*='groupapproved']")
        if approved_group:
            approved_group.click()
            time.sleep(2)

    main_frame = page.frame("main_menu")
    if main_frame:
        main_frame.wait_for_load_state("networkidle")
        time.sleep(1)

        for page_num in range(1, 11):  # 최대 10페이지
            print(f"   페이지 {page_num} 처리 중...")

            # 문서 파싱
            rows = main_frame.query_selector_all("tr")
            page_docs = []
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
                            page_docs.append({
                                "doc_no": doc_no,
                                "subject": subject[:200],
                                "dept": dept,
                                "writer": writer,
                                "status": status,
                                "date": date,
                                "source": "team"
                            })

            print(f"      {len(page_docs)}건 발견")
            all_team_docs.extend(page_docs)

            # 다음 페이지 클릭
            page_links = main_frame.query_selector_all("a")
            found_next = False
            for pl in page_links:
                text = pl.inner_text().strip()
                if text == str(page_num + 1):
                    pl.click()
                    time.sleep(2)
                    main_frame.wait_for_load_state("networkidle")
                    found_next = True
                    break
            if not found_next:
                print(f"      다음 페이지 없음, 종료")
                break

    print(f"   팀 문서 총 {len(all_team_docs)}건")

    # 중복 제거 (doc_no 기준)
    seen = set()
    all_docs = []
    for doc in all_my_docs + all_team_docs:
        if doc['doc_no'] not in seen:
            seen.add(doc['doc_no'])
            all_docs.append(doc)

    print(f"\n4. 총 {len(all_docs)}건 (중복 제거 후)")

    # JSON 저장
    with open("screenshots/all_docs/all_documents.json", "w", encoding="utf-8") as f:
        json.dump(all_docs, f, ensure_ascii=False, indent=2)

    browser.close()
    print("\n완료! screenshots/all_docs/all_documents.json 저장됨")
