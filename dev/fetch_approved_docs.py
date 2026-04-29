"""승인된 문서 상세 조회"""
from playwright.sync_api import sync_playwright
import os
import time
import json

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
    time.sleep(2)
    page.wait_for_load_state("networkidle")

    # Approved 문서 목록
    print("\n2. Approved 문서 목록 조회...")
    page.goto("https://gw.ip-korea.org/Document/document_list.php?type=approved", timeout=30000)
    page.wait_for_load_state("networkidle")
    time.sleep(1)

    # 문서 목록 파싱
    docs = []
    rows = page.query_selector_all("tr")
    for row in rows:
        cells = row.query_selector_all("td")
        if len(cells) >= 5:
            doc_link = row.query_selector("a[href*='document_view']")
            if doc_link:
                doc_no = cells[0].inner_text().strip()
                subject = cells[1].inner_text().strip()[:80]
                dept = cells[2].inner_text().strip()
                writer = cells[3].inner_text().strip()
                status = cells[4].inner_text().strip()
                date = cells[5].inner_text().strip() if len(cells) > 5 else ""
                href = doc_link.get_attribute("href")

                docs.append({
                    "doc_no": doc_no,
                    "subject": subject,
                    "dept": dept,
                    "writer": writer,
                    "status": status,
                    "date": date,
                    "href": href
                })

    print(f"   총 {len(docs)}건 발견")

    # 문서 종류별 분류
    categories = {
        "leave": [],      # 휴가
        "expense": [],    # 경비
        "working": [],    # 근무
        "other": []       # 기타
    }

    for doc in docs:
        subj_lower = doc["subject"].lower()
        if "leave" in subj_lower or "휴가" in subj_lower:
            categories["leave"].append(doc)
        elif "card" in subj_lower or "expense" in subj_lower or "meal" in subj_lower:
            categories["expense"].append(doc)
        elif "working" in subj_lower or "근무" in subj_lower:
            categories["working"].append(doc)
        else:
            categories["other"].append(doc)

    print(f"\n   분류:")
    print(f"   - 휴가 관련: {len(categories['leave'])}건")
    print(f"   - 경비 관련: {len(categories['expense'])}건")
    print(f"   - 근무 관련: {len(categories['working'])}건")
    print(f"   - 기타: {len(categories['other'])}건")

    # 각 카테고리별 샘플 문서 상세 조회
    print("\n3. 샘플 문서 상세 조회...")

    sample_docs = []

    # 휴가 문서 1개
    if categories["leave"]:
        doc = categories["leave"][0]
        print(f"\n   [휴가] {doc['doc_no']}: {doc['subject'][:50]}")
        sample_docs.append(("leave", doc))

    # 경비 문서 1개
    if categories["expense"]:
        doc = categories["expense"][0]
        print(f"   [경비] {doc['doc_no']}: {doc['subject'][:50]}")
        sample_docs.append(("expense", doc))

    # 근무 문서 1개
    if categories["working"]:
        doc = categories["working"][0]
        print(f"   [근무] {doc['doc_no']}: {doc['subject'][:50]}")
        sample_docs.append(("working", doc))

    # 상세 페이지 캡처
    for cat, doc in sample_docs:
        href = doc["href"]
        if not href.startswith("http"):
            href = "https://gw.ip-korea.org/Document/" + href

        try:
            page.goto(href, timeout=30000)
            page.wait_for_load_state("networkidle")
            time.sleep(1)

            filename = f"screenshots/approved_docs/{cat}_{doc['doc_no']}.png"
            page.screenshot(path=filename, full_page=True)
            print(f"   -> {filename} 저장")

            # HTML도 저장
            html_file = f"screenshots/approved_docs/{cat}_{doc['doc_no']}.html"
            with open(html_file, "w", encoding="utf-8") as f:
                f.write(page.content())
        except Exception as e:
            print(f"   -> 오류: {e}")

    # 전체 목록 JSON 저장
    with open("screenshots/approved_docs/all_docs.json", "w", encoding="utf-8") as f:
        json.dump(docs, f, ensure_ascii=False, indent=2)
    print(f"\n   전체 목록: screenshots/approved_docs/all_docs.json")

    browser.close()
    print("\n완료!")
