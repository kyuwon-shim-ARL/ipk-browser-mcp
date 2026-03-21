#!/usr/bin/env python3
"""
Analyze AppFrm-026 (Overseas Travel Settlement) documents from pre-scraped patterns JSON.

Input:  analysis_results/overseas_travel_settlement_patterns.json
Output: analysis_results/overseas_travel_settlement_structured_analysis.json
        analysis_results/overseas_travel_settlement_profiles.json
"""

import json
import re
from collections import Counter
from pathlib import Path

FORM_CODE = "AppFrm-026"
INPUT_PATH = Path("analysis_results/overseas_travel_settlement_patterns.json")
OUTPUT_DIR = Path("analysis_results")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# Budget categories in the Traveling Budget table
BUDGET_CATEGORIES = [
    'Transport Fee',
    'Daily Expense',
    'Accommodation',
    'Food Expense',
    'Miscellaneous(e.g visa fees)',
]


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


def _parse_amount(s: str) -> int | None:
    """Parse a numeric amount string like '1,647,300' -> 1647300."""
    cleaned = s.strip().replace(',', '')
    if cleaned.lstrip('-').isdigit():
        return int(cleaned)
    return None


def extract_structured_fields(text_cells: list, doc_meta: dict) -> dict:
    """Extract structured fields from text_cells.

    AppFrm-026 (Overseas Travel Settlement) layout:
      Subject
      Traveler
      Budget Control No
      Country
      Organization/Conference Name
      Purpose of Business Travel
      Relevance of travel to project and research  (text, often empty in cells)
      Travel with Invitation  (Yes/No)
      Car Rent  (Yes/No)
      Business related materials
      Budget Account Code
      Schedule table: From / To / Business Schedule/Destination / Transportation
      Traveling Budget table: Category / Total Budget / CreditCard(a) / Cash(b) / Sum / Diff / Remarks / CardNo
        -> rows: Transport Fee, Daily Expense, Accommodation, Food Expense, Miscellaneous, Total Sum
      Payment distribution: 1st Pay, 2nd Pay
      Travel Report link
      Overseas Business Travel History table
      Attachment sections: Transport, Accommodation, Boarding Pass, ETC, Verification docs, Poster
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
        'Traveler': 'traveler',
        'Budget Control No': 'budget_control_no',
        'Country': 'country',
        'Organization/Conference Name': 'conference_name',
        'Purpose of Business Travel': 'purpose',
        'Travel with Invitation': 'travel_with_invitation',
        'Car Rent': 'car_rent',
        'Business related materials': 'business_materials',
        'Budget Account Code': 'budget_account_code',
    }
    for label, field_name in label_map.items():
        idx = _find_label(cells, label)
        val = _next_value(cells, idx)
        if val:
            result[field_name] = val

    # --- Payment Date (appears near approval section header) ---
    idx = _find_label(cells, 'Payment Date')
    val = _next_value(cells, idx)
    if val and re.match(r'\d{4}-\d{2}-\d{2}', val):
        result['payment_date'] = val

    # --- Submit date ---
    idx = _find_label(cells, 'Date')
    val = _next_value(cells, idx)
    if val and re.match(r'\d{4}-\d{2}-\d{2}', val):
        result['submit_date'] = val

    # --- Travel date range from schedule table ---
    # Pattern: after "Transportation" header, cells alternate [from_date][to_date][schedule][transport]
    # The first from/to pair gives the overall start/end
    sched_idx = _find_label(cells, 'Transportation')
    if sched_idx >= 0:
        date_pairs = []
        i = sched_idx + 1
        while i < len(cells):
            c = cells[i].strip()
            if re.match(r'^\d{4}-\d{2}-\d{2}$', c):
                if i + 1 < len(cells) and re.match(r'^\d{4}-\d{2}-\d{2}$', cells[i + 1].strip()):
                    date_pairs.append((c, cells[i + 1].strip()))
                    i += 2
                    continue
            # Stop at next major section header
            if c in ('Traveling Budget', 'Category', 'Total Budget'):
                break
            i += 1
        if date_pairs:
            result['travel_start'] = date_pairs[0][0]
            result['travel_end'] = date_pairs[-1][1]
            # Compute nights/days from date range
            try:
                from datetime import date as dt
                start = dt.fromisoformat(date_pairs[0][0])
                end = dt.fromisoformat(date_pairs[-1][1])
                result['travel_nights'] = (end - start).days
                result['travel_days'] = (end - start).days + 1
            except Exception:
                pass

    # --- Traveling Budget table ---
    # After "Institute Credit Card No" header, each budget row is:
    # [Category] [total_budget] [corp_card_a] [cash_b] [sum_ab] [difference] [remarks] [card_no]
    # But they're flattened into cells. We search each category by label.
    budget_section_start = _find_label(cells, 'Institute Credit Card No')
    if budget_section_start < 0:
        budget_section_start = _find_label(cells, 'Traveling Budget')

    for category in BUDGET_CATEGORIES:
        cat_idx = _find_label(cells, category, budget_section_start if budget_section_start >= 0 else 0)
        if cat_idx >= 0:
            # Next 6 cells: total_budget, corp_card, cash, sum, diff, remarks
            amounts = []
            card_no = ''
            for offset in range(1, 8):
                if cat_idx + offset >= len(cells):
                    break
                v = cells[cat_idx + offset].strip()
                parsed = _parse_amount(v)
                if parsed is not None:
                    amounts.append(parsed)
                elif v.startswith('Appr') or v.startswith('appro') or v.lower().startswith('appro'):
                    # remarks cell
                    pass
                elif re.match(r'^\d{4}-\d{4}-\d{4}-\d{4}$', v):
                    card_no = v
                    break
                elif v in BUDGET_CATEGORIES or v in ('Total Sum', 'Traveling Budget', 'Category',
                                                      'Total Budget', 'Transport', 'Accommodation',
                                                      'Boarding Pass', 'ETC (Visa, Insurance etc)'):
                    break

            # Map: amounts[0]=total_budget, amounts[1]=corp_card, amounts[2]=cash,
            #      amounts[3]=sum_ab, amounts[4]=difference
            field_base = category.lower().replace('(e.g visa fees)', '').replace(' ', '_').strip('_')
            field_base = re.sub(r'[^a-z0-9_]', '', field_base)
            if amounts:
                result[f'{field_base}_total_budget'] = amounts[0]
            if len(amounts) >= 2:
                result[f'{field_base}_corp_card'] = amounts[1]
            if len(amounts) >= 3:
                result[f'{field_base}_cash'] = amounts[2]
            if len(amounts) >= 4:
                result[f'{field_base}_sum'] = amounts[3]
            if card_no:
                result['corp_card_no'] = card_no

    # --- Total Sum row ---
    total_idx = _find_label(cells, 'Total Sum', budget_section_start if budget_section_start >= 0 else 0)
    if total_idx >= 0:
        amounts = []
        for offset in range(1, 7):
            if total_idx + offset >= len(cells):
                break
            v = cells[total_idx + offset].strip()
            parsed = _parse_amount(v)
            if parsed is not None:
                amounts.append(parsed)
            elif v and not v.replace(',', '').isdigit():
                # May be remarks or next section; stop if not a number
                if v not in ('', ' '):
                    # Check if it's settle amount text
                    if 'Settle Amount' in v:
                        # Parse settle amount from text
                        m = re.search(r'Settle Amount\s*:\s*([\d,]+)', v)
                        if m:
                            result['settle_amount'] = _parse_amount(m.group(1))
                        m2 = re.search(r'Reimbursement to traveler:\s*([\d,]+)', v)
                        if m2:
                            result['reimbursement_to_traveler'] = _parse_amount(m2.group(1))
                    break
        if amounts:
            result['total_budget_sum'] = amounts[0]
        if len(amounts) >= 3:
            result['total_settle_amount'] = amounts[3] if len(amounts) > 3 else amounts[-1]

    # --- Settle/Reimbursement text (inline format) ---
    if 'settle_amount' not in result:
        for c in cells:
            if 'Settle Amount' in c:
                m = re.search(r'Settle Amount\s*:\s*([\d,]+)', c)
                if m:
                    result['settle_amount'] = _parse_amount(m.group(1))
                m2 = re.search(r'Reimbursement to traveler:\s*([\d,]+)', c)
                if m2:
                    result['reimbursement_to_traveler'] = _parse_amount(m2.group(1))
                break

    # --- Writer from metadata ---
    result['writer'] = doc_meta.get('writer', '')
    result['doc_id'] = doc_meta.get('doc_id', '')
    result['doc_no'] = doc_meta.get('doc_no', '')
    result['date'] = doc_meta.get('date', '')

    return result


def generate_profiles(all_structured: list) -> dict:
    """Generate per-traveler profiles for overseas travel settlement."""
    by_traveler = {}
    for doc in all_structured:
        # traveler field may be "Name(ID)" format
        traveler_raw = doc.get('traveler', '') or doc.get('writer', '')
        # Normalize: strip ID suffix like "(00528)"
        traveler = re.sub(r'\(\d+\)\s*$', '', traveler_raw).strip()
        if not traveler:
            continue
        by_traveler.setdefault(traveler, []).append(doc)

    profiles = {}
    for traveler, docs in sorted(by_traveler.items()):
        n = len(docs)
        profile = {
            'traveler': traveler,
            'n_documents': n,
            'low_confidence': n <= 3,
        }

        # Corp card numbers
        cards = [d.get('corp_card_no', '') for d in docs if d.get('corp_card_no')]
        if cards:
            card_counter = Counter(cards)
            most_common, most_common_count = card_counter.most_common(1)[0]
            profile['corp_card'] = {
                'default': most_common,
                'confidence': round(most_common_count / len(cards), 2),
                'all_used': dict(card_counter.most_common()),
                'note': 'may be shared lab resource',
            }

        # Budget accounts ranked by recency
        budgets = []
        for d in docs:
            ba = d.get('budget_account_code', '')
            if ba:
                budgets.append({'account': ba, 'date': d.get('date', '')})
        if budgets:
            budgets.sort(key=lambda x: x['date'], reverse=True)
            seen = []
            for b in budgets:
                if b['account'] not in seen:
                    seen.append(b['account'])
            profile['budget_accounts'] = {
                'ranked_by_recency': seen[:5],
                'total_unique': len(set(b['account'] for b in budgets)),
                'note': 'grant-cycle dependent',
            }

        # Countries visited
        countries = Counter(d.get('country', '') for d in docs if d.get('country'))
        if countries:
            profile['countries_visited'] = dict(countries.most_common(5))

        # Settle amounts
        settles = [d.get('settle_amount') for d in docs if d.get('settle_amount')]
        if settles:
            profile['settle_amounts'] = sorted(settles, reverse=True)

        # Invitation pattern
        invitations = Counter(d.get('travel_with_invitation', '') for d in docs
                              if d.get('travel_with_invitation'))
        if invitations:
            profile['invitation_pattern'] = dict(invitations.most_common())

        # Drafter info
        drafters = [d.get('drafter_info', '') for d in docs if d.get('drafter_info')]
        if drafters:
            profile['drafter_info'] = Counter(drafters).most_common(1)[0][0]

        profiles[traveler] = profile

    return profiles


def main():
    print(f"=== AppFrm-026 Overseas Travel Settlement Pattern Analysis ===\n")

    with open(INPUT_PATH, encoding='utf-8') as f:
        raw = json.load(f)

    documents = raw.get('documents', [])
    print(f"Loaded {len(documents)} documents from {INPUT_PATH}")

    all_structured = []
    field_coverage = Counter()

    for doc in documents:
        text_cells = doc.get('text_cells', [])
        structured = extract_structured_fields(text_cells, doc)
        all_structured.append(structured)

        for k, v in structured.items():
            if v not in ('', None, [], 0) and not k.startswith('_'):
                field_coverage[k] += 1

    total = len(all_structured)
    print(f"\nField coverage across {total} documents:")
    for field, count in sorted(field_coverage.items(), key=lambda x: -x[1]):
        pct = round(count / total * 100)
        print(f"  {field:<45} {count}/{total} ({pct}%)")

    # Save structured analysis
    struct_path = OUTPUT_DIR / "overseas_travel_settlement_structured_analysis.json"
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
    profile_path = OUTPUT_DIR / "overseas_travel_settlement_profiles.json"
    with open(profile_path, 'w', encoding='utf-8') as f:
        json.dump(profiles, f, ensure_ascii=False, indent=2)
    print(f"Profiles saved: {profile_path}")
    print(f"  {len(profiles)} travelers profiled")

    # Budget summary
    settle_amounts = [d.get('settle_amount') for d in all_structured if d.get('settle_amount')]
    if settle_amounts:
        print(f"\nSettle amount stats across {len(settle_amounts)} docs with data:")
        print(f"  Min: {min(settle_amounts):,}")
        print(f"  Max: {max(settle_amounts):,}")
        print(f"  Avg: {sum(settle_amounts) // len(settle_amounts):,}")

    countries = Counter(d.get('country', '') for d in all_structured if d.get('country'))
    if countries:
        print(f"\nDestination countries:")
        for c, n in countries.most_common():
            print(f"  {c}: {n}")

    print("\nDone!")


if __name__ == "__main__":
    main()
