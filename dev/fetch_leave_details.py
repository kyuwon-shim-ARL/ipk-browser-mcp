"""Kyuwon Shim의 기존 휴가 신청서에서 대리자/비상연락처 패턴 추출"""
from playwright.sync_api import sync_playwright
import time
import json
from pathlib import Path

cred_file = Path(__file__).parent / ".credentials"
creds = json.loads(cred_file.read_text())

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1920, "height": 1080})
    page = context.new_page()

    # 로그인
    print("1. 로그인...")
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

    # Kyuwon Shim의 승인된 휴가 서류 찾기 (팀 서류에서)
    print("\n2. 승인된 휴가 서류 검색 (팀)...")
    frame.goto("https://gw.ip-korea.org/Document/document_list.php?path=approved_group", timeout=30000)
    time.sleep(2)

    # 휴가 관련 서류 링크 수집 (Kyuwon Shim 또는 전체)
    leave_docs = frame.evaluate("""
        () => {
            var rows = document.querySelectorAll('table.tblList tr');
            var docs = [];
            rows.forEach((row, i) => {
                if (i === 0) return;
                var cells = row.querySelectorAll('td');
                if (cells.length > 3) {
                    var subject = cells[2]?.innerText?.trim() || '';
                    var writer = cells[3]?.innerText?.trim() || '';
                    var link = cells[2]?.querySelector('a')?.href || '';
                    // 휴가 관련 서류만 (Kyuwon Shim 또는 다른 멤버)
                    if (subject.toLowerCase().includes('leave') ||
                        subject.includes('연차') ||
                        subject.includes('휴가')) {
                        docs.push({
                            subject: subject,
                            writer: writer,
                            link: link,
                            is_kyuwon: writer.includes('Kyuwon') || writer.includes('심규원')
                        });
                    }
                }
            });
            // Kyuwon 것 우선, 최대 5개
            docs.sort((a, b) => (b.is_kyuwon ? 1 : 0) - (a.is_kyuwon ? 1 : 0));
            return docs.slice(0, 5);
        }
    """)

    print(f"   발견된 휴가 서류: {len(leave_docs)}건")
    for d in leave_docs:
        print(f"   - {d['subject']}")

    # 각 서류의 상세 필드 추출
    leave_patterns = []

    for doc in leave_docs[:3]:  # 최대 3개 분석
        if not doc['link']:
            continue

        print(f"\n3. 분석 중: {doc['subject'][:50]}...")

        # 서류 상세 페이지로 이동
        try:
            frame.goto(doc['link'], timeout=30000)
            time.sleep(2)

            # 필드 값 추출
            fields = frame.evaluate("""
                () => {
                    var result = {};

                    // 테이블에서 필드 찾기
                    var tables = document.querySelectorAll('table');
                    tables.forEach(table => {
                        var rows = table.querySelectorAll('tr');
                        rows.forEach(row => {
                            var th = row.querySelector('th, td.l02');
                            var td = row.querySelector('td:not(.l02)');
                            if (th && td) {
                                var label = th.innerText.trim();
                                var value = td.innerText.trim();

                                // 관심 필드
                                if (label.includes('Substitute') || label.includes('대리자')) {
                                    result['substitute'] = value;
                                }
                                if (label.includes('Emergency') || label.includes('비상')) {
                                    if (label.includes('Address') || label.includes('주소')) {
                                        result['emergency_address'] = value;
                                    } else if (label.includes('Telephone') || label.includes('전화')) {
                                        result['emergency_telephone'] = value;
                                    } else {
                                        result['emergency_other'] = value;
                                    }
                                }
                                if (label.includes('Destination') || label.includes('목적지')) {
                                    result['destination'] = value;
                                }
                            }
                        });
                    });

                    // 특정 필드 직접 찾기
                    var subName = document.querySelector('[name="substitute_name"]')?.value ||
                                  document.querySelector('#substitute_name')?.innerText;
                    if (subName) result['substitute_name'] = subName;

                    var subPayroll = document.querySelector('[name="substitute_payroll"]')?.value;
                    if (subPayroll) result['substitute_payroll'] = subPayroll;

                    var emergAddr = document.querySelector('[name="emergency_address"]')?.value;
                    if (emergAddr) result['emergency_address_field'] = emergAddr;

                    var emergTel = document.querySelector('[name="emergency_telephone"]')?.value;
                    if (emergTel) result['emergency_telephone_field'] = emergTel;

                    return result;
                }
            """)

            if fields:
                fields['source_doc'] = doc['subject']
                leave_patterns.append(fields)
                print(f"   추출된 필드: {json.dumps(fields, ensure_ascii=False, indent=2)}")

        except Exception as e:
            print(f"   에러: {e}")

    # 패턴 저장
    output_file = Path(__file__).parent / "leave_patterns.json"
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(leave_patterns, f, ensure_ascii=False, indent=2)

    print(f"\n4. 패턴 저장: {output_file}")
    print("\n=== 추출된 패턴 요약 ===")
    for p in leave_patterns:
        print(json.dumps(p, ensure_ascii=False, indent=2))

    browser.close()
