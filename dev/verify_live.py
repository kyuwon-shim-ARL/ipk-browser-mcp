"""
Live verification script for IPK groupware automation.
T1: Inspect 3 forms DOM vs templates
T2: Capture document_view.php HTML, test document_lookup parser
T3: Verify setRequiredField works on a real form (no actual submit)
"""
import os
import sys
import json
import time
from playwright.sync_api import sync_playwright

BASE_URL = os.environ.get("IPK_BASE_URL", "https://gw.ip-korea.org/main.php").replace("/main.php", "")
USERNAME = os.environ.get("IPK_USERNAME", "")
PASSWORD = os.environ.get("IPK_PASSWORD", "")

FORMS_TO_INSPECT = {
    "AppFrm-054": "form_templates/AppFrm-054.json",
    "AppFrm-023": "form_templates/AppFrm-023.json",
    "AppFrm-073": "form_templates/AppFrm-073.json",
}

results = {"T1_inspect": {}, "T2_document_lookup": {}, "T3_field_test": {}, "errors": []}


def login(page):
    """Login to IPK groupware."""
    page.goto(f"{BASE_URL}/main.php", timeout=30000)
    page.wait_for_load_state("networkidle")

    if "main.php" in page.url:
        # Check if main_menu frame exists (actually logged in)
        frame = page.frame("main_menu")
        if frame:
            print("[LOGIN] Already logged in via session")
            return True

    # Need to login
    page.goto(f"{BASE_URL}/", timeout=30000)
    page.wait_for_load_state("networkidle")

    page.fill("input[name='Username']", USERNAME)
    page.fill("input[name='Password']", PASSWORD)
    page.evaluate("Check_Form()")
    page.wait_for_load_state("networkidle")
    time.sleep(2)

    if "main.php" not in page.url:
        page.goto(f"{BASE_URL}/main.php", timeout=30000)
        time.sleep(1)

    if "main.php" in page.url:
        print("[LOGIN] Success")
        return True
    else:
        print(f"[LOGIN] FAILED - URL: {page.url}")
        return False


def inspect_form_dom(page, form_code):
    """T1: Navigate to form, enumerate DOM elements."""
    frame = page.frame("main_menu")
    if not frame:
        return {"error": "main_menu frame not found"}

    url = f"{BASE_URL}/Document/document_write.php?approve_type={form_code}"
    frame.goto(url, timeout=30000)
    frame.wait_for_load_state("networkidle")
    time.sleep(2)

    # Wait for form elements
    try:
        frame.wait_for_selector("input, select, textarea", timeout=8000)
    except Exception:
        pass

    # Enumerate all named form elements
    elements = frame.evaluate("""() => {
        const els = [];
        document.querySelectorAll('input, select, textarea').forEach(el => {
            if (!el.name) return;
            const info = {
                tag: el.tagName.toLowerCase(),
                name: el.name,
                type: el.type || el.tagName.toLowerCase(),
                id: el.id || '',
                required: el.required || false,
                className: el.className || ''
            };
            if (el.tagName === 'SELECT') {
                info.options = Array.from(el.options).map(o => ({
                    value: o.value,
                    text: (o.textContent || '').trim()
                }));
            }
            els.push(info);
        });
        return els;
    }""")

    return {"url": frame.url, "element_count": len(elements), "elements": elements}


def compare_with_template(dom_result, template_path):
    """Compare DOM elements with template JSON."""
    if "error" in dom_result:
        return {"error": dom_result["error"]}

    if not os.path.exists(template_path):
        return {"error": f"Template not found: {template_path}"}

    with open(template_path) as f:
        template = json.load(f)

    field_schema = template.get("field_schema", {})
    # Use dom_name if available, otherwise fall back to field key
    template_to_dom = {}
    for k, v in field_schema.items():
        dom_name = v.get("dom_name", k)
        template_to_dom[k] = dom_name
    template_dom_names = set(template_to_dom.values())
    template_keys = set(field_schema.keys())
    dom_names = set(e["name"] for e in dom_result["elements"])

    in_template_not_in_dom = sorted(template_dom_names - dom_names)
    in_dom_not_in_template = sorted(dom_names - template_dom_names)

    # Type mismatches (using dom_name mapping)
    type_mismatches = []
    dom_by_name = {e["name"]: e for e in dom_result["elements"]}
    for key, dom_name in template_to_dom.items():
        if dom_name not in dom_names:
            continue
        t_type = field_schema[key].get("dom_type", field_schema[key].get("type", ""))
        dom_el = dom_by_name[dom_name]
        dom_type = dom_el["tag"] if dom_el["tag"] in ("textarea", "select") else dom_el["type"]

        def normalize(t):
            if t in ("textarea",): return "textarea"
            if t in ("select", "select-one", "select-multiple"): return "select"
            return t

        if normalize(t_type) != normalize(dom_type):
            type_mismatches.append({"field": key, "template": t_type, "dom": dom_type})

    return {
        "template_fields": len(template_keys),
        "dom_fields": len(dom_names),
        "in_template_not_in_dom": in_template_not_in_dom,
        "in_dom_not_in_template": in_dom_not_in_template,
        "type_mismatches": type_mismatches,
        "match_rate": f"{len(template_dom_names & dom_names)}/{len(template_keys)}"
    }


