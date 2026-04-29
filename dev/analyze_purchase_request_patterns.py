#!/usr/bin/env python3
"""
Structured extraction and analysis for AppFrm-039 (Purchase Request / Budget Transfer) documents.

Input: analysis_results/purchase_request_patterns.json (from scrape_form_docs.py)
Output:
  analysis_results/purchase_request_structured_analysis.json
  analysis_results/purchase_request_profiles.json (per-person patterns)
"""

import json
import re
from pathlib import Path
from collections import Counter, defaultdict

INPUT_FILE = Path("analysis_results/purchase_request_patterns.json")
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


def extract_transfer_items(cells: list[str]) -> list[dict]:
    """Extract transfer line items from the Source/Target/Amount table."""
    src_idx = _find_label(cells, "Source")
    if src_idx < 0:
        return []

    # After Source/Target/Amount headers, rows are triplets until "Total"
    items = []
    i = src_idx + 3  # skip Source, Target, Amount headers
    while i + 2 < len(cells):
        source = cells[i].strip()
        if source == "Total":
            break
        # Skip equipment description block marker
        if source.startswith("* Descriptions of"):
            break
        target = cells[i + 1].strip() if i + 1 < len(cells) else ""
        amount = cells[i + 2].strip() if i + 2 < len(cells) else ""
        if source and target:
            items.append({"source": source, "target": target, "amount": amount})
        i += 3

    return items


def extract_equipment_description(cells: list[str]) -> dict:
    """Extract equipment description block if present (for tool/equipment purchases)."""
    equip_idx = _find_label(cells, "* Descriptions of Equipment & Tools*")
    if equip_idx < 0:
        return {}

    result = {}
    name_idx = _find_label(cells, "Name", start=equip_idx)
    if name_idx >= 0:
        result["equipment_name"] = _next_value(cells, name_idx)

    mfr_idx = _find_label(cells, "Manufacture", start=equip_idx)
    if mfr_idx >= 0:
        result["manufacturer"] = _next_value(cells, mfr_idx)

    feat_idx = _find_label(cells, "Features and Capacity", start=equip_idx)
    if feat_idx >= 0:
        result["features"] = _next_value(cells, feat_idx)

    price_idx = _find_label(cells, "Price (krw)", start=equip_idx)
    if price_idx >= 0:
        result["price_krw"] = _next_value(cells, price_idx)

    purpose_idx = _find_label(cells, "* Purpose of Purchase *", start=equip_idx)
    if purpose_idx >= 0:
        result["purchase_purpose"] = _next_value(cells, purpose_idx)

    return result


def extract_structured_fields(text_cells: list[str]) -> dict:
    """Extract structured fields from purchase request / budget transfer text_cells."""
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

    # 1. Type
    idx = _find_label(cells, "1. Type :")
    if idx >= 0:
        result["transfer_type"] = _next_value(cells, idx)

    # 2. Account No
    idx = _find_label(cells, "2. Account No")
    if idx >= 0:
        result["account_no"] = _next_value(cells, idx)

    # 3. Project Title
    idx = _find_label(cells, "3. Project Title")
    if idx >= 0:
        result["project_title"] = _next_value(cells, idx)

    # 4. Project period
    idx = _find_label(cells, "4. Project period")
    if idx >= 0:
        period_val = _next_value(cells, idx)
        result["project_period"] = period_val
        m = re.match(r"(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})", period_val)
        if m:
            result["project_start"] = m.group(1)
            result["project_end"] = m.group(2)

    # 5. Transfer Item (table)
    transfer_items = extract_transfer_items(cells)
    if transfer_items:
        result["transfer_items"] = transfer_items
        result["transfer_item_count"] = len(transfer_items)
        # Convenience: single-item shorthand
        if len(transfer_items) == 1:
            result["source_account"] = transfer_items[0]["source"]
            result["target_account"] = transfer_items[0]["target"]
            result["amount"] = transfer_items[0]["amount"]

    # Total amount
    total_idx = _find_label(cells, "Total")
    if total_idx >= 0:
        result["total_amount"] = _next_value(cells, total_idx)

    # Equipment description block (present for tool/equipment purchases)
    equip = extract_equipment_description(cells)
    if equip:
        result.update(equip)
        result["has_equipment_description"] = True

    # 6. Control No
    idx = _find_label(cells, "6. Control No:")
    if idx >= 0:
        result["control_no"] = _next_value(cells, idx)

    # Description (purpose/reason text)
    idx = _find_label(cells, "Description")
    if idx >= 0:
        result["description"] = _next_value(cells, idx)

    return result


def extract_amount_numeric(amount_str: str) -> int:
    """Parse amount string like '1,121,642' or '200,000' to int."""
    cleaned = re.sub(r"[,\s]", "", amount_str)
    try:
        return int(float(cleaned))
    except (ValueError, TypeError):
        return 0


