#!/usr/bin/env python3
"""
Analyze AppFrm-043 (Seminar/Event Public Disclosure) documents from pre-scraped patterns JSON.

Input:  analysis_results/seminar_event_patterns.json
Output: analysis_results/seminar_event_structured_analysis.json
        analysis_results/seminar_event_profiles.json
"""

import json
import re
from collections import Counter
from pathlib import Path

FORM_CODE = "AppFrm-043"
INPUT_PATH = Path("analysis_results/seminar_event_patterns.json")
OUTPUT_DIR = Path("analysis_results")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# Radio question labels (Q1-Q5 on public disclosure checklist)
CHECKLIST_QUESTIONS = {
    'Q1': 'patent_filed',
    'Q2': 'patent_planned_within_year',
    'Q3': 'material_published',
    'Q4': 'collaborator_approval_obtained',
    'Q5': 'contains_ipk_confidential_info',
}


def _find_label(cells: list, label: str, start: int = 0) -> int:
    """Find index of a label cell (exact or startswith match)."""
    for i in range(start, len(cells)):
        if cells[i].strip() == label:
            return i
    return -1


def _find_label_startswith(cells: list, prefix: str, start: int = 0) -> int:
    """Find index of first cell starting with prefix."""
    for i in range(start, len(cells)):
        if cells[i].strip().startswith(prefix):
            return i
    return -1


def _next_value(cells: list, label_idx: int) -> str:
    """Get the value cell immediately after a label."""
    if label_idx >= 0 and label_idx + 1 < len(cells):
        return cells[label_idx + 1].strip()
    return ""


def extract_structured_fields(text_cells: list, doc_fields: dict, doc_meta: dict) -> dict:
    """Extract structured fields from text_cells and form fields.

    AppFrm-043 (Seminar/Event Public Disclosure) layout:
      Subject
      Requester
      1. Purpose of public disclosure
      2. Date of disclosure
      3. Final version of material to be disclosed
      4. Conference/Seminar Program/Journal wish to submit
      5. Public disclosure checklist (radio Q1-Q5)
      6. Predatory Journals/Conferences Prevention (static text)
    """
    cells = text_cells
    result = {}

    # --- Drafter info ---
    for c in cells:
        c_s = c.strip()
        if any(role in c_s for role in [
            '- Team Member -', '- Team Head', '- Researcher -',
            '- Post-Doc -', '- Senior Researcher -'
        ]):
            result['drafter_info'] = c_s
            break

    # --- Simple label -> next cell ---
    label_map = {
        'Subject': 'subject',
        'Requester': 'requester',
    }
    for label, field_name in label_map.items():
        idx = _find_label(cells, label)
        val = _next_value(cells, idx)
        if val:
            result[field_name] = val

    # --- Section 1: Purpose of public disclosure ---
    idx = _find_label_startswith(cells, '1. Purpose')
    if idx >= 0:
        val = _next_value(cells, idx)
        if val and not val.startswith('2.'):
            result['disclosure_purpose'] = val

    # --- Section 2: Date of disclosure ---
    idx = _find_label_startswith(cells, '2. Date of disclosure')
    if idx >= 0:
        val = _next_value(cells, idx)
        if val and re.match(r'\d{4}-\d{2}-\d{2}', val):
            result['disclosure_date'] = val

    # --- Section 3: Final version of material ---
    idx = _find_label_startswith(cells, '3. Final version')
    if idx >= 0:
        val = _next_value(cells, idx)
        if val and not val.startswith('4.'):
            result['material_description'] = val
            # Extract filename(s) - pattern: "filename.ext (N byte)"
            filenames = re.findall(r'(\S+\.\w+)\s*\(\d+\s*byte\)', val)
            if filenames:
                result['material_files'] = filenames

    # --- Section 4: Conference/Seminar Program/Journal ---
    idx = _find_label_startswith(cells, '4. Conference')
    if idx >= 0:
        val = _next_value(cells, idx)
        if val and not val.startswith('5.'):
            result['conference_or_journal'] = val

    # --- Section 5: Checklist radio answers from fields dict ---
    for q_key, field_name in CHECKLIST_QUESTIONS.items():
        radio_key = f'radio:{q_key}'
        val = doc_fields.get(radio_key, '')
        if val:
            result[field_name] = val  # 'Y', 'N', or ''

    # --- Check: predatory conference acknowledgment ---
    chk_val = doc_fields.get('check:chk410306', '')
    result['predatory_check_confirmed'] = (chk_val == 'on')

    # --- Submit date ---
    idx = _find_label(cells, 'Date')
    val = _next_value(cells, idx)
    if val and re.match(r'\d{4}-\d{2}-\d{2}', val):
        result['submit_date'] = val

    # --- Writer from metadata ---
    result['writer'] = doc_meta.get('writer', '')
    result['doc_id'] = doc_meta.get('doc_id', '')
    result['doc_no'] = doc_meta.get('doc_no', '')
    result['date'] = doc_meta.get('date', '')

    return result


