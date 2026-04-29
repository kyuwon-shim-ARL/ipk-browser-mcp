#!/usr/bin/env python3
"""
Structured extraction and analysis for AppFrm-020 (Card Expense Request) documents.

Input: analysis_results/card_expense_patterns.json (from scrape_form_docs.py)
Output:
  analysis_results/card_expense_structured_analysis.json
  analysis_results/card_expense_profiles.json (per-person expense patterns)
"""

import json
import re
from pathlib import Path
from collections import Counter, defaultdict

INPUT_FILE = Path("analysis_results/card_expense_patterns.json")
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


def _is_amount(s: str) -> bool:
    """Return True if the string looks like a numeric amount (digits and commas)."""
    return bool(re.match(r"[\d,]+$", s.strip()))


def extract_structured_fields(text_cells: list[str]) -> dict:
    """Extract structured fields from card expense form text_cells using label-based search."""
    cells = text_cells
    result = {}

    # Header fields (label -> next cell)
    for label, key in [
        ("Drafter", "drafter_info"),
        ("Date", "draft_date"),
        ("Subject", "subject"),
        ("Budget Type", "budget_type"),
        ("Budget Code", "budget_code"),
        ("Payment", "payment"),
        ("Card Number", "card_number"),
        ("Venue", "venue"),
        ("Participants", "participants"),
        ("Purpose & Minutes", "purpose_minutes"),
        ("Payment Date", "payment_date"),
    ]:
        idx = _find_label(cells, label)
        if idx >= 0:
            result[key] = _next_value(cells, idx)

    # Notes: label is followed by actual notes text OR by "File Attachment List"
    notes_idx = _find_label(cells, "Notes")
    if notes_idx >= 0 and notes_idx + 1 < len(cells):
        val = cells[notes_idx + 1].strip()
        result["notes"] = "" if val == "File Attachment List" else val

    # Line item row (all 60 docs have exactly 1 line item)
    # Table header: No | Date of Invoice | Cate No | Account Code | Description |
    #               Amount excl. VAT | VAT | Total Amount | P/C | Control No | Payee/Vendor
    # Data row: 10 cells (common case - Description embedded in Account Code via \n)
    #       or: 11 cells (rare - Description is a separate cell)
    pv_idx = _find_label(cells, "Payee/Vendor")
    if pv_idx >= 0 and pv_idx + 10 < len(cells):
        rs = pv_idx + 1  # row start
        result["item_no"] = cells[rs].strip()
        result["item_date"] = cells[rs + 1].strip()
        result["item_cate_no"] = cells[rs + 2].strip()

        acct_cell = cells[rs + 3].strip()
        if "\n" in acct_cell:
            # Common case: "[XXXXX]\nDescription text"
            parts = acct_cell.split("\n", 1)
            result["item_account_code"] = parts[0].strip().strip("[]")
            result["item_description"] = parts[1].strip()
            amt_offset = 4
        else:
            # Rare case: account code and description are separate cells
            result["item_account_code"] = acct_cell.strip("[]")
            next_cell = cells[rs + 4].strip() if rs + 4 < len(cells) else ""
            if not _is_amount(next_cell):
                result["item_description"] = next_cell
                amt_offset = 5
            else:
                result["item_description"] = ""
                amt_offset = 4

        result["item_amount_excl_vat"] = cells[rs + amt_offset].strip()
        result["item_vat"] = cells[rs + amt_offset + 1].strip()
        result["item_total_amount"] = cells[rs + amt_offset + 2].strip()
        result["item_pc"] = cells[rs + amt_offset + 3].strip()
        result["item_control_no"] = cells[rs + amt_offset + 4].strip()
        result["item_vendor"] = cells[rs + amt_offset + 5].strip()

    # Grand total (the "Total" label row at bottom)
    total_idx = _find_label(cells, "Total")
    if total_idx >= 0:
        result["total"] = _next_value(cells, total_idx)

    return result


