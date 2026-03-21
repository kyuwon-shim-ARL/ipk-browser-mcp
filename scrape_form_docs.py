#!/usr/bin/env python3
"""
Universal form document scraper for IPK groupware.

Two-phase scraper:
  Phase 1: Discover doc list filtered by form_code (approved + team approved, paginated)
  Phase 2: Scrape each doc's view page to extract text_cells, labeled_fields, and form values

Supports: AppFrm-023 (travel request), AppFrm-073 (leave), AppFrm-027 (working),
          AppFrm-076 (travel report). Expense (AppFrm-021) excluded due to complexity.

Usage:
  python scrape_form_docs.py AppFrm-073           # scrape leave docs
  python scrape_form_docs.py AppFrm-073 --list-only  # just discover doc list, no scraping
  python scrape_form_docs.py all                   # scrape all supported forms
"""

from ipk_gw import IPKGroupware, get_credential
from pathlib import Path
import argparse
import time
import json
import sys

SUPPORTED_FORMS = {
    "AppFrm-023": "travel_request",
    "AppFrm-073": "leave",
    "AppFrm-027": "working",
    "AppFrm-076": "travel_report",
    "AppFrm-039": "purchase_request",
    "AppFrm-054": "domestic_travel_settlement",
    "AppFrm-020": "card_expense",
    "AppFrm-028": "leave_return",
    "AppFrm-043": "seminar_event",
    "AppFrm-026": "overseas_travel_settlement",
}

OUTPUT_DIR = Path("analysis_results")

# JS to extract all field values from a document VIEW page
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