def generate_profiles(all_structured: list) -> dict:
    """Generate per-writer profiles for seminar/event disclosure."""
    by_writer = {}
    for doc in all_structured:
        writer = doc.get('writer', '')
        if not writer:
            continue
        by_writer.setdefault(writer, []).append(doc)

    profiles = {}
    for writer, docs in sorted(by_writer.items()):
        n = len(docs)
        profile = {
            'writer': writer,
            'n_documents': n,
            'low_confidence': n <= 3,
        }

        # Disclosure purposes
        purposes = [d.get('disclosure_purpose', '') for d in docs if d.get('disclosure_purpose')]
        if purposes:
            profile['sample_purposes'] = purposes[:3]

        # Q4 collaborator approval (most common pattern)
        q4_vals = Counter(d.get('collaborator_approval_obtained', '') for d in docs
                          if d.get('collaborator_approval_obtained'))
        if q4_vals:
            profile['q4_collaborator_approval'] = dict(q4_vals.most_common())

        # Predatory check
        confirmed = sum(1 for d in docs if d.get('predatory_check_confirmed'))
        profile['predatory_check_rate'] = round(confirmed / n, 2) if n > 0 else 0.0

        # Drafter info
        drafters = [d.get('drafter_info', '') for d in docs if d.get('drafter_info')]
        if drafters:
            profile['drafter_info'] = Counter(drafters).most_common(1)[0][0]

        profiles[writer] = profile

    return profiles


def main():
    print(f"=== AppFrm-043 Seminar/Event Pattern Analysis ===\n")

    with open(INPUT_PATH, encoding='utf-8') as f:
        raw = json.load(f)

    documents = raw.get('documents', [])
    print(f"Loaded {len(documents)} documents from {INPUT_PATH}")

    all_structured = []
    field_coverage = Counter()

    for doc in documents:
        text_cells = doc.get('text_cells', [])
        doc_fields = doc.get('fields', {})
        structured = extract_structured_fields(text_cells, doc_fields, doc)
        all_structured.append(structured)

        for k, v in structured.items():
            if v not in ('', None, False, []) and not k.startswith('_'):
                field_coverage[k] += 1

    total = len(all_structured)
    print(f"\nField coverage across {total} documents:")
    for field, count in sorted(field_coverage.items(), key=lambda x: -x[1]):
        pct = round(count / total * 100)
        print(f"  {field:<40} {count}/{total} ({pct}%)")

    # Save structured analysis
    struct_path = OUTPUT_DIR / "seminar_event_structured_analysis.json"
    with open(struct_path, 'w', encoding='utf-8') as f:
        json.dump({
            'form_code': FORM_CODE,
            'total_documents': total,
            'field_coverage': {k: {'count': v, 'rate': round(v / total, 2)}
                               for k, v in field_coverage.items()},
            'structured_data': all_structured,
        }, f, ensure_ascii=False, indent=2)
    print(f"\nStructured analysis saved: {struct_path}")

    # Generate profiles
    profiles = generate_profiles(all_structured)
    profile_path = OUTPUT_DIR / "seminar_event_profiles.json"
    with open(profile_path, 'w', encoding='utf-8') as f:
        json.dump(profiles, f, ensure_ascii=False, indent=2)
    print(f"Profiles saved: {profile_path}")
    print(f"  {len(profiles)} writers profiled")

    # Checklist summary
    print(f"\nPublic disclosure checklist answer distributions:")
    for q_key, field_name in CHECKLIST_QUESTIONS.items():
        vals = Counter(d.get(field_name, '') for d in all_structured)
        print(f"  {q_key} ({field_name}): {dict(vals.most_common())}")

    predatory_confirmed = sum(1 for d in all_structured if d.get('predatory_check_confirmed'))
    print(f"\nPredatory conference check confirmed: {predatory_confirmed}/{total}")

    print("\nDone!")


if __name__ == "__main__":
    main()
