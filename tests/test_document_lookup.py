"""
Unit tests for document_lookup.py
"""
import sys
import os
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from document_lookup import (
    validate_doc_id,
    _th_td,
    _input_value,
    _select_selected,
    parse_document_fields,
    search_documents,
)


# ---------------------------------------------------------------------------
# validate_doc_id
# ---------------------------------------------------------------------------

def test_validate_doc_id_valid():
    assert validate_doc_id("12345") == "12345"


def test_validate_doc_id_valid_with_whitespace():
    assert validate_doc_id("  42  ") == "42"


def test_validate_doc_id_empty_raises():
    with pytest.raises(ValueError, match="INVALID_DOC_ID"):
        validate_doc_id("")


def test_validate_doc_id_none_raises():
    with pytest.raises(ValueError, match="INVALID_DOC_ID"):
        validate_doc_id(None)


def test_validate_doc_id_alpha_raises():
    with pytest.raises(ValueError, match="INVALID_DOC_ID"):
        validate_doc_id("abc123")


def test_validate_doc_id_special_char_raises():
    with pytest.raises(ValueError, match="INVALID_DOC_ID"):
        validate_doc_id("123; DROP TABLE--")


# ---------------------------------------------------------------------------
# _th_td
# ---------------------------------------------------------------------------

def test_th_td_basic():
    html = "<table><tr><th>Document No</th><td>ARL-202600-01</td></tr></table>"
    assert _th_td(html, "Document No") == "ARL-202600-01"


def test_th_td_with_classes():
    html = '<table><tr><th class="l02">Subject</th><td class="l">My Trip</td></tr></table>'
    assert _th_td(html, "Subject") == "My Trip"


def test_th_td_missing_label():
    html = "<table><tr><th>Other</th><td>Value</td></tr></table>"
    assert _th_td(html, "Document No") == ""


def test_th_td_empty_html():
    assert _th_td("", "Document No") == ""


def test_th_td_strips_inner_html():
    html = "<table><tr><th>Subject</th><td><span>Hello World</span></td></tr></table>"
    assert _th_td(html, "Subject") == "Hello World"


def test_th_td_whitespace_in_value():
    html = "<table><tr><th>Date</th><td>  2026-03-26  </td></tr></table>"
    assert _th_td(html, "Date") == "2026-03-26"


# ---------------------------------------------------------------------------
# _input_value
# ---------------------------------------------------------------------------

def test_input_value_name_before_value():
    html = '<input type="hidden" name="start_date" value="2026-03-20">'
    assert _input_value(html, "start_date") == "2026-03-20"


def test_input_value_value_before_name():
    # value attribute appears before name attribute
    html = '<input type="hidden" value="2026-03-25" name="end_date">'
    assert _input_value(html, "end_date") == "2026-03-25"


def test_input_value_missing_field():
    html = '<input type="hidden" name="other_field" value="xyz">'
    assert _input_value(html, "start_date") == ""


def test_input_value_empty_value():
    html = '<input type="hidden" name="control_no" value="">'
    assert _input_value(html, "control_no") == ""


def test_input_value_single_quotes():
    html = "<input type='hidden' name='start_date' value='2026-01-01'>"
    assert _input_value(html, "start_date") == "2026-01-01"


# ---------------------------------------------------------------------------
# _select_selected
# ---------------------------------------------------------------------------

def test_select_selected_basic():
    html = """
    <select name="budget_type">
      <option value="">-- select --</option>
      <option value="rd" selected>R&D</option>
      <option value="gen">General</option>
    </select>
    """
    assert _select_selected(html, "budget_type") == "R&D"


def test_select_selected_no_selection():
    html = """
    <select name="province_code">
      <option value="">= Province =</option>
      <option value="11">Seoul</option>
    </select>
    """
    assert _select_selected(html, "province_code") == ""


def test_select_selected_missing_select():
    html = "<div>No select here</div>"
    assert _select_selected(html, "budget_type") == ""


def test_select_selected_selected_equals_attribute():
    html = """
    <select name="travel_type_code">
      <option value="air" selected="selected">Airplane</option>
    </select>
    """
    assert _select_selected(html, "travel_type_code") == "Airplane"


# ---------------------------------------------------------------------------
# parse_document_fields - common fields
# ---------------------------------------------------------------------------

