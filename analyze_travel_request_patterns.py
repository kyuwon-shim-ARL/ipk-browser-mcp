#!/usr/bin/env python3
"""
Scrape ALL approved AppFrm-023 (Domestic Travel Request) documents
and analyze field patterns across them.

Output:
  analysis_results/travel_request_patterns.json  - per-document field values
  analysis_results/travel_request_analysis.json  - pattern analysis summary
"""

from ipk_gw import IPKGroupware, get_credential
from pathlib import Path
import time
import json
import re

FORM_CODE = "AppFrm-023"
OUTPUT_DIR = Path("analysis_results")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# JS to extract all field values from a travel request VIEW page
EXTRACT_FIELDS_JS = """() => {
    const result = {};

    // 1. All visible input/select/textarea values
    document.querySelectorAll('input, select, textarea').forEach(el => {
        const name = el.getAttribute('name') || el.getAttribute('id') || '';
        if (!name) return;
        if (el.tagName === 'SELECT') {
            const opt = el.options[el.selectedIndex];
            result['select:' + name] = {value: el.value, text: opt ? opt.text.trim() : ''};
        } else if (el.type === 'radio') {
            if (el.checked) result['radio:' + name] = el.value;
        } else if (el.type === 'checkbox') {
            if (el.checked) result['check:' + name] = el.value;
        } else if (el.type === 'hidden') {
            result['hidden:' + name] = el.value;
        } else {
            result[name] = el.value;
        }
    });

    // 2. Extract text from table cells (for view-mode fields that are plain text)
    const textCells = [];
    document.querySelectorAll('td, th').forEach(td => {
        const text = td.innerText.trim();
        if (text && text.length > 0 && text.length < 500) {
            textCells.push(text);
        }
    });
    result['_text_cells'] = textCells;

    // 3. Try to find specific labeled fields from table layout
    const labeled = {};
    document.querySelectorAll('tr').forEach(tr => {
        const tds = tr.querySelectorAll('td');
        if (tds.length >= 2) {
            const label = tds[0].innerText.trim();
            const value = tds[1].innerText.trim();
            if (label && value && label.length < 100) {
                labeled[label] = value;
            }
        }
    });
    result['_labeled_fields'] = labeled;

    return result;
}"""


def _find_label(cells: list[str], label: str, start: int = 0) -> int:
    """Find index of a label cell (exact match, stripped)."""
    for i in range(start, len(cells)):
        if cells[i].strip() == label:
            return i
    return -1


def _next_value(cells: list[str], label_idx: int) -> str:
    """Get the value cell immediately after a label."""
    if label_idx >= 0 and label_idx + 1 < len(cells):
        return cells[label_idx + 1].strip()
    return ""


