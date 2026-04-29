"""Approved(Group) 팀 서류 가져오기"""
from playwright.sync_api import sync_playwright
import os
import time
import json

os.makedirs("screenshots/group_docs", exist_ok=True)

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

    if "main.php" not in page.url:
        page.goto("https://gw.ip-korea.org/main.php", timeout=30000)
        time.sleep(2)

    # left_menu에서 Approved(Group) 클릭
    print("\n2. Approved(Group) 목록 이동...")
    left_frame = page.frame("left_menu")
    if left_frame:
        # Document List 메뉴 클릭
        doc_list = left_frame.query_selector("b:has-text('Document List')")
        if doc_list:
            doc_list.click()
            time.sleep(1)

        # Approved(Group) 클릭
        approved_group = left_frame.query_selector("a[href*='groupapproved']")
        if approved_group:
            approved_group.click()
            time.sleep(2)
            print("   Approved(Group) 클릭 완료")

    main_frame = page.frame("main_menu")
    if not main_frame:
        print("   main_menu 프레임 없음")
        browser.close()
        exit()

    main_frame.wait_for_load_state("networkidle")
    time.sleep(1)

    # 스크린샷
    page.screenshot(path="screenshots/group_docs/group_list.png")

    # 문서 목록 파싱
    print("\n3. 팀 문서 목록 파싱...")
    rows = main_frame.query_selector_all("tr")

    docs = []
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
                        "subject": subject[:150],
                        "dept": dept,
                        "writer": writer,
                        "status": status,
                        "date": date
                    })

    print(f"   총 {len(docs)}건 발견")

    # 작성자별 분류
    writers = {}
    for doc in docs:
        w = doc['writer']
        if w not in writers:
            writers[w] = []
        writers[w].append(doc)

    print("\n   작성자별:")
    for w, d in writers.items():
        print(f"   - {w}: {len(d)}건")

    # 문서 종류별 분류
    categories = {
        "leave": [],
        "expense": [],
        "working": [],
        "settlement": [],
        "request": [],
        "other": []
    }

    for doc in docs:
        subj = doc['subject'].lower()
        if 'leave' in subj:
            categories["leave"].append(doc)
        elif 'card' in subj or 'expense' in subj:
            categories["expense"].append(doc)
        elif 'working' in subj:
            categories["working"].append(doc)
        elif 'settlement' in subj:
            categories["settlement"].append(doc)
        elif 'request' in subj:
            categories["request"].append(doc)
        else:
            categories["other"].append(doc)

    print("\n   종류별:")
    for cat, d in categories.items():
        if d:
            print(f"   - {cat}: {len(d)}건")

    # JSON 저장
    with open("screenshots/group_docs/group_doc_list.json", "w", encoding="utf-8") as f:
        json.dump(docs, f, ensure_ascii=False, indent=2)

    # 샘플 문서 상세 조회 (각 종류별 1개씩)
    print("\n4. 샘플 문서 상세 조회...")

    samples = []
    for cat in ["leave", "expense", "working", "settlement"]:
        if categories[cat]:
            # 내 문서가 아닌 다른 사람 문서 우선
            other_docs = [d for d in categories[cat] if d['writer'] != 'Kyuwon Shim']
            if other_docs:
                samples.append((cat, other_docs[0]))
            elif categories[cat]:
                samples.append((cat, categories[cat][0]))

    for cat, doc in samples:
        print(f"\n   [{cat}] {doc['doc_no']} by {doc['writer']}")
        print(f"      {doc['subject'][:60]}")

        # 문서 링크 찾기
        links = main_frame.query_selector_all("a")
        for link in links:
            text = link.inner_text() or ""
            if doc['doc_no'] in text:
                try:
                    link.click()
                    time.sleep(2)
                    main_frame.wait_for_load_state("networkidle")

                    # 스크린샷
                    filename = f"screenshots/group_docs/{cat}_{doc['doc_no']}.png"
                    page.screenshot(path=filename, full_page=True)

                    # HTML 저장
                    html_file = f"screenshots/group_docs/{cat}_{doc['doc_no']}.html"
                    with open(html_file, "w", encoding="utf-8") as f:
                        f.write(main_frame.content())

                    print(f"      -> 저장 완료")

                    # 뒤로가기
                    back = main_frame.query_selector("a:has-text('Document List')")
                    if back:
                        back.click()
                        time.sleep(2)
                        main_frame.wait_for_load_state("networkidle")
                except Exception as e:
                    print(f"      -> 오류: {e}")
                break

    browser.close()
    print("\n완료!")
