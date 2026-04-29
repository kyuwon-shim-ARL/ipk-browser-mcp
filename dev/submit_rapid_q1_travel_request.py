#!/usr/bin/env python3
"""
RAPID 2026 Q1 Sampling - Travel Request Draft Submission (AppFrm-023)
Based on:
  - Approved email from Soojin Jang (2026-03-18)
  - Previous Q3 travel request (doc_id=285752) as reference

Form: AppFrm-023 (Domestic travel Request)

Run: python submit_rapid_q1_travel_request.py
"""

from ipk_gw import IPKGroupware, get_credential
from pathlib import Path
import time
from form_utils import escape_js, set_field, set_select, set_radio, select_option_containing

# === Travel Request Details ===
# Reference: Q3 doc_id=285752 "[Request] GloPID-R Q3 Sample Collection for Microbial Surveillance"
# Changes for Q1: project code (GARDP FFS), date (2026-03-26), destinations (+Soongsil Univ)

SUBJECT = "[Request] GARDP FFS Q1 Sample Collection for Microbial Surveillance"
START_DATE = "2026-03-26"
END_DATE = "2026-03-26"
START_TIME = "08:00"
END_TIME = "16:00"
NIGHTS = "0"
DAYS = "1"

# City & Transportation (same as Q3: Seoul, Other Public Transportation)
BOUND_CODE = "20"           # Out of Metropolitan (관외)
PROVINCE_CODE = "02"        # Seoul (서울특별시) - same as Q3
# city_code: Seoul (서울) - dynamically loaded after province
# travel_type_code: Other Public Transportation - dynamically loaded

# Purpose (same type as Q3, updated text for Q1)
PURPOSE_TYPE = "5"          # Simple visit to vendor & etc
PURPOSE_TEXT = (
    "The objective of this project is to collect samples from indoor surfaces "
    "and toilets in public transportation systems and communal places. "
    "These samples will be analyzed to characterize microbial communities "
    "and assess the prevalence of antimicrobial resistance (AMR)."
)

# Itinerary (similar to Q3 but with updated destinations)
ITINERARY_DEST = "Bundang Seoul Nat'l Univ. Hospital, Gangnam station, Seoul station, Pangyo Hyundai Dept Store, Soongsil University"
ITINERARY_TRANS = "Other Public Transportation"

# Budget (changed from Q3: NN2509-0001 -> FS2214-0001)
BUDGET_TYPE = "02"          # R&D
BUDGET_CODE = "FS2214-0001" # 2022 GARDP FFS_Soojin Jang (ARL)

# Other settings (same as Q3)
FIN_SUPPORT = "N"           # No financial support from organizer
MATRIALS = "N"              # No presentation materials
FOOD_YN = "N"               # No meals served
CORP_CARD = ("5525", "7642", "1492", "9594")  # Institut credit card (from Q3)

FORM_CODE = "AppFrm-023"

# Attachment: generate PDF from email approval
ATTACHMENT_FILENAME = "[RAPID]_2026_Q1_sampling_request_approval_of_travel.pdf"

# Email approval content for PDF generation
EMAIL_APPROVAL = {
    "from": "Guinam Wee <guinam.wee@ip-korea.org>",
    "to": "Soojin Jang <soojin.jang@ip-korea.org>",
    "cc": "Kyuwon Shim <kyuwon.shim@ip-korea.org>, Sunju Kim <sunju.kim@ip-korea.org>",
    "date_request": "Wed, 18 Mar 2026 08:57",
    "date_approval": "Wed, 18 Mar 2026 09:13",
    "subject": "[RAPID] 2026 Q1 sampling schedule and travel request",
    "body_request": (
        "Dear Dr. Jang,\n\n"
        "This is Guinam Wee from ARL.\n\n"
        "We would like to proceed with sample collection for analysis of "
        "urban microbial communities and antimicrobial resistance in 2026.\n\n"
        "Date: 2026-03-26 (Thursday) 08:00 ~ 16:00 (8hrs)\n"
        "Locations: Bundang Seoul National Univ. Hospital & Gangnam Station & "
        "Seoul Station & Pangyo Hyundai Dept Store & Soongsil University\n"
        "Participants: Guinam Wee, Kyuwon Shim, Sunju Kim\n"
        "Project: [FS2214-0001] 2022 GARDP FFS_Soojin Jang (ARL)\n\n"
        "Please confirm so we can submit the travel request and proceed.\n\n"
        "Best regards,\nGuinam Wee"
    ),
    "body_approval": (
        "Dear Dr. Wee,\n\n"
        "I have confirmed the sample collection travel details.\n"
        "Please proceed as planned.\n\n"
        "Best regards,\nSoojin Jang"
    ),
}