def extract_structured_fields(text_cells: list[str]) -> dict:
    """Extract structured fields from text_cells using label-based search.

    Handles all layout subtypes (day-trip, overnight, PI-submitted)
    since labels are searched by name, not by fixed index.
    """
    cells = text_cells
    result = {}

    # --- Drafter info (search for pattern, not fixed index) ---
    for i, c in enumerate(cells):
        c_s = c.strip()
        if ('- Team Member -' in c_s or '- Team Head' in c_s
                or '- Researcher -' in c_s or '- Post-Doc -' in c_s
                or '- Senior Researcher -' in c_s):
            result['drafter_info'] = c_s
            break

    # --- Simple label -> next cell value fields ---
    label_map = {
        'Subject': 'subject',
        'Traveler': 'traveler',
        'Budget Control No': 'budget_control_no',
        'City & Transportation': 'city_transportation',
        'Type of Business Travel': 'business_travel_type',
        'Institute Credit Card No': 'corp_card',
        'Purpose': 'purpose',
        'Budget Account Code': 'budget_account',
    }
    for label, field_name in label_map.items():
        idx = _find_label(cells, label)
        val = _next_value(cells, idx)
        if val:
            result[field_name] = val

    # --- Travel with Invitation ---
    idx = _find_label(cells, 'Travel with Invitation')
    val = _next_value(cells, idx)
    if val:
        result['travel_with_invitation'] = val

    # --- Payment Date ---
    idx = _find_label(cells, 'Payment Date')
    val = _next_value(cells, idx)
    if val:
        result['payment_date'] = val

    # --- Itinerary: date range parsing ---
    idx = _find_label(cells, 'Itinerary')
    if idx == -1:
        # Try partial match
        for i, c in enumerate(cells):
            if c.strip().startswith('Itinerary'):
                idx = i
                break
    if idx >= 0 and idx + 1 < len(cells):
        date_cell = cells[idx + 1].strip()
        m = re.match(
            r'(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})'
            r'\s*\(\s*(\d+)\s*nights?\s*/\s*(\d+)\s*days?\s*\)',
            date_cell
        )
        if m:
            result['start_date'] = m.group(1)
            result['end_date'] = m.group(2)
            result['nights'] = int(m.group(3))
            result['days'] = int(m.group(4))
            tm = re.search(r',\s*(\d{2}:\d{2})\s*~\s*(\d{2}:\d{2})', date_cell)
            if tm:
                result['start_time'] = tm.group(1)
                result['end_time'] = tm.group(2)

    # --- Destination & Transport (fixed sequence after label) ---
    # Pattern: "Destination(...)" -> "Transportation" -> actual_dest -> actual_transport
    idx = _find_label(cells, 'Destination(Organization/Conference name)')
    if idx >= 0:
        # cells[idx+1] should be "Transportation" sub-label
        # cells[idx+2] = actual destination
        # cells[idx+3] = actual transport method
        if idx + 2 < len(cells):
            result['destination'] = cells[idx + 2].strip()
        if idx + 3 < len(cells):
            transport_val = cells[idx + 3].strip()
            # Guard: if it's a section header, skip
            if transport_val not in ('Traveling Budget', 'Category', 'Standard', ''):
                result['transport_method'] = transport_val

    # --- Financial fields ---
    # Daily Expense: label -> amount -> days_count -> card_amount
    idx = _find_label(cells, 'Daily Expense')
    if idx >= 0:
        val = _next_value(cells, idx)
        if val.isdigit():
            result['daily_expense'] = int(val)
        # days count is idx+2
        if idx + 2 < len(cells) and cells[idx + 2].strip().isdigit():
            result['daily_expense_days'] = int(cells[idx + 2].strip())

    # Accommodation
    idx = _find_label(cells, 'Accommodation')
    if idx >= 0:
        val = _next_value(cells, idx)
        # Guard: "Accommodation" also appears in attachment section
        if val.isdigit() or val.replace(',', '').isdigit():
            result['accommodation_amount'] = int(val.replace(',', ''))

    # Food Expense
    idx = _find_label(cells, 'Food Expense')
    if idx >= 0:
        val = _next_value(cells, idx)
        if val.isdigit() or val.replace(',', '').isdigit():
            result['food_expense_amount'] = int(val.replace(',', ''))

    # Total - find after financial section (not the first "Total" which may be elsewhere)
    # Search after Daily Expense to be safe
    daily_idx = _find_label(cells, 'Daily Expense')
    total_start = daily_idx if daily_idx >= 0 else 0
    idx = _find_label(cells, 'Total', total_start)
    if idx >= 0:
        # Total row: [Total] [card_total] [individual_total] [grand_total]
        # Or sometimes: [Total] [0] [20,000] [20,000]
        totals = []
        for offset in range(1, 4):
            if idx + offset < len(cells):
                v = cells[idx + offset].strip().replace(',', '')
                if v.isdigit():
                    totals.append(int(v))
        if totals:
            result['total_budget'] = totals[-1]  # Grand total is last

    # Transport fee: look for "-Own Car" or transport fee detail cells
    # The transport fee section has sub-items but the total is hard to extract
    # Search for "Transport Fee" label
    idx = _find_label(cells, 'Transport Fee')
    if idx >= 0:
        # Transport fee sub-items follow; find the total by looking at -Own Car value
        own_car_idx = _find_label(cells, '-Own Car', idx)
        if own_car_idx >= 0:
            val = _next_value(cells, own_car_idx)
            if val.isdigit() or val.replace(',', '').isdigit():
                v = val.replace(',', '')
                if v.isdigit() and int(v) > 0:
                    result['transport_fee_own_car'] = int(v)

    # --- Conference/Seminar Program (T4 fix) ---
    for i, c in enumerate(cells):
        if 'Conference' in c and 'Seminar Program' in c:
            if i + 1 < len(cells):
                val = cells[i + 1].strip()
                # Guard against section headers
                if val in ('Transport', 'Accommodation', 'Boarding Pass',
                           'ETC (Visa, Insurance etc)'):
                    result['conference_program'] = None
                elif val == 'No Conference/Seminar Program file':
                    result['conference_program'] = None
                else:
                    result['conference_program'] = val
            break

    # --- Number of meals served ---
    for i, c in enumerate(cells):
        m = re.match(r'Number of meals served:\s*(\d+)\s*meal', c.strip())
        if m:
            result['meals_served'] = int(m.group(1))
            break

    return result


