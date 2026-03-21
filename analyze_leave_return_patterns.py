#!/usr/bin/env python3
"""
Analyze AppFrm-028 (Leave Return) documents from pre-scraped patterns JSON.

Input:  analysis_results/leave_return_patterns.json
Output: analysis_results/leave_return_structured_analysis.json
        analysis_results/leave_return_profiles.json
"""

import json
import re
from collections import Counter
from pathlib import Path

FORM_CODE = "AppFrm-028"
INPUT_PATH = Path("analysis_results/leave_return_patterns.json")
OUTPUT_DIR = Path("analysis_results")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


def _find_label(cells: list, label: str, start: int = 0) -> int:
    """Find index of a label cell (exact match, stripped)."""
    for i in range(start, len(cells)):
        if cells[i].strip() == label:
            return i
    return -1


def _next_value(cells: list, label_idx: int) -> str:
    """Get the value cell immediately after a label."""
    if label_idx >= 0 and label_idx + 1 < len(cells):
        return cells[label_idx + 1].strip()
    return ""


def extract_structured_fields(text_cells: list, doc_meta: dict) -> dict:
    """Extract structured fields from text_cells using label-based search.

    AppFrm-028 layout (Leave Return):
      Subject
      Document Number  (the original leave doc number being returned)
      Leave Type       (value after Document Number column)
      Period           (date range of the returned leave)
      Requested (Days/Hours)
      Return (Days/Hours)
      Description
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
        'Description': 'description',
    }
    for label, field_name in label_map.items():
        idx = _find_label(cells, label)
        val = _next_value(cells, idx)
        if val:
            result[field_name] = val

    # --- Document Number (the original leave doc) ---
    idx = _find_label(cells, 'Document Number')
    if idx >= 0:
        # Layout: [Document Number] [Leave Type] [Period] [Requested] [Return]
        # then actual values follow
        # Find the next non-header cell that looks like a doc number (ARL-XXXXXX-XX)
        for i in range(idx + 1, min(idx + 10, len(cells))):
            c = cells[i].strip()
            if re.match(r'^[A-Z]+-\d{6}-\d{2}$', c):
                result['original_leave_doc'] = c
                # Leave type is the next cell
                if i + 1 < len(cells):
                    result['leave_type'] = cells[i + 1].strip()
                # Period is the next cell after that
                if i + 2 < len(cells):
                    period_val = cells[i + 2].strip()
                    m = re.match(r'(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})', period_val)
                    if m:
                        result['period_start'] = m.group(1)
                        result['period_end'] = m.group(2)
                    else:
                        result['period'] = period_val
                # Requested (days/hours)
                if i + 3 < len(cells):
                    req_val = cells[i + 3].strip()
                    if '/' in req_val:
                        result['requested_days_hours'] = req_val
                # Return (days/hours)
                if i + 4 < len(cells):
                    ret_val = cells[i + 4].strip()
                    if '/' in ret_val:
                        result['return_days_hours'] = ret_val
                break

    # --- Parse return amount from days/hours ---
    ret_str = result.get('return_days_hours', '')
    if ret_str:
        m = re.match(r'(\d+)\s*/\s*(\d+)', ret_str)
        if m:
            result['return_days'] = int(m.group(1))
            result['return_hours'] = int(m.group(2))

    # --- Parse requested amount ---
    req_str = result.get('requested_days_hours', '')
    if req_str:
        m = re.match(r'(\d+)\s*/\s*(\d+)', req_str)
        if m:
            result['requested_days'] = int(m.group(1))
            result['requested_hours'] = int(m.group(2))

    # --- Drafter date from subject line area ---
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
    """Generate per-writer profiles for leave return patterns."""
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

        # Leave types returned
        leave_types = Counter(d.get('leave_type', '') for d in docs if d.get('leave_type'))
        if leave_types:
            profile['leave_type_distribution'] = dict(leave_types.most_common())

        # Return sizes (days)
        return_days = [d.get('return_days') for d in docs if d.get('return_days') is not None]
        return_hours = [d.get('return_hours') for d in docs if d.get('return_hours') is not None]
        if return_days:
            profile['return_days_distribution'] = dict(Counter(return_days).most_common())
        if return_hours:
            profile['return_hours_distribution'] = dict(Counter(return_hours).most_common())

        # Drafter info
        drafters = [d.get('drafter_info', '') for d in docs if d.get('drafter_info')]
        if drafters:
            profile['drafter_info'] = Counter(drafters).most_common(1)[0][0]

        profiles[writer] = profile

    return profiles


def main():
    print(f"=== AppFrm-028 Leave Return Pattern Analysis ===\n")

    # Load pre-scraped data
    with open(INPUT_PATH, encoding='utf-8') as f:
        raw = json.load(f)

    documents = raw.get('documents', [])
    print(f"Loaded {len(documents)} documents from {INPUT_PATH}")

    # Extract structured fields from each document
    all_structured = []
    field_coverage = Counter()

    for doc in documents:
        text_cells = doc.get('text_cells', [])
        structured = extract_structured_fields(text_cells, doc)
        all_structured.append(structured)

        for k, v in structured.items():
            if v not in ('', None) and not k.startswith('_'):
                field_coverage[k] += 1

    total = len(all_structured)
    print(f"\nField coverage across {total} documents:")
    for field, count in sorted(field_coverage.items(), key=lambda x: -x[1]):
        pct = round(count / total * 100)
        print(f"  {field:<30} {count}/{total} ({pct}%)")

    # Save structured analysis
    struct_path = OUTPUT_DIR / "leave_return_structured_analysis.json"
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
    profile_path = OUTPUT_DIR / "leave_return_profiles.json"
    with open(profile_path, 'w', encoding='utf-8') as f:
        json.dump(profiles, f, ensure_ascii=False, indent=2)
    print(f"Profiles saved: {profile_path}")
    print(f"  {len(profiles)} writers profiled")

    # Summary stats
    leave_types = Counter(d.get('leave_type', '') for d in all_structured if d.get('leave_type'))
    print(f"\nLeave type distribution across all leave returns:")
    for lt, cnt in leave_types.most_common():
        print(f"  {lt}: {cnt}")

    return_days_all = [d.get('return_days') for d in all_structured if d.get('return_days') is not None]
    return_hours_all = [d.get('return_hours') for d in all_structured if d.get('return_hours') is not None]
    if return_days_all:
        day_returns = sum(1 for d in return_days_all if d > 0)
        hour_returns = sum(1 for h in return_hours_all if h > 0)
        print(f"\nReturn type breakdown:")
        print(f"  Full-day returns (days > 0): {day_returns}")
        print(f"  Partial-hour returns (hours > 0): {hour_returns}")

    print("\nDone!")


if __name__ == "__main__":
    main()
