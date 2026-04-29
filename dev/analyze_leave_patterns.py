#!/usr/bin/env python3
"""
Structured extraction and analysis for AppFrm-073 (Leave Request) documents.

Input: analysis_results/leave_patterns.json (from scrape_form_docs.py)
Output:
  analysis_results/leave_structured_analysis.json
  analysis_results/leave_profiles.json (per-person leave patterns)
"""

import json
import re
from pathlib import Path
from collections import Counter, defaultdict

INPUT_FILE = Path("analysis_results/leave_patterns.json")
OUTPUT_DIR = Path("analysis_results")


def _find_label(cells: list[str], label: str, start: int = 0) -> int:
    for i in range(start, len(cells)):
        if cells[i].strip() == label:
            return i
    return -1


def _next_value(cells: list[str], label_idx: int) -> str:
    if label_idx >= 0 and label_idx + 1 < len(cells):
        return cells[label_idx + 1].strip()
    return ""


def extract_structured_fields(text_cells: list[str]) -> dict:
    """Extract structured fields from leave form text_cells using label-based search."""
    cells = text_cells
    result = {}

    # Drafter
    idx = _find_label(cells, "Drafter")
    if idx >= 0:
        result["drafter_info"] = _next_value(cells, idx)

    # Date
    idx = _find_label(cells, "Date")
    if idx >= 0:
        result["draft_date"] = _next_value(cells, idx)

    # Subject
    idx = _find_label(cells, "Subject")
    if idx >= 0:
        result["subject"] = _next_value(cells, idx)

    # Kind (leave type)
    idx = _find_label(cells, "Kind")
    if idx >= 0:
        # Kind label is followed by Period, Using headers, then the actual values
        # The leave type value is at a fixed offset after Kind
        # Look for the value after the "Hours" cells that follow "Using"
        # Pattern: Kind, Period, Using, Days, Hours, <leave_type>, <period>, <days>, <hours>
        kind_idx = idx
        # Search forward for the actual leave type value (not a header)
        for j in range(kind_idx + 1, min(kind_idx + 10, len(cells))):
            val = cells[j].strip()
            if val in ("Period", "Using", "Days", "Hours"):
                continue
            if val and val not in ("Kind",):
                result["leave_type"] = val
                break

    # Period
    idx = _find_label(cells, "Period")
    if idx >= 0:
        # Find the period value (date range) after headers
        period_idx = idx
        for j in range(period_idx + 1, min(period_idx + 10, len(cells))):
            val = cells[j].strip()
            if re.match(r"\d{4}-\d{2}-\d{2}", val):
                result["period"] = val
                break

    # Using (days + hours)
    # After period value, next cells are days and hours used
    if "period" in result:
        period_cell_idx = None
        for j in range(len(cells)):
            if cells[j].strip() == result["period"]:
                period_cell_idx = j
                break
        if period_cell_idx and period_cell_idx + 2 < len(cells):
            try:
                result["using_days"] = int(cells[period_cell_idx + 1].strip())
            except (ValueError, IndexError):
                pass
            try:
                result["using_hours"] = int(cells[period_cell_idx + 2].strip())
            except (ValueError, IndexError):
                pass

    # Parse period into start_date and end_date
    if "period" in result:
        m = re.match(r"(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})", result["period"])
        if m:
            result["start_date"] = m.group(1)
            result["end_date"] = m.group(2)
        # Check for hours
        hours_match = re.search(r"Hours\s*\(\s*(\d+)\s*~\s*(\d+)\s*\)", result["period"])
        if hours_match:
            result["start_hour"] = int(hours_match.group(1))
            result["end_hour"] = int(hours_match.group(2))

    # Purpose for leave
    idx = _find_label(cells, "Purpose for leave")
    if idx >= 0:
        result["purpose"] = _next_value(cells, idx)

    # Destination for leaves
    idx = _find_label(cells, "Destination for leaves")
    if idx >= 0:
        result["destination"] = _next_value(cells, idx)

    # Substitute info
    idx = _find_label(cells, "Name", start=_find_label(cells, "Destination for leaves") + 1 if _find_label(cells, "Destination for leaves") >= 0 else 100)
    if idx >= 0:
        # Substitute block: Name, Payroll No, Position/Dept, Contact
        # Values are at fixed offsets after the labels
        # Labels: [120] Name, [121] Payroll No, [122] Position/Dept, [123] Contact
        # Values: [124] name, [125] payroll, [126] position, [127] contact
        if idx + 4 < len(cells):
            result["substitute_name"] = cells[idx + 4].strip() if idx + 4 < len(cells) else ""
            result["substitute_payroll"] = cells[idx + 5].strip() if idx + 5 < len(cells) else ""
            result["substitute_position"] = cells[idx + 6].strip() if idx + 6 < len(cells) else ""
            result["substitute_contact"] = cells[idx + 7].strip() if idx + 7 < len(cells) else ""

    # Address + telephone (labels in one row, values in next row)
    # Layout: [128] Address, [129] telephone, [130] actual_address, [131] actual_phone
    idx = _find_label(cells, "Address")
    if idx >= 0 and idx + 2 < len(cells):
        result["address"] = cells[idx + 2].strip()
    if idx >= 0 and idx + 3 < len(cells):
        result["telephone"] = cells[idx + 3].strip()

    # Leave balance (annual)
    # Current (A) at cells[52], values at [61] days, [62] hours
    # Using (B) at cells[53], values at [63] days, [64] hours
    idx = _find_label(cells, "Current (A)")
    if idx >= 0:
        # Find numeric values after the header block
        # The pattern is: Current(A), Using(B), Remaining(A-B), Days, Hours, Days, Hours, Days, Hours
        # Then values: current_days, current_hours, using_days, using_hours, remaining_days, remaining_hours
        values_start = idx + 9  # skip 9 header cells
        if values_start + 5 < len(cells):
            try:
                result["annual_current_days"] = cells[values_start].strip()
                result["annual_current_hours"] = cells[values_start + 1].strip()
                result["annual_using_days"] = cells[values_start + 2].strip()
                result["annual_using_hours"] = cells[values_start + 3].strip()
                result["annual_remaining_days"] = cells[values_start + 4].strip()
                result["annual_remaining_hours"] = cells[values_start + 5].strip()
            except IndexError:
                pass

    return result