def generate_traveler_profiles(all_structured: list[dict]) -> dict:
    """Generate per-traveler profiles with uncertainty flags (T5)."""
    from collections import Counter

    # Group by traveler
    by_traveler = {}
    for doc in all_structured:
        traveler = doc.get('traveler', '')
        if not traveler:
            continue
        if traveler not in by_traveler:
            by_traveler[traveler] = []
        by_traveler[traveler].append(doc)

    profiles = {}
    for traveler, docs in sorted(by_traveler.items()):
        n = len(docs)
        profile = {
            'traveler': traveler,
            'n_documents': n,
            'low_confidence': n <= 5,
        }

        # Corp card: MRU default + consistency
        cards = [d.get('corp_card', '') for d in docs if d.get('corp_card')]
        if cards:
            card_counter = Counter(cards)
            most_common_card, most_common_count = card_counter.most_common(1)[0]
            profile['corp_card'] = {
                'default': most_common_card,
                'confidence': round(most_common_count / len(cards), 2),
                'all_used': dict(card_counter.most_common()),
                'note': 'shared lab resource, soft default only'
            }

        # Budget accounts: ranked by recency (latest first)
        budgets = []
        for d in docs:
            ba = d.get('budget_account', '')
            if ba:
                budgets.append({'account': ba, 'date': d.get('date', '')})
        if budgets:
            # Sort by date descending
            budgets.sort(key=lambda x: x['date'], reverse=True)
            seen = []
            for b in budgets:
                if b['account'] not in seen:
                    seen.append(b['account'])
            profile['budget_accounts'] = {
                'ranked_by_recency': seen[:10],
                'total_unique': len(set(b['account'] for b in budgets)),
                'note': 'grant-cycle dependent, ranked by most recent use'
            }

        # City/transport patterns
        cities = Counter(d.get('city_transportation', '') for d in docs if d.get('city_transportation'))
        if cities:
            profile['city_transport_patterns'] = dict(cities.most_common(5))

        # Business travel type
        types = Counter(d.get('business_travel_type', '') for d in docs if d.get('business_travel_type'))
        if types:
            profile['travel_type_distribution'] = dict(types.most_common())

        # Daily expense
        expenses = [d.get('daily_expense') for d in docs if d.get('daily_expense') is not None]
        if expenses:
            profile['daily_expense_values'] = dict(Counter(expenses).most_common())

        # Drafter info
        drafters = [d.get('drafter_info', '') for d in docs if d.get('drafter_info')]
        if drafters:
            profile['drafter_info'] = Counter(drafters).most_common(1)[0][0]

        profiles[traveler] = profile

    return profiles


