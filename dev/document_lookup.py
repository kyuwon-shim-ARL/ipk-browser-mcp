"""
Document lookup: parse document_view.php to extract structured fields.
Used by the bridge to auto-fill parent document references.
"""
import re
import logging
from typing import Optional

logger = logging.getLogger(__name__)


def validate_doc_id(doc_id: str) -> str:
    """Validate doc_id is numeric. Security: prevents injection."""
    if not doc_id or not str(doc_id).strip().isdigit():
        raise ValueError(f"INVALID_DOC_ID: doc_id must be numeric, got: {doc_id!r}")
    return str(doc_id).strip()


def _th_td(html: str, label: str) -> str:
    """
    Extract <td> value that immediately follows a <th> containing label.
    Handles whitespace and class attributes in both tags.
    Returns stripped plain text, or empty string if not found.
    """
    pattern = (
        r'<th[^>]*>\s*' + re.escape(label) + r'\s*</th>\s*<td[^>]*>\s*(.*?)\s*</td>'
    )
    m = re.search(pattern, html, re.S | re.I)
    if not m:
        return ""
    return re.sub(r'<[^>]+>', '', m.group(1)).strip()


def _input_value(html: str, name: str) -> str:
    """Extract value attribute from <input name="...">."""
    m = re.search(
        r'<input[^>]+name=["\']' + re.escape(name) + r'["\'][^>]+value=["\']([^"\']*)["\']',
        html, re.I
    )
    if m:
        return m.group(1).strip()
    # Also handle value before name
    m = re.search(
        r'<input[^>]+value=["\']([^"\']*)["\'][^>]+name=["\']' + re.escape(name) + r'["\']',
        html, re.I
    )
    return m.group(1).strip() if m else ""


def _select_selected(html: str, name: str) -> str:
    """Extract the selected option text from a <select name="...">."""
    m = re.search(
        r'<select[^>]+name=["\']' + re.escape(name) + r'["\'][^>]*>(.*?)</select>',
        html, re.S | re.I
    )
    if not m:
        return ""
    sel_block = m.group(1)
    opt = re.search(r'<option[^>]+selected[^>]*>(.*?)</option>', sel_block, re.S | re.I)
    if opt:
        return re.sub(r'<[^>]+>', '', opt.group(1)).strip()
    return ""


def parse_document_fields(html: str, doc_type: str = "auto") -> dict:
    """
    Parse document_view.php HTML and extract structured fields.

    Args:
        html: Raw HTML from document_view.php
        doc_type: One of "travel_request", "leave", "expense", "auto" (auto-detect)

    Returns:
        Dict with extracted fields: {doc_no, subject, writer, dates, budget_control_no, ...}
    """
    result = {"_warnings": []}

    # doc_no: <th>Document No</th><td>ARL-XXXXXX-XX</td>
    doc_no = _th_td(html, "Document No")
    if not doc_no:
        # Fallback: bare ARL- pattern anywhere in a td
        m = re.search(r'<td[^>]*>\s*([A-Z]+-\d{6,}-\d+)\s*</td>', html)
        doc_no = m.group(1) if m else ""
    if doc_no:
        result["doc_no"] = doc_no
    else:
        result["_warnings"].append("Could not extract doc_no")

    # subject: <th class="l02">Subject</th><td class="l">Value</td>
    subject = _th_td(html, "Subject")
    result["subject"] = subject

    # writer: <th class="l02">Drafter</th><td>Lab - ... - Firstname Lastname [ 00565 ]</td>
    drafter_raw = _th_td(html, "Drafter")
    if drafter_raw:
        # Format: "Lab - Role - Firstname Lastname [ 00565 ]" — extract the name part
        name_m = re.search(r'-\s*([^-\[]+?)\s*(?:\[\s*\d+\s*\])?\s*$', drafter_raw)
        result["writer"] = name_m.group(1).strip() if name_m else drafter_raw
    else:
        result["writer"] = ""

    # doc date: <th>Date</th><td>YYYY-MM-DD</td>
    doc_date = _th_td(html, "Date")
    if doc_date and re.match(r'\d{4}-\d{2}-\d{2}', doc_date):
        result["doc_date"] = doc_date

    # start_date / end_date from input fields
    start_date = _input_value(html, "start_date")
    end_date = _input_value(html, "end_date")
    if start_date:
        result["start_date"] = start_date
    if end_date:
        result["end_date"] = end_date

    # Collect all YYYY-MM-DD dates as fallback
    dates = list(set(re.findall(r'\b(\d{4}-\d{2}-\d{2})\b', html)))
    if dates:
        result["dates_found"] = dates

    # Auto-detect doc_type if needed
    if doc_type == "auto":
        if "AppFrm-023" in html or "AppFrm-054" in html or "Destination" in html or "출장" in html:
            doc_type = "travel_request"
        elif "AppFrm-073" in html or "AppFrm-026" in html or "leave" in html.lower() or "휴가" in html:
            doc_type = "leave"
        elif "AppFrm-020" in html or "expense" in html.lower() or "경비" in html:
            doc_type = "expense"

    result["detected_doc_type"] = doc_type

    # Type-specific extraction
    if doc_type == "travel_request":
        result.update(_parse_travel_request(html))
    elif doc_type == "leave":
        result.update(_parse_leave(html))
    elif doc_type == "expense":
        result.update(_parse_expense(html))

    return result