TRAVEL_REQUEST_HTML = """
<html><body>
<table>
  <tr><th>Document No</th><td>ARL-202600-01</td></tr>
  <tr><th class="l02">Subject</th><td class="l">RAPID 2026 Q1 Travel</td></tr>
  <tr><th>Drafter</th><td>Lab - Researcher - John Doe [ 00123 ]</td></tr>
  <tr><th>Date</th><td>2026-03-26</td></tr>
  <tr><th>Destination(Organization/Conference name)</th><td>KAIST, Daejeon</td></tr>
  <tr><th>Purpose</th><td>Conference attendance</td></tr>
  <tr><th>Budget Control No.</th><td>BC-2026-001</td></tr>
</table>
<input type="hidden" name="start_date" value="2026-03-20">
<input type="hidden" name="end_date" value="2026-03-22">
<select name="budget_type">
  <option value="rd" selected>R&D</option>
</select>
<select name="province_code">
  <option value="44" selected>Chungnam (충남)</option>
</select>
<select name="city_code">
  <option value="44200" selected>Daejeon (대전)</option>
</select>
<select name="travel_type_code">
  <option value="kt" selected>KTX</option>
</select>
AppFrm-023
</body></html>
"""

LEAVE_HTML = """
<html><body>
<table>
  <tr><th>Document No</th><td>ARL-202600-02</td></tr>
  <tr><th class="l02">Subject</th><td class="l">Annual Leave</td></tr>
  <tr><th>Drafter</th><td>Lab - Researcher - Jane Smith [ 00456 ]</td></tr>
  <tr><th>Date</th><td>2026-04-01</td></tr>
</table>
<select name="leave_kind[]">
  <option value="annual" selected>Annual Leave</option>
</select>
<input type="hidden" name="begin_date[]" value="2026-04-10">
<input type="hidden" name="end_date[]" value="2026-04-11">
AppFrm-073
</body></html>
"""

EXPENSE_HTML = """
<html><body>
<table>
  <tr><th>Document No</th><td>ARL-202600-03</td></tr>
  <tr><th class="l02">Subject</th><td class="l">Travel Settlement</td></tr>
  <tr><th>Drafter</th><td>Lab - Researcher - Bob Kim [ 00789 ]</td></tr>
  <tr><th>Date</th><td>2026-04-05</td></tr>
</table>
<input type="hidden" name="travel_total" value="150,000">
AppFrm-020
</body></html>
"""


def test_parse_travel_request():
    result = parse_document_fields(TRAVEL_REQUEST_HTML, doc_type="travel_request")
    assert result["doc_no"] == "ARL-202600-01"
    assert result["subject"] == "RAPID 2026 Q1 Travel"
    assert result["writer"] == "John Doe"
    assert result["doc_date"] == "2026-03-26"
    assert result["start_date"] == "2026-03-20"
    assert result["end_date"] == "2026-03-22"
    assert result["destination"] == "KAIST, Daejeon"
    assert result["purpose"] == "Conference attendance"
    assert result["budget_control_no"] == "BC-2026-001"
    assert result["budget_type"] == "R&D"
    assert result["province"] == "Chungnam"
    assert result["city"] == "Daejeon"
    assert result["transport_mode"] == "KTX"


def test_parse_leave():
    result = parse_document_fields(LEAVE_HTML, doc_type="leave")
    assert result["doc_no"] == "ARL-202600-02"
    assert result["subject"] == "Annual Leave"
    assert result["writer"] == "Jane Smith"
    assert result["leave_type"] == "Annual Leave"
    assert result["start_date"] == "2026-04-10"
    assert result["end_date"] == "2026-04-11"


def test_parse_expense():
    result = parse_document_fields(EXPENSE_HTML, doc_type="expense")
    assert result["doc_no"] == "ARL-202600-03"
    assert result["subject"] == "Travel Settlement"
    assert result["writer"] == "Bob Kim"
    assert result["amount"] == 150000


def test_parse_empty_html():
    result = parse_document_fields("", doc_type="travel_request")
    assert result["subject"] == ""
    assert result["writer"] == ""
    assert "_warnings" in result
    assert any("doc_no" in w for w in result["_warnings"])


def test_parse_auto_detect_travel_request():
    result = parse_document_fields(TRAVEL_REQUEST_HTML, doc_type="auto")
    assert result["detected_doc_type"] == "travel_request"
    assert "destination" in result


def test_parse_auto_detect_leave():
    result = parse_document_fields(LEAVE_HTML, doc_type="auto")
    assert result["detected_doc_type"] == "leave"
    assert "leave_type" in result


def test_parse_auto_detect_expense():
    result = parse_document_fields(EXPENSE_HTML, doc_type="auto")
    assert result["detected_doc_type"] == "expense"
    assert "amount" in result