def find_travel_docs(gw: IPKGroupware) -> list[dict]:
    """Find all AppFrm-023 documents from approved list."""
    main_frame = gw.page.frame("main_menu")
    if not main_frame:
        print("ERROR: main_menu frame not found")
        return []

    docs = []
    page_num = 1

    # Navigate to approved docs filtered by AppFrm-023
    url = f"{gw.BASE_URL}/Document/document_list.php?type=approved&doc_form={FORM_CODE}"
    main_frame.goto(url, timeout=30000)
    time.sleep(2)
    main_frame.wait_for_load_state("networkidle")

    while True:
        print(f"  Page {page_num}...")

        # Extract doc links from current page
        page_docs = main_frame.evaluate("""() => {
            const docs = [];
            const rows = document.querySelectorAll('tr');
            for (const row of rows) {
                const link = row.querySelector('a[href*="document_view"]');
                if (!link) continue;
                const href = link.getAttribute('href') || '';
                const cells = row.querySelectorAll('td');
                if (cells.length >= 5) {
                    const docMatch = href.match(/doc_id=(\\d+)/);
                    docs.push({
                        doc_id: docMatch ? docMatch[1] : '',
                        doc_no: cells[0]?.innerText?.trim() || '',
                        subject: cells[1]?.innerText?.trim() || '',
                        dept: cells[2]?.innerText?.trim() || '',
                        writer: cells[3]?.innerText?.trim() || '',
                        status: cells[4]?.innerText?.trim() || '',
                        date: cells[5]?.innerText?.trim() || '',
                        href: href
                    });
                }
            }
            return docs;
        }""")

        if not page_docs:
            print(f"    No docs found on page {page_num}")
            break

        print(f"    Found {len(page_docs)} docs")
        docs.extend(page_docs)

        # Try next page
        has_next = main_frame.evaluate(f"""() => {{
            const links = document.querySelectorAll('a');
            for (const link of links) {{
                const text = link.innerText.trim();
                if (text === '{page_num + 1}') {{
                    link.click();
                    return true;
                }}
            }}
            return false;
        }}""")

        if not has_next:
            print(f"    Last page reached")
            break

        page_num += 1
        time.sleep(2)
        main_frame.wait_for_load_state("networkidle")

    # Also check groupapproved (team docs)
    print("\n  Checking team approved docs...")
    url_team = f"{gw.BASE_URL}/Document/document_list.php?type=groupapproved&doc_form={FORM_CODE}"
    main_frame.goto(url_team, timeout=30000)
    time.sleep(2)
    main_frame.wait_for_load_state("networkidle")

    page_num = 1
    while True:
        print(f"  Team page {page_num}...")
        page_docs = main_frame.evaluate("""() => {
            const docs = [];
            const rows = document.querySelectorAll('tr');
            for (const row of rows) {
                const link = row.querySelector('a[href*="document_view"]');
                if (!link) continue;
                const href = link.getAttribute('href') || '';
                const cells = row.querySelectorAll('td');
                if (cells.length >= 5) {
                    const docMatch = href.match(/doc_id=(\\d+)/);
                    docs.push({
                        doc_id: docMatch ? docMatch[1] : '',
                        doc_no: cells[0]?.innerText?.trim() || '',
                        subject: cells[1]?.innerText?.trim() || '',
                        dept: cells[2]?.innerText?.trim() || '',
                        writer: cells[3]?.innerText?.trim() || '',
                        status: cells[4]?.innerText?.trim() || '',
                        date: cells[5]?.innerText?.trim() || '',
                        href: href,
                        source: 'team'
                    });
                }
            }
            return docs;
        }""")

        if not page_docs:
            break

        print(f"    Found {len(page_docs)} team docs")
        docs.extend(page_docs)

        has_next = main_frame.evaluate(f"""() => {{
            const links = document.querySelectorAll('a');
            for (const link of links) {{
                if (link.innerText.trim() === '{page_num + 1}') {{
                    link.click();
                    return true;
                }}
            }}
            return false;
        }}""")

        if not has_next:
            break
        page_num += 1
        time.sleep(2)
        main_frame.wait_for_load_state("networkidle")

    # Deduplicate by doc_id
    seen = set()
    unique = []
    for d in docs:
        if d['doc_id'] and d['doc_id'] not in seen:
            seen.add(d['doc_id'])
            unique.append(d)

    print(f"\n  Total unique AppFrm-023 docs: {len(unique)}")
    return unique


def scrape_doc_fields(gw: IPKGroupware, doc_id: str) -> dict:
    """Scrape all field values from a single document view page."""
    main_frame = gw.page.frame("main_menu")
    if not main_frame:
        return {}

    url = f"{gw.BASE_URL}/Document/document_view.php?doc_id={doc_id}&approve_type={FORM_CODE}"
    main_frame.goto(url, timeout=30000)
    time.sleep(2)
    main_frame.wait_for_load_state("networkidle")

    fields = main_frame.evaluate(EXTRACT_FIELDS_JS)
    return fields