def generate_expense_profiles(all_structured: list[dict]) -> dict:
    """Generate per-person card expense profiles."""
    by_writer = defaultdict(list)
    for doc in all_structured:
        writer = doc.get("writer", "Unknown")
        by_writer[writer].append(doc)

    profiles = {}
    for writer, docs in by_writer.items():
        venues = Counter(d.get("venue", "") for d in docs if d.get("venue"))
        purposes = Counter(d.get("purpose_minutes", "") for d in docs if d.get("purpose_minutes"))
        vendors = Counter(d.get("item_vendor", "") for d in docs if d.get("item_vendor"))
        budget_codes = Counter(d.get("budget_code", "") for d in docs if d.get("budget_code"))
        account_codes = Counter(d.get("item_account_code", "") for d in docs if d.get("item_account_code"))
        descriptions = Counter(d.get("item_description", "") for d in docs if d.get("item_description"))
        subjects = Counter(d.get("subject", "") for d in docs)

        # Parse amounts to compute average spend
        amounts = []
        for d in docs:
            raw = d.get("item_total_amount", "").replace(",", "").strip()
            try:
                amounts.append(int(raw))
            except ValueError:
                pass

        profiles[writer] = {
            "total_docs": len(docs),
            "low_confidence": len(docs) <= 3,
            "common_venues": dict(venues.most_common(5)),
            "common_purposes": dict(purposes.most_common(5)),
            "common_vendors": dict(vendors.most_common(5)),
            "budget_codes": dict(budget_codes.most_common(3)),
            "account_codes": dict(account_codes.most_common(5)),
            "descriptions": dict(descriptions.most_common(5)),
            "subject_patterns": dict(subjects.most_common(5)),
            "avg_amount_krw": round(sum(amounts) / len(amounts)) if amounts else 0,
        }

    return profiles


def main():
    if not INPUT_FILE.exists():
        print(f"Input file not found: {INPUT_FILE}")
        print("Run: python scrape_form_docs.py AppFrm-020")
        return

    data = json.load(open(INPUT_FILE, encoding="utf-8"))
    documents = data.get("documents", [])
    print(f"Loaded {len(documents)} card expense documents")

    # Extract structured fields
    all_structured = []
    for doc in documents:
        text_cells = doc.get("text_cells", [])
        if not text_cells:
            continue

        fields = extract_structured_fields(text_cells)
        fields["doc_id"] = doc["doc_id"]
        fields["doc_no"] = doc.get("doc_no", "")
        fields["writer"] = doc.get("writer", "")
        fields["date"] = doc.get("date", "")
        all_structured.append(fields)

    print(f"Extracted structured fields for {len(all_structured)} documents")

    # Save structured analysis
    output = {
        "form_code": "AppFrm-020",
        "total_documents": len(all_structured),
        "structured_data": all_structured,
    }
    out_file = OUTPUT_DIR / "card_expense_structured_analysis.json"
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    print(f"Saved: {out_file}")

    # Spot-check: show first 3 docs
    print("\n--- Spot Check (first 3 docs) ---")
    for doc in all_structured[:3]:
        print(f"\n  doc_id={doc['doc_id']}, writer={doc['writer']}")
        for k, v in doc.items():
            if k not in ("doc_id", "doc_no", "writer", "date"):
                print(f"    {k}: {v!r}")

    # Field coverage
    print("\n--- Field Coverage ---")
    field_counts = Counter()
    for doc in all_structured:
        for k, v in doc.items():
            if k not in ("doc_id", "doc_no", "writer", "date") and v:
                field_counts[k] += 1
    n = len(all_structured)
    for field, count in field_counts.most_common():
        pct = count / n * 100
        print(f"  {field:30s}: {count}/{n} ({pct:.0f}%)")

    # Generate profiles
    profiles = generate_expense_profiles(all_structured)
    prof_file = OUTPUT_DIR / "card_expense_profiles.json"
    with open(prof_file, "w", encoding="utf-8") as f:
        json.dump(profiles, f, ensure_ascii=False, indent=2)
    print(f"\nProfiles saved: {prof_file} ({len(profiles)} writers)")

    # Writer summary
    print("\n--- Writer Summary ---")
    for writer, p in profiles.items():
        print(f"  {writer}: {p['total_docs']} docs, avg {p['avg_amount_krw']:,} KRW/item")
        top_venue = next(iter(p["common_venues"]), "N/A")
        print(f"    top venue: {top_venue!r}")
        top_acct = next(iter(p["account_codes"]), "N/A")
        top_desc = next(iter(p["descriptions"]), "N/A")
        print(f"    top account: {top_acct} / {top_desc}")

    # Account code summary
    print("\n--- Account Code Distribution ---")
    acct_counts = Counter()
    for doc in all_structured:
        key = f"{doc.get('item_account_code','')} / {doc.get('item_description','')}"
        acct_counts[key] += 1
    for combo, cnt in acct_counts.most_common():
        print(f"  {cnt:2d}x  {combo}")


if __name__ == "__main__":
    main()
