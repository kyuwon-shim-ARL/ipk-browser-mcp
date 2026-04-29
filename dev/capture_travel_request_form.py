#!/usr/bin/env python3
"""Capture AppFrm-023 (travel request) form HTML and screenshot."""

from ipk_gw import IPKGroupware, get_credential
import time
from pathlib import Path

FORM_CODE = "AppFrm-023"
OUTPUT_HTML = "screenshots/forms/travel_request.html"
OUTPUT_PNG = "screenshots/forms/travel_request.png"


def main():
    print(f"Capturing {FORM_CODE} (travel request) form...")

    gw = IPKGroupware(headless=True)

    try:
        username = get_credential("username", "Username")
        password = get_credential("password", "Password")
        gw.login(username, password)
        print("Login OK")

        url = f"{gw.BASE_URL}/Document/document_write.php?approve_type={FORM_CODE}"
        main_frame = gw.page.frame("main_menu")
        if not main_frame:
            print("ERROR: main_menu frame not found")
            return False

        main_frame.goto(url, timeout=30000)
        time.sleep(2)
        main_frame.wait_for_load_state("networkidle")
        time.sleep(1)

        # Save HTML
        html = main_frame.content()
        Path(OUTPUT_HTML).parent.mkdir(parents=True, exist_ok=True)
        Path(OUTPUT_HTML).write_text(html, encoding="utf-8")
        print(f"HTML saved: {OUTPUT_HTML} ({len(html):,} bytes)")

        # Save screenshot
        gw.page.screenshot(path=OUTPUT_PNG, full_page=True)
        print(f"Screenshot saved: {OUTPUT_PNG}")

        # Quick field analysis
        print("\n--- Field Analysis ---")
        fields = main_frame.evaluate("""() => {
            const result = { inputs: [], selects: [], textareas: [], hidden: [] };
            document.querySelectorAll('input').forEach(el => {
                const name = el.getAttribute('name') || '';
                const type = el.getAttribute('type') || 'text';
                const cls = el.getAttribute('class') || '';
                const title = el.getAttribute('title') || '';
                if (type === 'hidden') {
                    result.hidden.push({name, type, value: el.value});
                } else if (name) {
                    result.inputs.push({name, type, class: cls, title, readonly: el.readOnly});
                }
            });
            document.querySelectorAll('select').forEach(el => {
                const name = el.getAttribute('name') || '';
                const options = Array.from(el.options).map(o => ({value: o.value, text: o.text}));
                if (name) result.selects.push({name, options});
            });
            document.querySelectorAll('textarea').forEach(el => {
                const name = el.getAttribute('name') || '';
                const cls = el.getAttribute('class') || '';
                const title = el.getAttribute('title') || '';
                if (name) result.textareas.push({name, class: cls, title});
            });
            return result;
        }""")

        import json
        print(f"\nInputs ({len(fields['inputs'])}):")
        for f in fields['inputs']:
            print(f"  {f['name']:30s} type={f['type']:10s} class={f['class']:30s} title={f['title']}")

        print(f"\nSelects ({len(fields['selects'])}):")
        for f in fields['selects']:
            opts = [o['text'] for o in f['options'][:5]]
            print(f"  {f['name']:30s} options={opts}")

        print(f"\nTextareas ({len(fields['textareas'])}):")
        for f in fields['textareas']:
            print(f"  {f['name']:30s} class={f['class']:30s} title={f['title']}")

        print(f"\nHidden ({len(fields['hidden'])}):")
        for f in fields['hidden']:
            print(f"  {f['name']:30s} value={f['value'][:50] if f['value'] else ''}")

        # Save field analysis as JSON
        json_path = "screenshots/forms/travel_request_fields.json"
        with open(json_path, "w", encoding="utf-8") as fp:
            json.dump(fields, fp, ensure_ascii=False, indent=2)
        print(f"\nField analysis saved: {json_path}")

        return True

    except Exception as e:
        print(f"ERROR: {e}")
        import traceback
        traceback.print_exc()
        return False

    finally:
        gw.close()


if __name__ == "__main__":
    main()
