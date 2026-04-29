#!/usr/bin/env python3
"""
Structured extraction and analysis for AppFrm-054 (Domestic Travel Settlement) documents.

Input: analysis_results/domestic_travel_settlement_patterns.json (from scrape_form_docs.py)
Output:
  analysis_results/domestic_travel_settlement_structured_analysis.json
  analysis_results/domestic_travel_settlement_profiles.json
"""

import json
import re
from pathlib import Path
from collections import Counter, defaultdict

INPUT_FILE = Path("analysis_results/domestic_travel_settlement_patterns.json")
OUTPUT_DIR = Path("analysis_results")

BUDGET_CATEGORIES = [
    "Transport Fee",
    "Airfare",
    "Train, Express Bus",
    "Own Car",
    "Taxi",
    "Other Public",
    "Toll",
    "Daily Expense",
    "Accommodation",
    "Food Expense",
    "⑤ Miscellaneous(e.g visa fees)",
    "Additional Daily",
]


def _find_label(cells: list[str], label: str, start: int = 0) -> int:
    for i in range(start, len(cells)):
        if cells[i].strip() == label:
            return i
    return -1


def _next_value(cells: list[str], label_idx: int) -> str:
    if label_idx >= 0 and label_idx + 1 < len(cells):
        return cells[label_idx + 1].strip()
    return ""


def _parse_amount(s: str) -> int:
    """Parse Korean-format number string like '20,000' -> 20000. Returns 0 on failure."""
    s = s.strip().replace(",", "").replace(".", "")
    try:
        return int(s)
    except ValueError:
        return 0