def analyze_patterns(all_docs_data: list[dict]) -> dict:
    """Analyze field patterns across all scraped documents."""
    if not all_docs_data:
        return {}

    # Collect all field keys (excluding _text_cells and _labeled_fields)
    all_keys = set()
    for doc in all_docs_data:
        fields = doc.get('fields', {})
        for k in fields:
            if not k.startswith('_'):
                all_keys.add(k)

    # For each field, collect all values across documents
    field_values = {}
    for key in sorted(all_keys):
        values = []
        for doc in all_docs_data:
            v = doc.get('fields', {}).get(key)
            if v is not None:
                values.append(v)
        field_values[key] = values

    # Classify fields
    analysis = {
        'total_documents': len(all_docs_data),
        'doc_ids': [d['doc_id'] for d in all_docs_data],
        'fields': {}
    }

    for key, values in field_values.items():
        # Skip complex nested values for pattern analysis
        str_values = []
        for v in values:
            if isinstance(v, dict):
                str_values.append(json.dumps(v, ensure_ascii=False))
            else:
                str_values.append(str(v))

        unique_values = list(set(str_values))
        presence_rate = len(values) / len(all_docs_data)

        field_info = {
            'presence_rate': round(presence_rate, 2),
            'unique_count': len(unique_values),
            'all_values': unique_values,
        }

        # Classification
        if len(unique_values) == 1 and presence_rate >= 0.8:
            field_info['pattern'] = 'FIXED'
            field_info['fixed_value'] = unique_values[0]
        elif len(unique_values) == len(values) and len(values) > 1:
            field_info['pattern'] = 'UNIQUE_PER_DOC'
        elif len(unique_values) <= 3 and len(values) > 2:
            field_info['pattern'] = 'LOW_CARDINALITY'
        else:
            field_info['pattern'] = 'VARIABLE'

        analysis['fields'][key] = field_info

    # Extract labeled field patterns from _labeled_fields
    labeled_patterns = {}
    for doc in all_docs_data:
        labeled = doc.get('fields', {}).get('_labeled_fields', {})
        for label, value in labeled.items():
            if label not in labeled_patterns:
                labeled_patterns[label] = []
            labeled_patterns[label].append(value)

    # Analyze labeled fields too
    labeled_analysis = {}
    for label, values in labeled_patterns.items():
        unique = list(set(values))
        labeled_analysis[label] = {
            'unique_count': len(unique),
            'sample_values': unique[:5],
            'pattern': 'FIXED' if len(unique) == 1 else ('LOW_CARDINALITY' if len(unique) <= 3 else 'VARIABLE')
        }
    analysis['labeled_fields'] = labeled_analysis

    # Summary
    field_summary = {'FIXED': [], 'UNIQUE_PER_DOC': [], 'LOW_CARDINALITY': [], 'VARIABLE': []}
    for key, info in analysis['fields'].items():
        field_summary[info['pattern']].append(key)

    analysis['summary'] = {
        'fixed_fields': len(field_summary['FIXED']),
        'unique_per_doc_fields': len(field_summary['UNIQUE_PER_DOC']),
        'low_cardinality_fields': len(field_summary['LOW_CARDINALITY']),
        'variable_fields': len(field_summary['VARIABLE']),
        'field_names_by_pattern': field_summary
    }

    return analysis