def _parse_travel_request(html: str) -> dict:
    """Extract travel-request-specific fields."""
    fields = {}

    # Destination: <th>Destination(Organization/Conference name)</th><td>Value</td>
    dest = _th_td(html, "Destination(Organization/Conference name)")
    if not dest:
        # Shorter label variant
        dest = _th_td(html, "Destination")
    if dest:
        fields["destination"] = dest

    # Purpose: <th>Purpose</th><td>Value</td>
    purpose = _th_td(html, "Purpose")
    if purpose:
        fields["purpose"] = purpose

    # Budget control number: <th>Budget Control No.</th><td>Value</td>
    # Also try the control_no input field
    bc = _th_td(html, "Budget Control No.")
    if not bc:
        bc = _input_value(html, "control_no")
    if bc:
        fields["budget_control_no"] = bc

    # Budget type: selected option in budget_type select, or text in Budget Account Code cell
    budget_type = _select_selected(html, "budget_type")
    if budget_type:
        fields["budget_type"] = budget_type
    else:
        # Fallback: detect from Budget Account Code cell text
        bac = _th_td(html, "Budget Account Code")
        if "R&D" in bac or "R&amp;D" in bac:
            fields["budget_type"] = "R&D"
        elif "General" in bac:
            fields["budget_type"] = "General"

    # Province: selected option in province_code select
    province = _select_selected(html, "province_code")
    if province and province != "= Province =":
        # Extract English name (before parenthesis if present)
        fields["province"] = re.sub(r'\s*\(.*\)', '', province).strip()

    # City: selected option in city_code select
    city = _select_selected(html, "city_code")
    if city and city not in ("= City =", "= Select City =", ""):
        fields["city"] = re.sub(r'\s*\(.*\)', '', city).strip()

    # Transport mode: selected option in travel_type_code select
    transport = _select_selected(html, "travel_type_code")
    if transport and transport not in ("= Transport =", ""):
        fields["transport_mode"] = transport

    return fields


def _parse_leave(html: str) -> dict:
    """Extract leave-specific fields."""
    fields = {}
    # Leave type from select (leave_kind[])
    leave_type = _select_selected(html, "leave_kind[]")
    if leave_type and leave_type not in ("== select Leave kind ==", ""):
        fields["leave_type"] = leave_type
    else:
        # Fallback: th/td
        lt = _th_td(html, "Leave Type")
        if lt:
            fields["leave_type"] = lt
    # Leave dates from begin_date[]/end_date[]
    begin = _input_value(html, "begin_date[]")
    end = _input_value(html, "end_date[]")
    if begin:
        fields["start_date"] = begin
    if end:
        fields["end_date"] = end
    return fields


def _parse_expense(html: str) -> dict:
    """Extract expense-specific fields."""
    fields = {}
    # Total amount from input
    total = _input_value(html, "travel_total") or _input_value(html, "settle_amount")
    if total:
        try:
            fields["amount"] = int(total.replace(',', ''))
        except ValueError:
            fields["amount_raw"] = total
    return fields


def search_documents(html_list_page: str, keyword: str = "", date: str = "", form_code: str = "") -> list:
    """
    Search document list page for matching documents.
    Uses keyword + date + form_code triple-matching.

    Args:
        html_list_page: HTML of document list page
        keyword: Search keyword (e.g., "RAPID Q1")
        date: Date string (e.g., "2026-03-26")
        form_code: Form code filter (e.g., "AppFrm-023")

    Returns:
        List of {doc_id, doc_no, subject, date} dicts
    """
    results = []
    # Find document links with doc_id
    doc_pattern = re.compile(
        r'doc_id=(\d+)[^>]*>([^<]*)</a>',
        re.I
    )
    for match in doc_pattern.finditer(html_list_page):
        doc_id = match.group(1)
        title = match.group(2).strip()

        # Apply filters
        if keyword and keyword.lower() not in title.lower():
            continue
        if date and date not in match.group(0):
            continue
        if form_code and form_code not in match.group(0):
            continue

        results.append({"doc_id": doc_id, "subject": title})

    return results
