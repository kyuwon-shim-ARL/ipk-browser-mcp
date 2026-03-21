#!/usr/bin/env python3
"""
2026 KMB Winter Symposium Travel Report Draft Submission
Run this script to submit the travel report draft to IPK Groupware
"""

from ipk_gw import IPKGroupware, get_credential
import time

# Field contents
SUBJECT = "[Settlement] Participation of 2026 KMB Winter Symposium"
REPORT_DATE = "2026-01-17"
START_DAY = "2026-01-14"
END_DAY = "2026-01-16"
DESTINATION = "Mona Yongpyong Dragon Valley Hotel Grand Ballroom, Pyeongchang, Korea"

PURPOSE_FIELD = "Participation in 2026 KMB Winter Symposium for scientific exchange on integrative approaches for microbiology and biotechnology, focusing on AI applications in protein science, drug discovery, synthetic biology, and microbiome research"

DATE_FIELD = """Date | Organization | Person | Agenda
2026-01-14 | KMB Winter Symposium | Conference participants | Registration, Divisional meeting
2026-01-15 | KMB Winter Symposium | Martin Steinegger (SNU), Park Geun-Wan (KIST), Ko Jun-Su (Arontier), Kim Tae-Hyung (Bionexus), Son Hong-Seok (Korea Univ.), Kim Sang-Gyu (KAIST), Yoon Sung-Ho (Konkuk Univ.), Kim Ha-Sung (KRIBB), Lee Dae-Won (Chung-Ang Univ.), Kim Hyun-Uk (KAIST) | Session 1-5 attendance, Poster sessions, Networking
2026-01-16 | KMB Winter Symposium | Panel discussants | Wrap-up discussion: Unifying Microbiology and Biotechnology for the Future"""

ORG_FIELD = "Korean Society for Microbiology and Biotechnology (KMB), Mona Yongpyong Dragon Valley Hotel Grand Ballroom"

PERSON_FIELD = "Martin Steinegger (SNU), Park Geun-Wan (KIST), Ko Jun-Su (Arontier), Kim Tae-Hyung (Bionexus), Son Hong-Seok (Korea Univ.), Kim Sang-Gyu (KAIST), Yoon Sung-Ho (Konkuk Univ.), Kim Ha-Sung (KRIBB), Lee Dae-Won (Chung-Ang Univ.), Kim Hyun-Uk (KAIST)"

DISCUSS_FIELD = """Key scientific topics discussed:
1. AI-Driven Protein Structure Prediction: AlphaFold/ColabFold/Foldseek enabling 40-60x faster predictions, Dark Proteins discovery
2. AI Drug Discovery: Arontier Allomorphic AI for dynamic conformational changes, 6-step agent workflow
3. Metabolomics: NMR-based profiling, AI sommelier for taste standardization, precision nutrition
4. Synthetic Biology: Korea Biofoundry, GEM+ML hybrid, DeepMGR for dark gene function
5. Microbiome: Foundation models (BiomeGPT, GenomeOcean), AI4Microbiome project
6. Plant Metabolites: scRNA-seq, READRetro AI for retrosynthetic pathway prediction"""

AGENDA_FIELD = """Day 1 (Jan 14): Registration, Divisional meeting
Day 2 (Jan 15):
- Session 1: Computational Insights into Protein Science (Steinegger, Park)
- Session 2: AI-Driven Innovation in Biomedicine (Ko, Kim TH)
- Session 3: Data-Driven Science in Green Biotechnology (Son, Kim SG)
- Session 4: AI-Powered Synthetic Biology (Yoon, Kim HS)
- Session 5: Computational Approaches in Biotechnology (Lee, Kim HU)
- Poster Sessions I & II
Day 3 (Jan 16): Panel Discussion - Unifying Microbiology and Biotechnology for the Future"""

RESULT_FIELD = """Technical Insights Gained:
1. Protein AI Tools: ColabFold/Foldseek applicable to AMR enzyme structure analysis, model-guided optimization for antimicrobial peptides
2. AI Drug Discovery: Learned Arontier 6-step workflow (Generation-Reflection-Ranking-Evolution-Proximity-Meta-review), GraphRAG approaches
3. Systems Biology: GEM+ML hybrid, PINN for biological constraints, multi-scale modeling framework
4. Microbiome: Foundation model concepts for AMR gene distribution analysis, DNA-BERT, zero-shot learning potential
5. Infrastructure: K-BDS access, Biofoundry capabilities for high-throughput antimicrobial screening"""

OTHER_FIELD = "Poster sessions, networking with Korean researchers from SNU, KAIST, Korea Univ., KIST, KRIBB, informal discussions on collaboration opportunities for AI-driven AMR research"

