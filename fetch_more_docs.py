"""더 많은 승인된 문서 가져오기 v2"""
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
    time.sleep(3)
    page.wait_for_load_state("networkidle")

    # main.php로 이동 확인
    if "main.php" not in page.url:
        page.goto("https://gw.ip-korea.org/main.php", timeout=30000)
        time.sleep(2)

    print(f"   현재 URL: {page.url}")

    # 프레임 확인
    frames = page.frames
    print(f"   프레임 수: {len(frames)}")
    for f in frames:
        print(f"   - {f.name}: {f.url[:60] if f.url else 'no url'}")

    # left_menu 프레임에서 Approved 클릭
    print("\n2. Approved 목록 이동...")
    left_frame = page.frame("left_menu")
    if left_frame:
        print("   left_menu 프레임 발견")

        # Document List 메뉴 클릭하여 서브메뉴 열기
        doc_list = left_frame.query_selector("b:has-text('Document List')")
        if doc_list:
            doc_list.click()
            time.sleep(1)
            print("   Document List 클릭")

        # Approved 클릭
        approved = left_frame.query_selector("a[href*='type=approved']:not([href*='approved_cc']):not([href*='groupapproved'])")
        if approved:
            approved.click()
            time.sleep(2)
            print("   Approved 클릭")
    else:
        print("   left_menu 프레임을 찾을 수 없음")

    # main_menu 프레임
    main_frame = page.frame("main_menu")
    if not main_frame:
        print("   main_menu 프레임을 찾을 수 없음")
        # 전체 페이지 스크린샷
        page.screenshot(path="screenshots/approved_docs/debug.png")
        browser.close()
        exit()

    print("   main_menu 프레임 발견")
    main_frame.wait_for_load_state("networkidle")
    time.sleep(1)

    # 전체 목록 캡처
    page.screenshot(path="screenshots/approved_docs/approved_list_full.png")

    # 테이블에서 문서 정보 추출
    print("\n3. 문서 목록 파싱...")
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

                if doc_no.startswith("ARL"):  # 유효한 문서번호만
                    docs.append({
                        "doc_no": doc_no,
                        "subject": subject[:100],
                        "dept": dept,
                        "writer": writer,
                        "status": status,
                        "date": date
                    })

    print(f"   총 {len(docs)}건 발견")

    # 문서 종류별 분류 및 출력
    print("\n4. 문서 목록:")
    for i, doc in enumerate(docs[:20]):
        subj = doc['subject'][:60]
        # 종류 판별
        if 'leave' in subj.lower():
            kind = "휴가"
        elif 'card' in subj.lower() or 'expense' in subj.lower():
            kind = "경비"
        elif 'working' in subj.lower():
            kind = "근무"
        else:
            kind = "기타"

        print(f"   [{kind}] {doc['doc_no']}: {subj}")

    # JSON 저장
    with open("screenshots/approved_docs/doc_list.json", "w", encoding="utf-8") as f:
        json.dump(docs, f, ensure_ascii=False, indent=2)
    print(f"\n   JSON 저장: screenshots/approved_docs/doc_list.json")

    # 휴가 문서 하나 상세 보기
    print("\n5. 휴가 문서 상세 조회...")
    for doc in docs:
        if 'leave' in doc['subject'].lower():
            # 해당 문서 링크 찾기
            links = main_frame.query_selector_all("a")
            for link in links:
                if doc['doc_no'] in (link.inner_text() or ""):
                    link.click()
                    time.sleep(2)
                    main_frame.wait_for_load_state("networkidle")
                    page.screenshot(path="screenshots/approved_docs/leave_sample.png", full_page=True)
                    with open("screenshots/approved_docs/leave_sample.html", "w", encoding="utf-8") as f:
                        f.write(main_frame.content())
                    print(f"   -> {doc['doc_no']} (휴가) 저장완료")
                    break
            break

    # 뒤로가기
    back = main_frame.query_selector("a:has-text('Document List')")
    if back:
        back.click()
        time.sleep(2)
        main_frame.wait_for_load_state("networkidle")

    # 경비 문서 하나 상세 보기
    print("\n6. 경비 문서 상세 조회...")
    for doc in docs:
        if 'card' in doc['subject'].lower():
            links = main_frame.query_selector_all("a")
            for link in links:
                if doc['doc_no'] in (link.inner_text() or ""):
                    link.click()
                    time.sleep(2)
                    main_frame.wait_for_load_state("networkidle")
                    page.screenshot(path="screenshots/approved_docs/expense_sample.png", full_page=True)
                    with open("screenshots/approved_docs/expense_sample.html", "w", encoding="utf-8") as f:
                        f.write(main_frame.content())
                    print(f"   -> {doc['doc_no']} (경비) 저장완료")
                    break
            break

    browser.close()
    print("\n완료!")
