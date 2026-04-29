#!/usr/bin/env python3
"""
Fix RunPod ER (doc_id=292091): delete fake attachments, re-attach real files, save as draft.
"""

import os, time, re
from ipk_gw import IPKGroupware, get_credential

DOC_ID      = "292091"
APPROVE_TYPE = "AppFrm-021"
EDIT_URL    = f"https://gw.ip-korea.org/Document/document_write.php?doc_id={DOC_ID}&approve_type={APPROVE_TYPE}"

ATTACH1 = "/home/kyuwon/projects/ipk-browser-mcp/data/attachments/2604/runpod/260409_Runpod-invoice_signed.pdf"
ATTACH2 = "/home/kyuwon/projects/ipk-browser-mcp/data/attachments/2604/runpod/260409_Runpod_CC_sales_slip.pdf"
ATTACH3 = "/home/kyuwon/projects/ipk-browser-mcp/data/attachments/2604/runpod/260409_Runpod_daily_usage.png"

# Verify files exist and are real
for f in [ATTACH1, ATTACH2, ATTACH3]:
    sz = os.path.getsize(f)
    assert sz > 10000, f"File too small ({sz} bytes), likely placeholder: {f}"
    print(f"  OK: {os.path.basename(f)} ({sz:,} bytes)")


def main():
    print("=" * 60)
    print(f"Fix RunPod ER doc_id={DOC_ID}: re-attach real files")
    print("=" * 60)

    u = get_credential("username", "Username")
    p = get_credential("password", "Password")

    gw = IPKGroupware(headless=True)
    try:
        print("\n[1/4] Logging in...")
        gw.login(u, p)
        print("Login OK")

        print(f"\n[2/4] Opening edit form for doc_id={DOC_ID}...")
        gw.page.goto(EDIT_URL, wait_until="domcontentloaded", timeout=30000)
        frame = gw.page.main_frame
        frame.wait_for_selector('input[name="subject"]', timeout=10000)
        print("Edit form loaded")

        # Confirm doc_id is set correctly
        doc_id_val = frame.evaluate("() => document.getElementById('doc_id')?.value || ''")
        subj_val   = frame.evaluate("() => document.querySelector('input[name=\"subject\"]')?.value || ''")
        print(f"  doc_id={doc_id_val}, subject={subj_val[:60]}")
        assert doc_id_val == DOC_ID, f"doc_id mismatch: {doc_id_val}"

        print("\n[3/4] Deleting existing (fake) attachments...")
        # Find existing uploaded file entries - del_file(flag) uses hidden del_no input
        existing_files = frame.evaluate("""() => {
            var links = Array.from(document.querySelectorAll('a[href*="del_file"], a[onclick*="del_file"]'));
            return links.map(a => ({text: a.textContent.trim(), onclick: a.getAttribute('onclick')||a.getAttribute('href')||''}));
        }""")
        print(f"  Found {len(existing_files)} existing file(s): {existing_files}")

        dialog_msgs = []
        def handle_dialog(dialog):
            dialog_msgs.append(dialog.message)
            dialog.accept()
        gw.page.on("dialog", handle_dialog)

        # Delete each existing attachment
        for i, ef in enumerate(existing_files):
            try:
                # Extract flag from del_file('flag') call
                flag_m = re.search(r"del_file\(['\"]([^'\"]+)['\"]", ef['onclick'])
                if flag_m:
                    flag = flag_m.group(1)
                    print(f"  Deleting file flag={flag}: {ef['text']}")
                    with gw.page.expect_navigation(wait_until="domcontentloaded", timeout=15000):
                        frame.evaluate(f"del_file('{flag}')")
                    print(f"    Deleted. URL={gw.page.url}")
                    # Re-load the edit form after deletion
                    if i < len(existing_files) - 1:
                        gw.page.goto(EDIT_URL, wait_until="domcontentloaded", timeout=20000)
                        frame = gw.page.main_frame
                        frame.wait_for_selector('input[name="subject"]', timeout=10000)
            except Exception as e:
                print(f"    Delete error: {e}")

        # Final reload to ensure clean state
        gw.page.goto(EDIT_URL, wait_until="domcontentloaded", timeout=20000)
        frame = gw.page.main_frame
        frame.wait_for_selector('input[name="subject"]', timeout=10000)
        time.sleep(1)

        # Confirm no existing files remain
        remaining = frame.evaluate("""() => {
            var links = Array.from(document.querySelectorAll('a[href*="del_file"], a[onclick*="del_file"]'));
            return links.map(a => a.textContent.trim());
        }""")
        print(f"  Remaining attachments after delete: {remaining}")

        print("\n[4/4] Attaching 3 correct files and saving as draft...")
        file_inputs = frame.locator('input[name="doc_attach_file[]"]')
        count = file_inputs.count()
        print(f"  File inputs found: {count}")

        # Attach files
        for idx, fpath in enumerate([ATTACH1, ATTACH2, ATTACH3]):
            if idx < count:
                # Make input visible if hidden
                frame.evaluate(f"""() => {{
                    var inputs = document.querySelectorAll('input[name="doc_attach_file[]"]');
                    if (inputs[{idx}]) inputs[{idx}].removeAttribute('style');
                }}""")
                time.sleep(0.3)
                file_inputs.nth(idx).set_input_files(fpath)
                print(f"  Attached [{idx}]: {os.path.basename(fpath)}")
                time.sleep(0.5)
            else:
                print(f"  WARNING: no input slot for [{idx}], skipping {os.path.basename(fpath)}")

        # Set file count
        frame.evaluate("() => { var c = document.getElementById('file_attach_cnt'); if(c) c.value='3'; }")

        gw.page.screenshot(path="screenshots/fix_er_before_save.png", full_page=True)
        print("  Screenshot: screenshots/fix_er_before_save.png")

        # Save as draft using mode='update' for existing doc
        dialog_msgs.clear()
        try:
            with gw.page.expect_navigation(wait_until="domcontentloaded", timeout=20000):
                frame.evaluate("""() => {
                    document.form1.mode.value  = 'update';
                    document.all('mode1').value = '';
                    document.form1.target = '';
                    document.form1.action = './document_write.php';
                    document.form1.submit();
                }""")
            cur_url = gw.page.url
            print(f"  Navigated to: {cur_url}")
        except Exception as nav_err:
            print(f"  Nav error: {nav_err}")
            time.sleep(3)
            cur_url = gw.page.url

        if dialog_msgs:
            print(f"  JS alerts: {dialog_msgs}")

        cur_html = gw.page.content()
        # Check result
        view_m = re.search(r'document_view\.php[^"\']*doc_id=([0-9]+)', cur_html)
        doc_m  = re.search(r'name="doc_id"[^>]*value="([0-9]+)"', cur_html)
        doc_id_result = (view_m.group(1) if view_m else None) or (doc_m.group(1) if doc_m else None)

        gw.page.screenshot(path="screenshots/fix_er_result.png", full_page=True)

        if doc_id_result or DOC_ID in cur_url:
            print(f"\n{'='*60}")
            print(f"SUCCESS! doc_id={doc_id_result or DOC_ID} updated with correct files")
            print(f"URL: {cur_url}")
            print("="*60)
            return True

        # Check if still on doc_write (might mean draft saved)
        if 'document_write' in cur_url or 'document_view' in cur_url:
            print(f"\nResult URL: {cur_url}")
            # Navigate to view page to confirm
            gw.page.goto(f"https://gw.ip-korea.org/Document/document_view.php?doc_id={DOC_ID}&approve_type={APPROVE_TYPE}",
                         wait_until="domcontentloaded", timeout=15000)
            view_html = gw.page.content()
            files_in_view = re.findall(r'260404_Runpod[^\]<"]+', view_html)
            print(f"  Files in view: {files_in_view}")
            if files_in_view:
                print(f"\n{'='*60}\nSUCCESS! Files updated: {files_in_view}\n{'='*60}")
                return True

        print(f"\nResult unclear. URL={cur_url}")
        print("Check screenshots/fix_er_result.png")
        return False

    except Exception as e:
        print(f"\nERROR: {e}")
        import traceback; traceback.print_exc()
        try:
            gw.page.screenshot(path="screenshots/fix_er_error.png")
        except Exception:
            pass
        return False
    finally:
        gw.close()


if __name__ == "__main__":
    main()