def generate_leave_profiles(all_structured: list[dict]) -> dict:
    """Generate per-person leave usage profiles."""
    by_writer = defaultdict(list)
    for doc in all_structured:
        writer = doc.get("writer", "Unknown")
        by_writer[writer].append(doc)

    profiles = {}
    for writer, docs in by_writer.items():
        leave_types = Counter(d.get("leave_type", "Unknown") for d in docs)
        purposes = Counter(d.get("purpose", "") for d in docs if d.get("purpose"))
        destinations = Counter(d.get("destination", "") for d in docs if d.get("destination"))
        substitutes = Counter(d.get("substitute_name", "") for d in docs if d.get("substitute_name"))

        profiles[writer] = {
            "total_docs": len(docs),
            "low_confidence": len(docs) <= 5,
            "leave_type_distribution": dict(leave_types.most_common()),
            "common_purposes": dict(purposes.most_common(5)),
            "common_destinations": dict(destinations.most_common(5)),
            "preferred_substitute": dict(substitutes.most_common(3)),
            "typical_duration": {
                "avg_days": sum(d.get("using_days", 0) for d in docs) / max(len(docs), 1),
                "avg_hours": sum(d.get("using_hours", 0) for d in docs) / max(len(docs), 1),
            },
        }

    return profiles


def main():
    if not INPUT_FILE.exists():
        print(f"Input file not found: {INPUT_FILE}")
        print("Run: python scrape_form_docs.py AppFrm-073")
        return

    data = json.load(open(INPUT_FILE, encoding="utf-8"))
    documents = data.get("documents", [])
    print(f"Loaded {len(documents)} leave documents")

    # Extract structured fields
    all_structured = []
    for doc in documents:
        text_cells = doc.get("text_cells", [])
        if not text_cells:
            continue

        fields = extract_structured_fields(text_cells)
        fields["doc_id"] = doc["doc_id"]
        fields["writer"] = doc.get("writer", "")
        fields["date"] = doc.get("date", "")
        all_structured.append(fields)

    print(f"Extracted structured fields for {len(all_structured)} documents")

    # Save structured analysis
    output = {
        "form_code": "AppFrm-073",
        "total_documents": len(all_structured),
        "structured_data": all_structured,
    }
    out_file = OUTPUT_DIR / "leave_structured_analysis.json"
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    print(f"Saved: {out_file}")

    # Spot-check: show first 3 docs
    print("\n--- Spot Check (first 3 docs) ---")
    for doc in all_structured[:3]:
        print(f"\n  doc_id={doc['doc_id']}, writer={doc['writer']}")
        for k, v in doc.items():
            if k not in ("doc_id", "writer", "date"):
                print(f"    {k}: {v}")

    # Field coverage
    print("\n--- Field Coverage ---")
    field_counts = Counter()
    for doc in all_structured:
        for k, v in doc.items():
            if k not in ("doc_id", "writer", "date") and v:
                field_counts[k] += 1
    for field, count in field_counts.most_common():
        pct = count / len(all_structured) * 100
        print(f"  {field:30s}: {count}/{len(all_structured)} ({pct:.0f}%)")

    # Generate profiles
    profiles = generate_leave_profiles(all_structured)
    prof_file = OUTPUT_DIR / "leave_profiles.json"
    with open(prof_file, "w", encoding="utf-8") as f:
        json.dump(profiles, f, ensure_ascii=False, indent=2)
    print(f"\nProfiles saved: {prof_file} ({len(profiles)} writers)")

    # Leave type summary
    print("\n--- Leave Type Summary ---")
    type_counts = Counter()
    for doc in all_structured:
        type_counts[doc.get("leave_type", "Unknown")] += 1
    for lt, count in type_counts.most_common():
        print(f"  {lt}: {count}")


if __name__ == "__main__":
    main()
