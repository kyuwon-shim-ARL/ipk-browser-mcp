"""Discover all available AppFrm codes from IPK groupware."""
from playwright.sync_api import sync_playwright
from pathlib import Path
import os
import json
import time

# ---------------------------------------------------------------------------
# Credential loading
# ---------------------------------------------------------------------------

def load_env_file() -> dict:
    """Parse ~/.config/ipk-browser-mcp/.env or project-local .env file."""
    candidates = [
        Path.home() / ".config" / "ipk-browser-mcp" / ".env",
        Path(__file__).parent / ".env",
    ]
    env = {}
    for path in candidates:
        if path.exists():
            with open(path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    if "=" in line:
                        key, _, val = line.partition("=")
                        env[key.strip()] = val.strip()
            print(f"Loaded credentials from {path}")
            break
    return env


def get_credentials() -> tuple[str, str]:
    """Return (username, password) from env vars or .env file."""
    username = os.environ.get("IPK_USERNAME")
    password = os.environ.get("IPK_PASSWORD")
    if not username or not password:
        env = load_env_file()
        username = username or env.get("IPK_USERNAME", "")
        password = password or env.get("IPK_PASSWORD", "")
    if not username or not password:
        raise RuntimeError(
            "Credentials not found. Set IPK_USERNAME/IPK_PASSWORD env vars "
            "or create ~/.config/ipk-browser-mcp/.env"
        )
    return username, password


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

BASE_URL = "https://gw.ip-korea.org"
RANGE_START = 1
RANGE_END = 150  # check AppFrm-001 through AppFrm-150
TIMEOUT_PER_FORM_MS = 5000  # 5 seconds per form
KNOWN_CODES = {
    21: "R&D 경비청구 (expense)",
    23: "출장신청 (travel request)",
    27: "휴일근무신청 (holiday work)",
    54: "출장정산 (travel settlement)",
    73: "휴가신청 (leave)",
    74: "휴일근무 variant",
    76: "출장보고서 (travel report)",
}

OUTPUT_FILE = Path(__file__).parent / "discover_forms_results.json"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def make_code(n: int) -> str:
    return f"AppFrm-{n:03d}"


def form_url(code: str) -> str:
    return f"{BASE_URL}/Document/document_write.php?approve_type={code}"


def is_valid_form(frame, code: str) -> tuple[bool, str, list]:
    """
    Return (is_valid, title, field_names) by inspecting the frame content.
    A form is considered valid if it has meaningful input fields and no
    obvious error/not-found indicators.
    """
    try:
        content = frame.content()
    except Exception:
        return False, "", []

    # Common error indicators
    error_signals = [
        "존재하지 않는",
        "없는 양식",
        "잘못된 양식",
        "Invalid",
        "Not Found",
        "승인양식이 없습니다",
        "해당 양식",
    ]
    for sig in error_signals:
        if sig in content:
            return False, "", []

    # Extract title from page title or h1/h2/h3
    title = ""
    try:
        title_el = frame.query_selector("title")
        if title_el:
            title = title_el.inner_text().strip()
        if not title:
            for tag in ["h1", "h2", "h3", ".title", ".form-title"]:
                el = frame.query_selector(tag)
                if el:
                    t = el.inner_text().strip()
                    if t:
                        title = t
                        break
    except Exception:
        pass

    # Collect visible input fields (excluding hidden/submit/button)
    fields = []
    seen = set()
    try:
        for inp in frame.query_selector_all("input"):
            name = inp.get_attribute("name") or ""
            itype = inp.get_attribute("type") or "text"
            if name and itype not in ("hidden", "submit", "button", "image") and name not in seen:
                seen.add(name)
                fields.append(name)
        for sel in frame.query_selector_all("select"):
            name = sel.get_attribute("name") or ""
            if name and name not in seen:
                seen.add(name)
                fields.append(f"select:{name}")
        for ta in frame.query_selector_all("textarea"):
            name = ta.get_attribute("name") or ""
            if name and name not in seen:
                seen.add(name)
                fields.append(f"textarea:{name}")
    except Exception:
        pass

    # Need at least some interactive fields to be a real form
    if len(fields) < 2:
        return False, title, fields

    return True, title, fields


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    username, password = get_credentials()

    results = {}
    errors = {}

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1920, "height": 1080})
        page = context.new_page()

        # Login
        print("Logging in...")
        page.goto(BASE_URL, timeout=30000)
        page.wait_for_load_state("networkidle")
        page.fill("input[name='Username']", username)
        page.fill("input[name='Password']", password)
        page.evaluate("Check_Form()")
        time.sleep(3)

        if "main.php" not in page.url:
            page.goto(f"{BASE_URL}/main.php", timeout=30000)
            time.sleep(2)

        print(f"Logged in. Scanning AppFrm-{RANGE_START:03d} to AppFrm-{RANGE_END:03d}...\n")

        for n in range(RANGE_START, RANGE_END + 1):
            code = make_code(n)
            url = form_url(code)
            known_desc = KNOWN_CODES.get(n, "")
            label = f"{code}" + (f" [{known_desc}]" if known_desc else "")

            try:
                main_frame = page.frame("main_menu")
                if not main_frame:
                    # fallback: navigate main page
                    page.goto(url, timeout=TIMEOUT_PER_FORM_MS)
                    time.sleep(1)
                    main_frame = page.frame("main_menu") or page.main_frame

                main_frame.goto(url, timeout=TIMEOUT_PER_FORM_MS)
                # Brief wait for content
                try:
                    main_frame.wait_for_load_state("networkidle", timeout=TIMEOUT_PER_FORM_MS)
                except Exception:
                    pass

                valid, title, fields = is_valid_form(main_frame, code)

                if valid:
                    results[code] = {
                        "code": code,
                        "number": n,
                        "title": title,
                        "fields": fields,
                        "known_description": known_desc,
                    }
                    tag = " *** KNOWN ***" if known_desc else " <-- NEW"
                    print(f"  FOUND {label}: title={title!r}, fields={len(fields)}{tag}")
                else:
                    print(f"  skip  {label}")

            except Exception as e:
                err_msg = str(e)[:80]
                errors[code] = err_msg
                print(f"  error {label}: {err_msg}")

        browser.close()

    # Save results
    output = {
        "discovered": results,
        "errors": errors,
        "summary": {
            "total_checked": RANGE_END - RANGE_START + 1,
            "valid_forms": len(results),
            "errors": len(errors),
        },
    }
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"\n{'='*60}")
    print(f"Discovery complete.")
    print(f"  Checked: AppFrm-{RANGE_START:03d} to AppFrm-{RANGE_END:03d} ({RANGE_END - RANGE_START + 1} codes)")
    print(f"  Valid forms found: {len(results)}")
    print(f"  Errors: {len(errors)}")
    print(f"\nAll discovered forms:")
    for code, info in sorted(results.items()):
        kd = f"  [{info['known_description']}]" if info["known_description"] else ""
        print(f"  {code}: {info['title']!r} | fields: {len(info['fields'])}{kd}")

    print(f"\nResults saved to: {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