def generate_approval_pdf(output_path: str) -> str:
    """Generate a PDF from the email approval chain."""
    try:
        from reportlab.lib.pagesizes import A4
        from reportlab.lib.units import cm
        from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, HRFlowable
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.lib.colors import HexColor

        doc = SimpleDocTemplate(output_path, pagesize=A4,
                                leftMargin=2*cm, rightMargin=2*cm,
                                topMargin=2*cm, bottomMargin=2*cm)
        styles = getSampleStyleSheet()
        title_style = ParagraphStyle('Title2', parent=styles['Title'], fontSize=14)
        meta_style = ParagraphStyle('Meta', parent=styles['Normal'], fontSize=9,
                                    textColor=HexColor('#555555'))
        body_style = ParagraphStyle('Body', parent=styles['Normal'], fontSize=10,
                                    leading=14)
        approval_style = ParagraphStyle('Approval', parent=styles['Normal'],
                                        fontSize=10, leading=14,
                                        backColor=HexColor('#f0f8f0'))

        e = EMAIL_APPROVAL
        story = []
        story.append(Paragraph("Travel Request Approval", title_style))
        story.append(Spacer(1, 0.5*cm))

        # Request email
        story.append(Paragraph(f"<b>From:</b> {e['from']}", meta_style))
        story.append(Paragraph(f"<b>To:</b> {e['to']}", meta_style))
        story.append(Paragraph(f"<b>Cc:</b> {e['cc']}", meta_style))
        story.append(Paragraph(f"<b>Date:</b> {e['date_request']}", meta_style))
        story.append(Paragraph(f"<b>Subject:</b> {e['subject']}", meta_style))
        story.append(Spacer(1, 0.3*cm))
        for line in e['body_request'].split('\n'):
            story.append(Paragraph(line or "&nbsp;", body_style))
        story.append(Spacer(1, 0.5*cm))
        story.append(HRFlowable(width="100%", thickness=1, color=HexColor('#cccccc')))
        story.append(Spacer(1, 0.5*cm))

        # Approval reply
        story.append(Paragraph("<b>--- Approval Reply ---</b>", meta_style))
        story.append(Paragraph(f"<b>From:</b> Soojin Jang &lt;soojin.jang@ip-korea.org&gt;", meta_style))
        story.append(Paragraph(f"<b>Date:</b> {e['date_approval']}", meta_style))
        story.append(Spacer(1, 0.3*cm))
        for line in e['body_approval'].split('\n'):
            story.append(Paragraph(line or "&nbsp;", approval_style))

        doc.build(story)
        return output_path
    except ImportError:
        # Fallback: create a simple text-based PDF using basic file
        print("  WARNING: reportlab not installed. Creating plain text file instead.")
        txt_path = output_path.replace('.pdf', '.txt')
        e = EMAIL_APPROVAL
        content = (
            f"Travel Request Approval\n{'='*50}\n\n"
            f"From: {e['from']}\nTo: {e['to']}\nCc: {e['cc']}\n"
            f"Date: {e['date_request']}\nSubject: {e['subject']}\n\n"
            f"{e['body_request']}\n\n{'='*50}\n\n"
            f"--- Approval Reply ---\n"
            f"From: Soojin Jang <soojin.jang@ip-korea.org>\n"
            f"Date: {e['date_approval']}\n\n"
            f"{e['body_approval']}\n"
        )
        Path(txt_path).write_text(content)
        return txt_path