def find_docs(gw: IPKGroupware, form_code: str) -> list[dict]:
    """Phase 1: Discover all documents for a given form_code.

    Searches both personal approved and team approved lists with pagination.
    """
    main_frame = gw.page.frame("main_menu")
    if not main_frame:
        print("ERROR: main_menu frame not found")
        return []

    docs = []

    for list_type, label in [("approved", "Personal"), ("groupapproved", "Team")]:
        page_num = 1
        empty_pages = 0
        while True:
            # Build URL with start_page for reliable pagination
            # groupapproved does NOT support doc_form filter — scrape all, filter client-side
            if list_type == "groupapproved":
                url = (f"{gw.BASE_URL}/Document/document_list.php?"
                       f"type={list_type}&doc_form=&start_page={page_num}"
                       f"&s_date=2025-03-01&e_date=2026-12-31")
            else:
                url = (f"{gw.BASE_URL}/Document/document_list.php?"
                       f"type={list_type}&doc_form={form_code}&start_page={page_num}"
                       f"&s_date=2025-03-01&e_date=2026-12-31")
            main_frame.goto(url, timeout=30000)
            time.sleep(2)
            main_frame.wait_for_load_state("networkidle")

            print(f"  {label} page {page_num}...")

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
                        const formMatch = href.match(/approve_type=([^&]+)/);
                        docs.push({
                            doc_id: docMatch ? docMatch[1] : '',
                            form_code: formMatch ? formMatch[1] : '',
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
                empty_pages += 1
                if empty_pages >= 2 or page_num == 1:
                    if page_num == 1:
                        print(f"    No docs found for {form_code} ({label})")
                    break
                # Sometimes a page is empty but next has data; tolerate 1 empty
                page_num += 1
                continue

            empty_pages = 0

            # For groupapproved, filter by form_code from href
            if list_type == "groupapproved":
                matched = [d for d in page_docs if d.get('form_code') == form_code]
                print(f"    Found {len(page_docs)} total, {len(matched)} matching {form_code}")
                for d in matched:
                    d['source'] = list_type
                docs.extend(matched)
            else:
                print(f"    Found {len(page_docs)} docs")
                for d in page_docs:
                    d['source'] = list_type
                docs.extend(page_docs)

            page_num += 1

    # Deduplicate by doc_id
    seen = set()
    unique = []
    for d in docs:
        if d['doc_id'] and d['doc_id'] not in seen:
            seen.add(d['doc_id'])
            unique.append(d)

    print(f"  Total unique {form_code} docs: {len(unique)}")
    return unique


def scrape_doc_fields(gw: IPKGroupware, form_code: str, doc_id: str) -> dict:
    """Phase 2: Scrape all field values from a single document view page."""
    main_frame = gw.page.frame("main_menu")
    if not main_frame:
        return {}

    url = f"{gw.BASE_URL}/Document/document_view.php?doc_id={doc_id}&approve_type={form_code}"
    main_frame.goto(url, timeout=30000)
    time.sleep(2)
    main_frame.wait_for_load_state("networkidle")

    fields = main_frame.evaluate(EXTRACT_FIELDS_JS)
    return fields


def scrape_form(gw: IPKGroupware, form_code: str, form_name: str, list_only: bool = False):
    """Full scrape pipeline for one form type."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    print(f"\n{'='*60}")
    print(f"Scraping {form_code} ({form_name})")
    print(f"{'='*60}")

    # Phase 1: Discover docs
    print("\nPhase 1: Discovering documents...")
    doc_list = find_docs(gw, form_code)

    if not doc_list:
        print(f"No documents found for {form_code}")
        return

    # Save doc list
    list_file = OUTPUT_DIR / f"{form_name}_doc_list.json"
    with open(list_file, "w", encoding="utf-8") as f:
        json.dump(doc_list, f, ensure_ascii=False, indent=2)
    print(f"Doc list saved: {list_file} ({len(doc_list)} docs)")

    if list_only:
        print("--list-only mode, skipping view page scraping")
        return

    # Phase 2: Scrape each doc
    print(f"\nPhase 2: Scraping {len(doc_list)} documents...")
    all_data = []
    errors = []

    for i, doc in enumerate(doc_list):
        doc_id = doc['doc_id']
        print(f"  [{i+1}/{len(doc_list)}] doc_id={doc_id} - {doc.get('subject', '')[:60]}")

        try:
            fields = scrape_doc_fields(gw, form_code, doc_id)
            if fields:
                all_data.append({
                    'doc_id': doc_id,
                    'doc_no': doc.get('doc_no', ''),
                    'subject': doc.get('subject', ''),
                    'writer': doc.get('writer', ''),
                    'date': doc.get('date', ''),
                    'source': doc.get('source', 'approved'),
                    'fields': fields,
                    'text_cells': fields.get('_text_cells', []),
                    'labeled_fields': fields.get('_labeled_fields', {}),
                })
                print(f"    OK - {len(fields.get('_text_cells', []))} text cells")
            else:
                errors.append({'doc_id': doc_id, 'error': 'empty fields'})
                print(f"    WARN: empty fields")
        except Exception as e:
            errors.append({'doc_id': doc_id, 'error': str(e)})
            print(f"    ERROR: {e}")

    # Save raw patterns
    patterns_file = OUTPUT_DIR / f"{form_name}_patterns.json"
    with open(patterns_file, "w", encoding="utf-8") as f:
        json.dump({
            'form_code': form_code,
            'form_name': form_name,
            'total_documents': len(all_data),
            'errors': errors,
            'documents': all_data,
        }, f, ensure_ascii=False, indent=2)

    print(f"\nResults saved: {patterns_file}")
    print(f"  Scraped: {len(all_data)}, Errors: {len(errors)}")


def main():
    parser = argparse.ArgumentParser(description="Universal IPK groupware form scraper")
    parser.add_argument("form_code", help="Form code (e.g. AppFrm-073) or 'all'")
    parser.add_argument("--list-only", action="store_true", help="Only discover doc list, skip scraping")
    args = parser.parse_args()

    # Determine which forms to scrape
    if args.form_code.lower() == "all":
        forms_to_scrape = list(SUPPORTED_FORMS.items())
    elif args.form_code in SUPPORTED_FORMS:
        forms_to_scrape = [(args.form_code, SUPPORTED_FORMS[args.form_code])]
    else:
        print(f"Unknown form code: {args.form_code}")
        print(f"Supported: {', '.join(SUPPORTED_FORMS.keys())} or 'all'")
        sys.exit(1)

    # Login once
    gw = IPKGroupware(headless=True)
    try:
        username = get_credential("username", "Username")
        password = get_credential("password", "Password")
        gw.login(username, password)
        print("Login OK")

        for form_code, form_name in forms_to_scrape:
            scrape_form(gw, form_code, form_name, list_only=args.list_only)

    except Exception as e:
        print(f"ERROR: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    finally:
        gw.close()

    print("\nDone!")


if __name__ == "__main__":
    main()