def test_parse_auto_detect_unknown_type():
    html = "<html><body><table><tr><th>Document No</th><td>ARL-000000-00</td></tr></table></body></html>"
    result = parse_document_fields(html, doc_type="auto")
    # Should not crash; detected type should remain "auto" (unrecognized)
    assert result["detected_doc_type"] == "auto"


def test_parse_drafter_format():
    html = """
    <table>
      <tr><th>Drafter</th><td>BioLab - Senior Researcher - Alice Park [ 00321 ]</td></tr>
      <tr><th>Document No</th><td>ARL-202600-99</td></tr>
    </table>
    """
    result = parse_document_fields(html, doc_type="auto")
    assert result["writer"] == "Alice Park"


def test_parse_doc_no_fallback_pattern():
    # doc_no not in th/td structure but matches ARL- pattern inside a bare td
    html = "<table><tr><td>ARL-202600-77</td></tr></table>"
    result = parse_document_fields(html, doc_type="auto")
    assert result.get("doc_no") == "ARL-202600-77"


def test_parse_expense_settle_amount_fallback():
    html = """
    <table>
      <tr><th>Document No</th><td>ARL-202600-04</td></tr>
    </table>
    <input type="hidden" name="settle_amount" value="200000">
    AppFrm-020
    """
    result = parse_document_fields(html, doc_type="expense")
    assert result["amount"] == 200000


def test_parse_expense_invalid_amount():
    html = """
    <table>
      <tr><th>Document No</th><td>ARL-202600-05</td></tr>
    </table>
    <input type="hidden" name="travel_total" value="N/A">
    AppFrm-020
    """
    result = parse_document_fields(html, doc_type="expense")
    assert result.get("amount_raw") == "N/A"
    assert "amount" not in result


# ---------------------------------------------------------------------------
# search_documents
# ---------------------------------------------------------------------------

DOCUMENT_LIST_HTML = """
<html><body>
<table>
  <tr>
    <td><a href="document_view.php?doc_id=1001&form=AppFrm-023">RAPID 2026 Q1 Travel</a></td>
    <td>2026-03-26</td>
  </tr>
  <tr>
    <td><a href="document_view.php?doc_id=1002&form=AppFrm-073">Annual Leave April</a></td>
    <td>2026-04-01</td>
  </tr>
  <tr>
    <td><a href="document_view.php?doc_id=1003&form=AppFrm-023">RAPID 2025 Q4 Travel</a></td>
    <td>2025-12-10</td>
  </tr>
</table>
</body></html>
"""


def test_search_documents_no_filter():
    results = search_documents(DOCUMENT_LIST_HTML)
    assert len(results) == 3
    assert results[0]["doc_id"] == "1001"
    assert results[0]["subject"] == "RAPID 2026 Q1 Travel"


def test_search_documents_keyword_filter():
    results = search_documents(DOCUMENT_LIST_HTML, keyword="RAPID 2026")
    assert len(results) == 1
    assert results[0]["doc_id"] == "1001"


def test_search_documents_keyword_case_insensitive():
    results = search_documents(DOCUMENT_LIST_HTML, keyword="rapid")
    assert len(results) == 2


def test_search_documents_form_code_filter():
    results = search_documents(DOCUMENT_LIST_HTML, form_code="AppFrm-073")
    assert len(results) == 1
    assert results[0]["doc_id"] == "1002"


def test_search_documents_date_filter():
    # The date filter matches against the regex match group (href + title text),
    # so the date must appear inside the anchor tag itself (e.g. in the href).
    html = """
    <table>
      <tr><td><a href="document_view.php?doc_id=2001&date=2025-12-10">Q4 Travel</a></td></tr>
      <tr><td><a href="document_view.php?doc_id=2002&date=2026-01-05">Q1 Report</a></td></tr>
    </table>
    """
    results = search_documents(html, date="2025-12-10")
    assert len(results) == 1
    assert results[0]["doc_id"] == "2001"


def test_search_documents_empty_html():
    results = search_documents("")
    assert results == []


def test_search_documents_combined_filter():
    results = search_documents(DOCUMENT_LIST_HTML, keyword="RAPID", form_code="AppFrm-023")
    assert len(results) == 2
    doc_ids = {r["doc_id"] for r in results}
    assert doc_ids == {"1001", "1003"}


def test_search_documents_no_match():
    results = search_documents(DOCUMENT_LIST_HTML, keyword="NonExistentKeyword")
    assert results == []