def extract_structured_fields(text_cells: list[str]) -> dict:
    """Extract structured fields from domestic travel settlement text_cells using label-based search."""
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

    # Payment Date
    idx = _find_label(cells, "Payment Date")
    if idx >= 0:
        result["payment_date"] = _next_value(cells, idx)

    # Traveler
    idx = _find_label(cells, "Traveler")
    if idx >= 0:
        result["traveler"] = _next_value(cells, idx)

    # Budget Control No
    idx = _find_label(cells, "Budget Control No")
    if idx >= 0:
        raw = _next_value(cells, idx)
        # strip brackets: [25004908] -> 25004908
        result["budget_control_no"] = raw.strip("[]")

    # Travel with Invitation
    idx = _find_label(cells, "Travel with Invitation")
    if idx >= 0:
        result["travel_with_invitation"] = _next_value(cells, idx)

    # City & Transportation (combined field)
    idx = _find_label(cells, "City & Transportation")
    if idx >= 0:
        result["city_transportation"] = _next_value(cells, idx)
        # Parse: "Seoul (서울특별시) - Seoul (서울) - Other Public Transporation"
        city_val = result["city_transportation"]
        parts = [p.strip() for p in city_val.split(" - ")]
        if len(parts) >= 3:
            result["province"] = parts[0]
            result["city"] = parts[1]
            result["transport_mode"] = parts[2]
        elif len(parts) == 2:
            result["province"] = parts[0]
            result["city"] = parts[1]

    # Purpose of Business Travel (category)
    idx = _find_label(cells, "Purpose of Business Travel")
    if idx >= 0:
        result["purpose_category"] = _next_value(cells, idx)

    # Purpose (detail text)
    idx = _find_label(cells, "Purpose")
    if idx >= 0:
        result["purpose"] = _next_value(cells, idx)

    # Itinerary: parse the first itinerary entry
    # Label is "Itinerary\n1" (or "Itinerary\n2" etc)
    itinerary_idx = -1
    for i, cell in enumerate(cells):
        if cell.strip().startswith("Itinerary") and "\n" in cell:
            itinerary_idx = i
            break
    if itinerary_idx >= 0 and itinerary_idx + 1 < len(cells):
        itinerary_val = cells[itinerary_idx + 1].strip()
        result["itinerary_1"] = itinerary_val
        # Parse: "2025-12-18 ~ 2025-12-18 ( 0 nights / 1 days ) , 08:00 ~ 16:00"
        m = re.match(r"(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})", itinerary_val)
        if m:
            result["start_date"] = m.group(1)
            result["end_date"] = m.group(2)
        nights_m = re.search(r"(\d+)\s*nights?\s*/\s*(\d+)\s*days?", itinerary_val)
        if nights_m:
            result["nights"] = int(nights_m.group(1))
            result["days"] = int(nights_m.group(2))
        time_m = re.search(r",\s*(\d{2}:\d{2})\s*~\s*(\d{2}:\d{2})", itinerary_val)
        if time_m:
            result["start_time"] = time_m.group(1)
            result["end_time"] = time_m.group(2)

    # Destination (cell after "Destination(Organization/Conference name)" label)
    dest_label = "Destination(Organization/Conference name)"
    idx = _find_label(cells, dest_label)
    # The label cell is followed by "Transportation" header, then destination value, then transport value
    # Pattern observed: [dest_label, "Transportation", <destination_value>, <transport_value>]
    if idx >= 0 and idx + 3 < len(cells):
        # skip "Transportation" header at idx+1
        result["destination"] = cells[idx + 2].strip()
        result["transportation"] = cells[idx + 3].strip()

    # Budget table extraction
    # For each category: label is found, then 3-5 numeric cells follow
    # Columns: Total Budget | Institut Credit Card | Cash/Personal | Sum | Differences
    # Some rows have a Description cell appended
    budget = {}
    for cat in BUDGET_CATEGORIES:
        idx = _find_label(cells, cat)
        if idx < 0:
            continue
        # Collect up to 5 numeric-ish values after the label
        vals = []
        j = idx + 1
        while j < len(cells) and len(vals) < 5:
            v = cells[j].strip()
            # stop if we hit the next category label or non-numeric content (not an amount)
            if v in BUDGET_CATEGORIES:
                break
            # amount cell: digits, commas, or "0"
            if re.match(r"^[\d,]+$", v.replace(".", "")):
                vals.append(_parse_amount(v))
            else:
                # Could be a description note - skip and continue collecting
                pass
            j += 1
        if vals:
            key = cat.lower().replace(" ", "_").replace("(", "").replace(")", "").replace("/", "_").replace("⑤_", "").replace(",", "").replace(".", "").replace("&", "and")
            budget[key] = vals[0]  # Total Budget column
    result["budget"] = budget

    # Total Sum
    idx = _find_label(cells, "Total Sum")
    if idx >= 0:
        result["total_sum"] = _parse_amount(_next_value(cells, idx))

    # Payment to individual
    idx = _find_label(cells, "Payment to individual(①+②+③+④+⑤+⑥)")
    if idx >= 0:
        result["payment_to_individual"] = _parse_amount(_next_value(cells, idx))

    # Budget Account Code
    idx = _find_label(cells, "Budget Account Code")
    if idx >= 0:
        result["budget_account_code"] = _next_value(cells, idx)
        # Extract budget type (R&D vs General)
        bac = result["budget_account_code"]
        if bac.startswith("R&D"):
            result["budget_type"] = "R&D"
        elif bac.startswith("General"):
            result["budget_type"] = "General"
        else:
            result["budget_type"] = "Unknown"

    # Attached approved document reference
    idx = _find_label(cells, "Attach Approved Document")
    if idx >= 0:
        result["attached_approved_doc"] = _next_value(cells, idx)

    return result


def generate_settlement_profiles(all_structured: list[dict]) -> dict:
    """Generate per-person settlement usage profiles."""
    by_writer = defaultdict(list)
    for doc in all_structured:
        writer = doc.get("writer", "Unknown")
        by_writer[writer].append(doc)

    profiles = {}
    for writer, docs in by_writer.items():
        purpose_cats = Counter(d.get("purpose_category", "") for d in docs if d.get("purpose_category"))
        cities = Counter(d.get("city_transportation", "") for d in docs if d.get("city_transportation"))
        transport_modes = Counter(d.get("transport_mode", "") for d in docs if d.get("transport_mode"))
        budget_types = Counter(d.get("budget_type", "") for d in docs if d.get("budget_type"))
        invitations = Counter(d.get("travel_with_invitation", "") for d in docs if d.get("travel_with_invitation"))

        totals = [d.get("total_sum", 0) for d in docs if d.get("total_sum", 0) > 0]
        avg_total = sum(totals) / len(totals) if totals else 0

        nights_list = [d.get("nights", 0) for d in docs if "nights" in d]
        avg_nights = sum(nights_list) / len(nights_list) if nights_list else 0

        profiles[writer] = {
            "total_docs": len(docs),
            "low_confidence": len(docs) <= 5,
            "purpose_category_distribution": dict(purpose_cats.most_common()),
            "common_city_transportation": dict(cities.most_common(5)),
            "transport_mode_distribution": dict(transport_modes.most_common()),
            "budget_type_distribution": dict(budget_types.most_common()),
            "travel_with_invitation": dict(invitations.most_common()),
            "typical_budget": {
                "avg_total_sum": round(avg_total),
                "avg_nights": round(avg_nights, 2),
            },
        }

    return profiles