def generate_profiles(all_structured: list[dict]) -> dict:
    """Generate per-person patterns from structured docs."""
    by_writer = defaultdict(list)
    for doc in all_structured:
        writer = doc.get("writer", "Unknown")
        by_writer[writer].append(doc)

    profiles = {}
    for writer, docs in by_writer.items():
        account_nos = Counter(d.get("account_no", "") for d in docs if d.get("account_no"))
        project_titles = Counter(d.get("project_title", "") for d in docs if d.get("project_title"))
        source_accounts = Counter(
            item["source"]
            for d in docs
            for item in d.get("transfer_items", [])
        )
        target_accounts = Counter(
            item["target"]
            for d in docs
            for item in d.get("transfer_items", [])
        )
        amounts = [
            extract_amount_numeric(d.get("total_amount", "0"))
            for d in docs
            if d.get("total_amount")
        ]

        profiles[writer] = {
            "total_docs": len(docs),
            "low_confidence": len(docs) <= 3,
            "common_account_nos": dict(account_nos.most_common(5)),
            "common_project_titles": dict(project_titles.most_common(5)),
            "common_source_accounts": dict(source_accounts.most_common(5)),
            "common_target_accounts": dict(target_accounts.most_common(5)),
            "amount_stats": {
                "min": min(amounts) if amounts else 0,
                "max": max(amounts) if amounts else 0,
                "avg": int(sum(amounts) / len(amounts)) if amounts else 0,
                "total": sum(amounts),
            },
            "has_equipment_purchases": sum(1 for d in docs if d.get("has_equipment_description", False)),
        }

    return profiles


def main():
    if not INPUT_FILE.exists():
        print(f"Input file not found: {INPUT_FILE}")
        print("Run: python scrape_form_docs.py AppFrm-039")
        return

    data = json.load(open(INPUT_FILE, encoding="utf-8"))
    documents = data.get("documents", [])
    print(f"Loaded {len(documents)} purchase request / budget transfer documents")

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
        fields["source"] = doc.get("source", "")
        all_structured.append(fields)

    print(f"Extracted structured fields for {len(all_structured)} documents")

    # Save structured analysis
    output = {
        "form_code": "AppFrm-039",
        "total_documents": len(all_structured),
        "structured_data": all_structured,
    }
    out_file = OUTPUT_DIR / "purchase_request_structured_analysis.json"
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    print(f"Saved: {out_file}")

    # Spot-check: show first 3 docs
    print("\n--- Spot Check (first 3 docs) ---")
    for doc in all_structured[:3]:
        print(f"\n  doc_id={doc['doc_id']}, writer={doc['writer']}, subject={doc.get('subject','')}")
        for k, v in doc.items():
            if k not in ("doc_id", "doc_no", "writer", "date", "source"):
                print(f"    {k}: {v}")

    # Field coverage
    print("\n--- Field Coverage ---")
    field_counts = Counter()
    for doc in all_structured:
        for k, v in doc.items():
            if k not in ("doc_id", "doc_no", "writer", "date", "source") and v:
                field_counts[k] += 1
    n = len(all_structured)
    for field, count in field_counts.most_common():
        pct = count / n * 100
        print(f"  {field:35s}: {count}/{n} ({pct:.0f}%)")

    # Transfer item count distribution
    print("\n--- Transfer Item Count Distribution ---")
    item_counts = Counter(d.get("transfer_item_count", 0) for d in all_structured)
    for cnt, freq in sorted(item_counts.items()):
        print(f"  {cnt} item(s): {freq} docs")

    # Target account distribution
    print("\n--- Target Account Distribution ---")
    targets = Counter()
    for d in all_structured:
        for item in d.get("transfer_items", []):
            targets[item["target"]] += 1
    for tgt, cnt in targets.most_common(15):
        print(f"  {cnt:3d}  {tgt}")

    # Source account distribution
    print("\n--- Source Account Distribution ---")
    sources = Counter()
    for d in all_structured:
        for item in d.get("transfer_items", []):
            sources[item["source"]] += 1
    for src, cnt in sources.most_common(10):
        print(f"  {cnt:3d}  {src}")

    # Amount summary
    print("\n--- Amount Summary ---")
    amounts = [extract_amount_numeric(d.get("total_amount", "0")) for d in all_structured if d.get("total_amount")]
    if amounts:
        print(f"  Min:  {min(amounts):>15,}")
        print(f"  Max:  {max(amounts):>15,}")
        print(f"  Avg:  {int(sum(amounts)/len(amounts)):>15,}")
        print(f"  Sum:  {sum(amounts):>15,}")

    # Generate profiles
    profiles = generate_profiles(all_structured)
    prof_file = OUTPUT_DIR / "purchase_request_profiles.json"
    with open(prof_file, "w", encoding="utf-8") as f:
        json.dump(profiles, f, ensure_ascii=False, indent=2)
    print(f"\nProfiles saved: {prof_file} ({len(profiles)} writers)")

    # Per-writer summary
    print("\n--- Per-Writer Summary ---")
    for writer, p in sorted(profiles.items(), key=lambda x: -x[1]["total_docs"]):
        eq = p["has_equipment_purchases"]
        print(f"  {writer:25s}: {p['total_docs']:3d} docs, avg={p['amount_stats']['avg']:>12,} KRW, equip={eq}")


if __name__ == "__main__":
    main()