def main():
    print("=" * 60)
    print("RAPID 2026 Q1 - Travel Request Draft (AppFrm-023)")
    print("Reference: Q3 doc_id=285752")
    print("=" * 60)

    gw = IPKGroupware(headless=True)

    try:
        # === Step 1: Login ===
        print("\n[1/5] Logging in...")
        username = get_credential("username", "Username")
        password = get_credential("password", "Password")
        gw.login(username, password)
        print("Login successful!")

        # === Step 2: Navigate to AppFrm-023 ===
        print("\n[2/5] Navigating to AppFrm-023...")
        url = f"{gw.BASE_URL}/Document/document_write.php?approve_type={FORM_CODE}"
        frame = gw.page.frame("main_menu")
        if not frame:
            print("ERROR: main_menu frame not found")
            return False

        frame.goto(url, timeout=30000)
        time.sleep(2)
        frame.wait_for_load_state("networkidle")
        time.sleep(1)
        print("Form loaded!")

        # === Step 3: Fill form fields (matching Q3 pattern) ===
        print("\n[3/5] Filling form fields (based on Q3 reference)...")

        # 3a. Subject
        print("  [subject] ...")
        set_field(frame, "subject", SUBJECT)

        # 3b. Financial support: No (same as Q3)
        print("  [fin_support_type] No ...")
        set_radio(frame, "fin_support_type", FIN_SUPPORT)

        # 3c. bound_code: Out of Metropolitan (same as Q3)
        print("  [bound_code] Out of Metropolitan (관외) ...")
        set_select(frame, "bound_code", BOUND_CODE, delay=1.5)

        # 3d. Province: Seoul (same as Q3)
        print("  [province_code] Seoul (서울특별시) ...")
        set_select(frame, "province_code", PROVINCE_CODE, delay=2.0)

        # 3e. City: Seoul (same as Q3 - dynamically loaded)
        print("  [city_code] Seoul ...")
        city_result = select_option_containing(frame, "city_code", "Seoul")
        print(f"    -> {city_result}")

        # 3f. Transportation: Other Public Transportation (same as Q3)
        print("  [travel_type_code] Other Public Transportation ...")
        transport_result = select_option_containing(frame, "travel_type_code", "Other Public")
        print(f"    -> {transport_result}")

        # 3g. Purpose type: Simple visit (same as Q3)
        print("  [purpose_type] Simple visit (5) ...")
        set_radio(frame, "purpose_type", PURPOSE_TYPE)

        # 3h. Purpose textarea (similar to Q3)
        print("  [purpose] ...")
        set_field(frame, "purpose", PURPOSE_TEXT)

        # 3i. Materials: No (same as Q3)
        print("  [matrials] No ...")
        set_radio(frame, "matrials", MATRIALS)

        # 3j. Institut credit card (same as Q3)
        print("  [copcard] ...")
        for i, part in enumerate(CORP_CARD, 1):
            set_field(frame, f"copcard{i}", part, delay=0.2)

        # 3k. Travel dates
        print("  [dates] 2026-03-26 ...")
        set_field(frame, "start_date", START_DATE, delay=0.5)
        set_field(frame, "end_date", END_DATE, delay=0.5)
        set_field(frame, "night", NIGHTS, delay=0.2)
        set_field(frame, "days", DAYS, delay=0.2)

        # 3l. Travel times (show time fields, same pattern as Q3: 08:00~16:00)
        print("  [times] 08:00 ~ 16:00 ...")
        frame.evaluate("""(() => {
            const tm = document.getElementById('travel_tm');
            if (tm) tm.style.display = '';
        })()""")
        time.sleep(0.5)
        set_select(frame, "start_tm", START_TIME, delay=0.3)
        set_select(frame, "end_tm", END_TIME, delay=0.3)

        # 3m. Itinerary: 1 row with all destinations (same pattern as Q3)
        # Q3 used: "Seoul station, Gangnam station, Department store, University etc."
        print("  [itinerary] 1 row ...")
        set_select(frame, "er_row_cnt", "1", delay=0.5)
        frame.evaluate(f"""(() => {{
            const dests = document.querySelectorAll('input.travel_dest');
            const trans = document.querySelectorAll('input.travel_trans');
            if (dests[0]) {{
                dests[0].value = '{escape_js(ITINERARY_DEST)}';
                dests[0].dispatchEvent(new Event('input', {{bubbles: true}}));
            }}
            if (trans[0]) {{
                trans[0].value = '{escape_js(ITINERARY_TRANS)}';
                trans[0].dispatchEvent(new Event('input', {{bubbles: true}}));
            }}
        }})()""")
        time.sleep(0.5)

        # 3n. Food: No meals served (same as Q3)
        print("  [food_yn] No ...")
        set_radio(frame, "food_yn", FOOD_YN)

        # 3o. Budget: R&D (same type, different code from Q3)
        print(f"  [budget] R&D / {BUDGET_CODE} ...")
        set_select(frame, "budget_type", BUDGET_TYPE, delay=2.0)

        # Budget code (AJAX loaded after budget_type)
        budget_result = select_option_containing(frame, "budget_code", BUDGET_CODE)
        print(f"    -> budget_code: {budget_result}")

        # Account code (item_no - AJAX loaded after budget_code)
        print("  [item_no] selecting first available ...")
        time.sleep(1.0)
        item_result = frame.evaluate("""(() => {
            const sel = document.querySelector('select[name="item_no"]');
            if (!sel) return {found: false};
            const opts = Array.from(sel.options).map(o => ({value: o.value, text: o.text}));
            // Try to find Domestic Business Travel (410201)
            for (const o of opts) {
                if (o.text.includes('410201') || o.text.includes('Domestic Business Travel')) {
                    sel.value = o.value;
                    sel.dispatchEvent(new Event('change', {bubbles: true}));
                    return {found: true, selected: o};
                }
            }
            // Fallback: first non-empty
            for (const o of opts) {
                if (o.value) {
                    sel.value = o.value;
                    sel.dispatchEvent(new Event('change', {bubbles: true}));
                    return {found: true, selected: o, fallback: true};
                }
            }
            return {found: false, options: opts};
        })()""")
        print(f"    -> item_no: {item_result}")
        time.sleep(1.0)

        # Project code
        print("  [project_code] ...")
        set_field(frame, "project_code", BUDGET_CODE)

        # 3r. Generate and attach travel approval PDF
        print("  [attachment] Generating approval PDF...")
        pdf_path = str(Path(__file__).parent / ATTACHMENT_FILENAME)
        actual_path = generate_approval_pdf(pdf_path)
        print(f"    -> Generated: {actual_path}")

        print("  [attachment] Uploading to form...")
        attach_result = frame.evaluate(f"""(() => {{
            const files = document.querySelectorAll('input.travel_file');
            if (files.length > 0) return {{found: true, name: files[0].name, count: files.length}};
            return {{found: false}};
        }})()""")
        print(f"    -> File input: {attach_result}")

        if attach_result.get("found"):
            file_input = frame.locator("input.travel_file").first
            file_input.set_input_files(actual_path)
            time.sleep(1.0)
            print("    -> File attached!")
        else:
            print("    -> WARNING: .travel_file input not found, trying doc_attach_file")
            file_input = frame.locator('input[name="doc_attach_file[]"]').first
            file_input.set_input_files(actual_path)
            time.sleep(1.0)

        # === Step 4: Screenshot ===
        print("\n[4/5] Taking screenshot...")
        gw.page.screenshot(path="screenshots/rapid_q1_travel_request_filled.png", full_page=True)
        print("Screenshot: screenshots/rapid_q1_travel_request_filled.png")

        # === Step 5: Save as draft ===
        print("\n[5/5] Saving as draft...")
        print(f"  Attachment: {ATTACHMENT_FILENAME} (auto-generated from email approval)")

        frame.evaluate("document.all('mode1').value = 'draft';")
        time.sleep(0.5)

        try:
            with gw.page.expect_navigation(timeout=20000, wait_until='load'):
                frame.evaluate("document.form1.submit();")
        except Exception:
            time.sleep(5)

        time.sleep(2)

        # Check result
        for check_url in [gw.page.url] + [f.url for f in gw.page.frames if f.url]:
            if 'doc_id=' in check_url:
                doc_id = check_url.split('doc_id=')[1].split('&')[0]
                gw.page.screenshot(path="screenshots/rapid_q1_travel_request_result.png")
                print("\n" + "=" * 60)
                print(f"SUCCESS! Draft saved (doc_id: {doc_id})")
                print(f"View: https://gw.ip-korea.org/Document/document_view.php?doc_id={doc_id}")
                print()
                print("NEXT STEPS:")
                print("  1. Open draft in groupware")
                print("  2. Verify all fields match Q3 pattern")
                print("  3. Submit for approval")
                print("=" * 60)
                return True

        gw.page.screenshot(path="screenshots/rapid_q1_travel_request_result.png")
        print(f"\nResult URL: {gw.page.url}")
        print("Check screenshots/rapid_q1_travel_request_result.png")
        return True

    except Exception as e:
        print(f"\nERROR: {e}")
        import traceback
        traceback.print_exc()
        gw.page.screenshot(path="screenshots/rapid_q1_travel_request_error.png")
        return False

    finally:
        gw.close()


if __name__ == "__main__":
    main()