def test_document_lookup(page):
    """T2: Navigate to a recent document_view.php and test parser."""
    frame = page.frame("main_menu")
    if not frame:
        return {"error": "main_menu frame not found"}

    # Navigate to document list to find a recent document
    list_url = f"{BASE_URL}/Document/document_list.php?approve_type=AppFrm-023"
    frame.goto(list_url, timeout=30000)
    frame.wait_for_load_state("networkidle")
    time.sleep(2)

    # Find first doc_id link
    doc_links = frame.evaluate("""() => {
        const links = [];
        document.querySelectorAll('a[href*="doc_id="]').forEach(a => {
            const match = a.href.match(/doc_id=(\\d+)/);
            if (match) {
                links.push({doc_id: match[1], text: (a.textContent || '').trim().substring(0, 80)});
            }
        });
        return links.slice(0, 5);
    }""")

    if not doc_links:
        return {"error": "No documents found in list", "list_url": list_url}

    # Navigate to first document within the iframe
    first_doc = doc_links[0]
    view_url = f"{BASE_URL}/Document/document_view.php?doc_id={first_doc['doc_id']}"
    frame.goto(view_url, timeout=30000)
    frame.wait_for_load_state("networkidle")
    time.sleep(3)

    # Capture HTML from the iframe (frame content, not outer page)
    html = frame.content()

    # Save as fixture
    fixture_dir = "test/fixtures"
    os.makedirs(fixture_dir, exist_ok=True)
    fixture_path = f"{fixture_dir}/document_view_AppFrm-023_sample.html"
    with open(fixture_path, "w") as f:
        f.write(html)

    # Run document_lookup parser
    sys.path.insert(0, ".")
    from document_lookup import parse_document_fields
    parsed = parse_document_fields(html, "travel_request")

    return {
        "doc_id": first_doc["doc_id"],
        "doc_subject": first_doc["text"],
        "html_length": len(html),
        "fixture_saved": fixture_path,
        "parsed_fields": parsed,
        "fields_extracted": len([k for k in parsed if not k.startswith("_")])
    }


def test_field_setting(page, form_code="AppFrm-073"):
    """T3: Navigate to leave form, test setRequiredField equivalent (no actual submit)."""
    frame = page.frame("main_menu")
    if not frame:
        return {"error": "main_menu frame not found"}

    url = f"{BASE_URL}/Document/document_write.php?approve_type={form_code}"
    frame.goto(url, timeout=30000)
    frame.wait_for_load_state("networkidle")
    time.sleep(2)

    try:
        frame.wait_for_selector("input, select, textarea", timeout=8000)
    except Exception:
        pass

    # Test setting the subject field (should exist on all forms)
    set_results = {}

    # Try setting subject
    subject_result = frame.evaluate("""(val) => {
        const selectors = [
            'input[name="subject"]',
            '.validate[name="subject"]',
            'input#subject'
        ];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el) {
                el.value = val;
                el.dispatchEvent(new Event('input', {bubbles: true}));
                el.dispatchEvent(new Event('change', {bubbles: true}));
                return {found: true, selector: sel, value: el.value};
            }
        }
        return {found: false, tried: selectors};
    }""", "[TEST] Verification Subject - DO NOT SUBMIT")
    set_results["subject"] = subject_result

    # Test select elements
    select_names = frame.evaluate("""() => {
        return Array.from(document.querySelectorAll('select[name]')).map(s => ({
            name: s.name,
            options_count: s.options.length,
            first_options: Array.from(s.options).slice(0, 3).map(o => ({v: o.value, t: o.textContent.trim()}))
        }));
    }""")
    set_results["available_selects"] = select_names

    # Try setting a date field
    date_result = frame.evaluate("""(val) => {
        const selectors = [
            'input[name="start_date"]',
            'input[name="begin_date"]',
            '.validate[name="begin_date[]"]',
            'input[name="begin_date[]"]'
        ];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el) {
                el.value = val;
                el.dispatchEvent(new Event('change', {bubbles: true}));
                return {found: true, selector: sel, value: el.value};
            }
        }
        return {found: false, tried: selectors};
    }""", "2026-04-01")
    set_results["date_field"] = date_result

    return {"form_code": form_code, "field_tests": set_results}


