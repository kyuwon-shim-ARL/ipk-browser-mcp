"""아무 휴가 서류에서 필드 구조 파악"""
from playwright.sync_api import sync_playwright
import time
import json
from pathlib import Path

cred_file = Path(__file__).parent / ".credentials"
creds = json.loads(cred_file.read_text())

# 기존 분석 데이터에서 휴가 서류 찾기
all_docs = json.loads(Path("screenshots/all_docs/all_documents.json").read_text())
leave_docs = [d for d in all_docs if 'leave' in d.get('subject', '').lower()]

print(f"발견된 휴가 관련 서류: {len(leave_docs)}건")
for d in leave_docs[:5]:
    print(f"  - {d['doc_no']}: {d['subject']} ({d['writer']})")

if not leave_docs:
    print("휴가 서류 없음")
    exit()

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1920, "height": 1080})
    page = context.new_page()

    # 로그인
    print("\n1. 로그인...")
    page.goto("https://gw.ip-korea.org", timeout=30000)
    page.wait_for_load_state("networkidle")
    page.fill("input[name='Username']", creds["username"])
    page.fill("input[name='Password']", creds["password"])
    page.evaluate("Check_Form()")
    time.sleep(3)

    if "main.php" not in page.url:
        page.goto("https://gw.ip-korea.org/main.php", timeout=30000)
        time.sleep(2)

    frame = page.frame("main_menu")

    patterns = []

    for doc in leave_docs[:3]:
        doc_no = doc['doc_no']
        print(f"\n2. 서류 조회: {doc_no}...")

        # 서류 검색/조회 시도
        # doc_no 형식: ARL-251218-10 -> 검색으로 접근
        search_url = f"https://gw.ip-korea.org/Document/document_list.php?path=approved_group&search_type=subject&search_word={doc_no}"
        frame.goto(search_url, timeout=30000)
        time.sleep(2)

        # 첫 번째 결과 클릭
        first_link = frame.evaluate("""
            () => {
                var link = document.querySelector('table.tblList tr:nth-child(2) td:nth-child(3) a');
                return link ? link.href : null;
            }
        """)

        if first_link:
            print(f"   링크 발견: {first_link[:50]}...")
            frame.goto(first_link, timeout=30000)
            time.sleep(2)

            # HTML 전체 저장 (디버깅용)
            html = frame.content()
            with open(f"screenshots/{doc_no.replace('-', '_')}_content.html", 'w') as f:
                f.write(html)

            # 필드 추출
            fields = frame.evaluate("""
                () => {
                    var result = {};
                    // 모든 th/td 쌍에서 추출
                    document.querySelectorAll('tr').forEach(row => {
                        var ths = row.querySelectorAll('th, td.l02');
                        var tds = row.querySelectorAll('td:not(.l02)');
                        ths.forEach((th, i) => {
                            var label = th.innerText.trim().replace(/[:\\s]+/g, ' ').trim();
                            var value = tds[i]?.innerText?.trim() || '';
                            if (label && value && value.length < 200) {
                                result[label] = value;
                            }
                        });
                    });
                    return result;
                }
            """)

            print(f"   추출된 필드:")
            for k, v in fields.items():
                if any(x in k.lower() for x in ['substitute', 'emergency', 'contact', 'address', 'telephone', '대리', '비상', '연락']):
                    print(f"   ★ {k}: {v}")
                    patterns.append({k: v, 'source': doc_no})

            page.screenshot(path=f"screenshots/{doc_no.replace('-', '_')}.png")
        else:
            print("   링크 없음")

    print("\n=== 추출된 패턴 ===")
    for p in patterns:
        print(json.dumps(p, ensure_ascii=False))

    # 저장
    with open("leave_patterns.json", 'w') as f:
        json.dump(patterns, f, ensure_ascii=False, indent=2)

    browser.close()
