"""M-2 (code review 2026-11-09): SmartFormAgent.classify_form must separate overseas
travel REQUEST intent (AppFrm-022) from overseas travel SETTLEMENT intent (AppFrm-026) -
a bare "해외출장"/"해외"/"overseas" mention is request-intent; only an explicit
정산/settlement wording resolves to AppFrm-026.
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "dev"))

from document_agent import SmartFormAgent  # noqa: E402


def agent():
    return SmartFormAgent()


def test_bare_overseas_mention_is_request_intent_appfrm_022():
    assert agent().classify_form("해외출장 다음주 보스턴") == "AppFrm-022"


def test_bare_overseas_english_is_request_intent_appfrm_022():
    assert agent().classify_form("overseas trip next week to Boston") == "AppFrm-022"


def test_explicit_overseas_settlement_is_appfrm_026():
    assert agent().classify_form("해외출장정산 보스턴 학회") == "AppFrm-026"


def test_explicit_overseas_settlement_english_is_appfrm_026():
    assert agent().classify_form("overseas settlement for the Boston conference") == "AppFrm-026"


def test_overseas_settlement_wins_over_bare_overseas_in_same_text():
    assert agent().classify_form("해외출장 해외출장정산 처리") == "AppFrm-026"


def test_bc_code_with_bare_overseas_is_request_appfrm_022_not_settlement():
    """Previously 'Overseas beats domestic' with a BC-code returned AppFrm-026
    unconditionally for any overseas mention - even a plain travel REQUEST. A BC-code is
    itself a travel-request signal, so a bare overseas mention with no settlement wording
    must resolve to the overseas request (022), not the settlement (026)."""
    assert agent().classify_form("해외출장 BEXCO 학회 BC-2026-0045") == "AppFrm-022"


def test_bc_code_with_explicit_settlement_wording_is_still_appfrm_026():
    assert agent().classify_form("해외출장정산 BEXCO 학회 BC-2026-0045") == "AppFrm-026"


def test_bc_code_with_no_overseas_wording_is_domestic_travel_request():
    assert agent().classify_form("다음주 화 BEXCO 학회 BC-2026-0045") == "AppFrm-023"


# Re-review (2026-11-09): overseas (해외/overseas) AND settlement (정산/settle) wording
# anywhere in the text - not only the exact compact phrases in FORM_KEYWORDS - must
# resolve to AppFrm-026, checked before the AppFrm-022 request-intent fallback.


def test_overseas_space_settlement_is_appfrm_026():
    assert agent().classify_form("해외출장 정산") == "AppFrm-026"


def test_overseas_spaced_out_settlement_with_destination_is_appfrm_026():
    assert agent().classify_form("해외 출장 정산 보스턴") == "AppFrm-026"


def test_overseas_space_settlement_with_bc_code_is_appfrm_026():
    assert agent().classify_form("해외출장 정산 BC-2026-0045") == "AppFrm-026"


def test_overseas_trip_settlement_english_is_appfrm_026():
    assert agent().classify_form("overseas trip settlement") == "AppFrm-026"


def test_overseas_travel_cost_settlement_is_appfrm_026():
    assert agent().classify_form("해외 출장비 정산") == "AppFrm-026"