CONCLUSION_FIELD = """Implications for Current Research:
1. Immediate: Implement ColabFold/Foldseek for resistance enzyme analysis, apply metabolomics for AMR-associated changes
2. Collaboration Opportunities: KIST (Park) for protein engineering, KAIST (Kim HU) for systems biology, Arontier for AI drug design

Recommendations:
- Short-term: Set up ColabFold infrastructure, pilot study on AMR protein targets
- Mid-term: Develop collaboration proposal, integrate multi-agent AI workflow
- Long-term: Build AMR gene classification foundation model, create multi-scale clinical prediction model

Key Takeaway: AI-biotechnology convergence has reached practical application phase; Korean infrastructure (Biofoundry, K-BDS) provides valuable collaborative resources"""


from form_utils import escape_js_double as escape_js_string


def main():
    print("=" * 60)
    print("2026 KMB Winter Symposium - Travel Report Draft Submission")
    print("=" * 60)

    # Initialize groupware (headless for server environment)
    gw = IPKGroupware(headless=True)

    try:
        # Login
        print("\n[1/4] Logging in...")
        username = get_credential("username", "Username")
        password = get_credential("password", "Password")
        gw.login(username, password)
        print("Login successful!")

        # Navigate to travel form
        print("\n[2/4] Navigating to travel form...")
        frame = gw._navigate_to_form("travel")

        if not frame:
            print("ERROR: Failed to load travel form")
            return False

        print("Form loaded!")

        # Fill all fields
        print("\n[3/4] Filling form fields...")

        user_name = gw.user_info.get('name', 'Kyuwon Shim')
        user_dept = gw.user_info.get('dept', 'Antibacterial Resistance Lab')

        js_code = f'''
            // Subject
            document.querySelector('input[name="subject"]').value = "{escape_js_string(SUBJECT)}";

            // Reporter info
            document.querySelector('.validate[name="report_date"]').value = "{REPORT_DATE}";
            document.querySelector('.validate[name="report_name"]').value = "{user_name}";
            document.querySelector('.validate[name="report_post"]').value = "Researcher";
            document.querySelector('.validate[name="report_group"]').value = "{user_dept}";
            document.querySelector('.validate[name="report_leader"]').value = "Soojin Jang";

            // Travel dates and destination
            document.querySelector('.validate[name="start_day"]').value = "{START_DAY}";
            document.querySelector('.validate[name="end_day"]').value = "{END_DAY}";
            document.querySelector('.validate[name="report_dest"]').value = "{escape_js_string(DESTINATION)}";

            // Content fields
            document.querySelector('.validate[name="purpose_field"]').value = "{escape_js_string(PURPOSE_FIELD)}";
            document.querySelector('.validate[name="date_field"]').value = "{escape_js_string(DATE_FIELD)}";
            document.querySelector('.validate[name="org_field"]').value = "{escape_js_string(ORG_FIELD)}";
            document.querySelector('.validate[name="person_field"]').value = "{escape_js_string(PERSON_FIELD)}";
            document.querySelector('.validate[name="discuss_field"]').value = "{escape_js_string(DISCUSS_FIELD)}";
            document.querySelector('.validate[name="agenda_field"]').value = "{escape_js_string(AGENDA_FIELD)}";
            document.querySelector('.validate[name="result_field"]').value = "{escape_js_string(RESULT_FIELD)}";
            document.querySelector('.validate[name="other_field"]').value = "{escape_js_string(OTHER_FIELD)}";
            document.querySelector('.validate[name="conclusion_field"]').value = "{escape_js_string(CONCLUSION_FIELD)}";
        '''

        frame.evaluate(js_code)
        time.sleep(2)

        # Screenshot
        gw.page.screenshot(path="screenshots/kmb2026_travel_filled.png")
        print("Form filled! Screenshot: screenshots/kmb2026_travel_filled.png")

        # Save as draft
        print("\n[4/4] Saving as draft...")
        frame.evaluate("document.all('mode1').value = 'draft';")

        try:
            with gw.page.expect_navigation(timeout=20000, wait_until='load'):
                frame.evaluate("document.form1.submit();")
        except:
            time.sleep(5)

        time.sleep(2)

        # Check result
        new_url = gw.page.url
        gw.page.screenshot(path="screenshots/kmb2026_travel_result.png")

        if 'doc_id=' in new_url:
            doc_id = new_url.split('doc_id=')[1].split('&')[0]
            print("\n" + "=" * 60)
            print(f"SUCCESS! Draft saved with doc_id: {doc_id}")
            print(f"View at: https://gw.ip-korea.org/Document/document_view.php?doc_id={doc_id}")
            print("=" * 60)
            return True
        else:
            print(f"\nResult URL: {new_url}")
            print("Check screenshots/kmb2026_travel_result.png for result")
            return True

    except Exception as e:
        print(f"\nERROR: {e}")
        gw.page.screenshot(path="screenshots/kmb2026_travel_error.png")
        return False

    finally:
        gw.close()


if __name__ == "__main__":
    main()