def main():
    print(f"=== AppFrm-023 Travel Request Pattern Analysis ===\n")

    gw = IPKGroupware(headless=True)

    try:
        username = get_credential("username", "Username")
        password = get_credential("password", "Password")
        gw.login(username, password)
        print("Login OK\n")

        # Step 1: Find all AppFrm-023 docs
        print("Step 1: Finding all AppFrm-023 documents...")
        doc_list = find_travel_docs(gw)

        if not doc_list:
            print("No AppFrm-023 documents found!")
            return

        # Save doc list
        list_path = OUTPUT_DIR / "travel_request_doc_list.json"
        with open(list_path, "w", encoding="utf-8") as f:
            json.dump(doc_list, f, ensure_ascii=False, indent=2)
        print(f"Doc list saved: {list_path}")

        # Step 2: Scrape each document
        print(f"\nStep 2: Scraping {len(doc_list)} documents...")
        all_docs_data = []

        for i, doc in enumerate(doc_list):
            doc_id = doc['doc_id']
            print(f"  [{i+1}/{len(doc_list)}] doc_id={doc_id} - {doc.get('subject', '')[:60]}")

            try:
                fields = scrape_doc_fields(gw, doc_id)
                all_docs_data.append({
                    'doc_id': doc_id,
                    'doc_no': doc.get('doc_no', ''),
                    'subject': doc.get('subject', ''),
                    'writer': doc.get('writer', ''),
                    'date': doc.get('date', ''),
                    'fields': fields
                })
            except Exception as e:
                print(f"    ERROR: {e}")

            time.sleep(1)  # Rate limit

        # Save raw scraped data
        raw_path = OUTPUT_DIR / "travel_request_patterns.json"
        with open(raw_path, "w", encoding="utf-8") as f:
            json.dump(all_docs_data, f, ensure_ascii=False, indent=2)
        print(f"\nRaw data saved: {raw_path}")

        # Step 3: Analyze patterns
        print(f"\nStep 3: Analyzing patterns across {len(all_docs_data)} documents...")
        analysis = analyze_patterns(all_docs_data)

        analysis_path = OUTPUT_DIR / "travel_request_analysis.json"
        with open(analysis_path, "w", encoding="utf-8") as f:
            json.dump(analysis, f, ensure_ascii=False, indent=2)
        print(f"Analysis saved: {analysis_path}")

        # Print summary
        summary = analysis.get('summary', {})
        print(f"\n=== PATTERN SUMMARY ===")
        print(f"Total documents analyzed: {analysis.get('total_documents', 0)}")
        print(f"  FIXED fields (same in all docs):    {summary.get('fixed_fields', 0)}")
        print(f"  LOW_CARDINALITY (2-3 values):       {summary.get('low_cardinality_fields', 0)}")
        print(f"  VARIABLE (changes each time):       {summary.get('variable_fields', 0)}")
        print(f"  UNIQUE_PER_DOC (always different):  {summary.get('unique_per_doc_fields', 0)}")

        # Print fixed fields
        fixed = summary.get('field_names_by_pattern', {}).get('FIXED', [])
        if fixed:
            print(f"\n--- FIXED Fields (reuse as-is) ---")
            for f in fixed:
                val = analysis['fields'][f].get('fixed_value', '')
                print(f"  {f}: {val[:80]}")

        # Print low cardinality
        low_card = summary.get('field_names_by_pattern', {}).get('LOW_CARDINALITY', [])
        if low_card:
            print(f"\n--- LOW CARDINALITY Fields (choose from few options) ---")
            for f in low_card:
                vals = analysis['fields'][f].get('all_values', [])
                print(f"  {f}: {vals}")

        # Step 4: Structured extraction from text_cells
        print(f"\nStep 4: Extracting structured fields from text_cells...")
        all_structured = []
        for doc in all_docs_data:
            text_cells = doc.get('fields', {}).get('_text_cells', [])
            structured = extract_structured_fields(text_cells)
            structured['doc_id'] = doc['doc_id']
            structured['writer'] = doc.get('writer', '')
            structured['date'] = doc.get('date', '')
            all_structured.append(structured)

        struct_path = OUTPUT_DIR / "travel_request_structured_analysis.json"
        with open(struct_path, "w", encoding="utf-8") as f:
            json.dump({
                'total_documents': len(all_structured),
                'my_documents': sum(1 for d in all_structured if 'Kyuwon Shim' in d.get('traveler', '')),
                'structured_data': all_structured,
            }, f, ensure_ascii=False, indent=2)
        print(f"Structured analysis saved: {struct_path}")

        # Step 5: Generate per-traveler profiles
        print(f"\nStep 5: Generating per-traveler profiles...")
        profiles = generate_traveler_profiles(all_structured)
        profile_path = OUTPUT_DIR / "traveler_profiles.json"
        with open(profile_path, "w", encoding="utf-8") as f:
            json.dump(profiles, f, ensure_ascii=False, indent=2)
        print(f"Traveler profiles saved: {profile_path}")
        print(f"  {len(profiles)} travelers profiled")
        low_conf = sum(1 for p in profiles.values() if p.get('low_confidence'))
        print(f"  {low_conf} marked low_confidence (n<=5)")

        print(f"\nDone!")

    except Exception as e:
        print(f"ERROR: {e}")
        import traceback
        traceback.print_exc()

    finally:
        gw.close()


if __name__ == "__main__":
    main()