def main():
    if not INPUT_FILE.exists():
        print(f"Input file not found: {INPUT_FILE}")
        print("Run: python scrape_form_docs.py AppFrm-054")
        return

    data = json.load(open(INPUT_FILE, encoding="utf-8"))
    documents = data.get("documents", [])
    print(f"Loaded {len(documents)} domestic travel settlement documents")

    # Extract structured fields
    all_structured = []
    for doc in documents:
        text_cells = doc.get("text_cells", [])
        if not text_cells:
            # fall back to fields._text_cells
            text_cells = doc.get("fields", {}).get("_text_cells", [])
        if not text_cells:
            continue

        fields = extract_structured_fields(text_cells)
        fields["doc_id"] = doc["doc_id"]
        fields["doc_no"] = doc.get("doc_no", "")
        fields["writer"] = doc.get("writer", "")
        fields["date"] = doc.get("date", "")
        fields["source"] = doc.get("source", "")
        all_structured.append(fields)

    print(f"Extracted structured fields for {len(all_structured)} documents")

    # Save structured analysis
    output = {
        "form_code": "AppFrm-054",
        "total_documents": len(all_structured),
        "structured_data": all_structured,
    }
    out_file = OUTPUT_DIR / "domestic_travel_settlement_structured_analysis.json"
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    print(f"Saved: {out_file}")

    # Spot-check: show first 3 docs
    print("\n--- Spot Check (first 3 docs) ---")
    for doc in all_structured[:3]:
        print(f"\n  doc_id={doc['doc_id']}, writer={doc['writer']}, doc_no={doc['doc_no']}")
        for k, v in doc.items():
            if k not in ("doc_id", "writer", "date", "doc_no", "source"):
                print(f"    {k}: {v}")

    # Field coverage
    print("\n--- Field Coverage ---")
    field_counts = Counter()
    n = len(all_structured)
    for doc in all_structured:
        for k, v in doc.items():
            if k in ("doc_id", "writer", "date", "doc_no", "source"):
                continue
            if k == "budget":
                if v:
                    field_counts["budget"] += 1
            elif v or v == 0:
                field_counts[k] += 1
    for field, count in field_counts.most_common():
        pct = count / n * 100
        print(f"  {field:45s}: {count}/{n} ({pct:.0f}%)")

    # Generate profiles
    profiles = generate_settlement_profiles(all_structured)
    prof_file = OUTPUT_DIR / "domestic_travel_settlement_profiles.json"
    with open(prof_file, "w", encoding="utf-8") as f:
        json.dump(profiles, f, ensure_ascii=False, indent=2)
    print(f"\nProfiles saved: {prof_file} ({len(profiles)} writers)")

    # Writer summary
    print("\n--- Writer Summary ---")
    writer_counts = Counter(d["writer"] for d in all_structured)
    for writer, count in writer_counts.most_common():
        print(f"  {writer}: {count} docs")

    # Purpose category summary
    print("\n--- Purpose Category Summary ---")
    purpose_counts = Counter(d.get("purpose_category", "Unknown") for d in all_structured)
    for pc, count in purpose_counts.most_common():
        pct = count / n * 100
        print(f"  {pc}: {count} ({pct:.0f}%)")

    # City summary
    print("\n--- City & Transportation Summary ---")
    city_counts = Counter(d.get("city_transportation", "") for d in all_structured if d.get("city_transportation"))
    for ct, count in city_counts.most_common(10):
        print(f"  {ct}: {count}")

    # Budget type
    print("\n--- Budget Type Summary ---")
    bt_counts = Counter(d.get("budget_type", "Unknown") for d in all_structured)
    for bt, count in bt_counts.most_common():
        print(f"  {bt}: {count}")

    # Total sum distribution
    sums = [d.get("total_sum", 0) for d in all_structured if d.get("total_sum", 0) > 0]
    if sums:
        print(f"\n--- Total Sum Stats ---")
        print(f"  min: {min(sums):,}")
        print(f"  max: {max(sums):,}")
        print(f"  avg: {sum(sums)/len(sums):,.0f}")
        print(f"  median: {sorted(sums)[len(sums)//2]:,}")


if __name__ == "__main__":
    main()