def main():
    if not USERNAME or not PASSWORD:
        print("[ERROR] IPK_USERNAME and IPK_PASSWORD must be set")
        sys.exit(1)

    print(f"[START] Verifying against {BASE_URL}")
    print(f"[START] User: {USERNAME}")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1920, "height": 1080})
        page = context.new_page()

        try:
            if not login(page):
                results["errors"].append("Login failed")
                print(json.dumps(results, indent=2, ensure_ascii=False))
                return

            # T1: Inspect 3 forms
            print("\n=== T1: Form DOM Inspection ===")
            for form_code, template_path in FORMS_TO_INSPECT.items():
                print(f"\n[T1] Inspecting {form_code}...")
                try:
                    dom = inspect_form_dom(page, form_code)
                    comparison = compare_with_template(dom, template_path)
                    results["T1_inspect"][form_code] = {
                        "dom_element_count": dom.get("element_count", 0),
                        "comparison": comparison,
                    }

                    # Save DOM snapshot
                    os.makedirs("test/fixtures", exist_ok=True)
                    with open(f"test/fixtures/dom_{form_code}.json", "w") as f:
                        json.dump(dom, f, indent=2, ensure_ascii=False)

                    if comparison.get("in_template_not_in_dom"):
                        print(f"  [WARN] Template fields NOT in DOM: {comparison['in_template_not_in_dom']}")
                    if comparison.get("type_mismatches"):
                        print(f"  [WARN] Type mismatches: {comparison['type_mismatches']}")
                    print(f"  [OK] Match rate: {comparison.get('match_rate', 'N/A')}")
                except Exception as e:
                    results["T1_inspect"][form_code] = {"error": str(e)}
                    results["errors"].append(f"T1/{form_code}: {e}")
                    print(f"  [ERROR] {e}")

            # T2: Document lookup
            print("\n=== T2: Document Lookup Parser ===")
            try:
                t2 = test_document_lookup(page)
                results["T2_document_lookup"] = t2
                if "error" in t2:
                    print(f"  [ERROR] {t2['error']}")
                    results["errors"].append(f"T2: {t2['error']}")
                else:
                    print(f"  [OK] Doc ID: {t2['doc_id']}, Fields extracted: {t2['fields_extracted']}")
                    print(f"  [OK] Fixture saved: {t2['fixture_saved']}")
                    print(f"  [OK] Parsed: {json.dumps(t2['parsed_fields'], ensure_ascii=False)[:300]}")
            except Exception as e:
                results["T2_document_lookup"] = {"error": str(e)}
                results["errors"].append(f"T2: {e}")
                print(f"  [ERROR] {e}")

            # T3: Field setting test
            print("\n=== T3: Field Setting Verification ===")
            try:
                t3 = test_field_setting(page, "AppFrm-073")
                results["T3_field_test"] = t3
                ft = t3.get("field_tests", {})
                for field, res in ft.items():
                    if isinstance(res, dict) and res.get("found"):
                        print(f"  [OK] {field}: selector={res['selector']}")
                    elif isinstance(res, dict) and not res.get("found", True):
                        print(f"  [WARN] {field}: NOT FOUND (tried {res.get('tried', 'N/A')})")
                    elif isinstance(res, list):
                        print(f"  [INFO] {field}: {len(res)} elements")
            except Exception as e:
                results["T3_field_test"] = {"error": str(e)}
                results["errors"].append(f"T3: {e}")
                print(f"  [ERROR] {e}")

        finally:
            context.close()
            browser.close()

    # Save full results
    with open("test/fixtures/verify_results.json", "w") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)

    print(f"\n=== SUMMARY ===")
    print(f"Errors: {len(results['errors'])}")
    if results["errors"]:
        for e in results["errors"]:
            print(f"  - {e}")
    print(f"Results saved to test/fixtures/verify_results.json")


if __name__ == "__main__":
    main()
