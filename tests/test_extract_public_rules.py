"""Tests for scripts/extract_public_rules.py - form_rules/*.json (local, gitignored,
may name colleagues) -> rules/public/*.json (committed, shareable)."""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
sys.path.insert(0, os.path.join(ROOT, "dev"))

from extract_public_rules import extract  # noqa: E402
from form_rules import check_rules  # noqa: E402

BOOK = {
    "form": "AppFrm-999",
    "title": "Test form",
    "schema_version": 1,
    "fields": {
        "subject": {"label": "Subject", "scope": "org", "visibility": "public", "dept": "ARL",
                    "checks": [{"type": "max_len", "max": 60}],
                    "why": "office practice: short English subjects", "evidence": ["1", "2"]},
        "account_str": {"label": "Account", "scope": "org", "visibility": "local", "dept": "ARL",
                         "checks": [{"type": "fixed", "value": "410911"}],
                         "why": "Jane Doe always books this to the RAPID pot", "evidence": ["5"]},
        "budget_code": {"label": "Budget", "scope": "self", "visibility": "local", "fiscal_year": 2026,
                        "checks": [{"type": "one_of", "values": ["NN2606-0001"]}],
                        "why": "budgets assigned to this person", "evidence": ["3"]},
        "amount": {"label": "Amount", "scope": "case", "checks": [], "why": "from the receipt", "evidence": []},
    },
    "conditional": [
        {"when": {"field": "subject", "regex": "(?i)runpod"}, "then": {"field": "account_str", "value": "410911"},
         "visibility": "local", "why": "Jane Doe's pot rule", "evidence": ["5"]},
        {"when": {"field": "subject", "regex": "(?i)conf"}, "then": {"field": "subject", "value": "x"},
         "visibility": "public", "why": "office practice", "evidence": ["6"]},
    ],
}


def test_public_scope_org_field_kept_in_full():
    out = extract(BOOK)
    assert out["fields"]["subject"]["checks"] == BOOK["fields"]["subject"]["checks"]
    assert out["fields"]["subject"]["why"] == BOOK["fields"]["subject"]["why"]
    assert out["fields"]["subject"]["evidence"] == ["1", "2"]


def test_self_field_becomes_valueless_stub():
    f = out = extract(BOOK)["fields"]["budget_code"]
    assert f == {"label": "Budget", "scope": "self", "source": "profile", "on_missing": "block"}


def test_non_public_org_field_becomes_team_pack_stub():
    f = extract(BOOK)["fields"]["account_str"]
    assert f == {"label": "Account", "scope": "org", "source": "team-pack", "on_missing": "warn"}
    assert "Jane Doe" not in json.dumps(f)


def test_case_field_kept_but_uncompared():
    f = extract(BOOK)["fields"]["amount"]
    assert f["scope"] == "case"


def test_non_public_conditional_dropped():
    out = extract(BOOK)
    whys = [c["why"] for c in out["conditional"]]
    assert "Jane Doe's pot rule" not in whys
    assert any("office practice" in w for w in whys)


def test_no_names_anywhere_in_output():
    out = extract(BOOK)
    blob = json.dumps(out)
    assert "Jane Doe" not in blob


def test_schema_version_and_known_fields_preserved_for_check_rules():
    out = extract(BOOK)
    draft = {"subject": "short", "account_str": "anything", "budget_code": "NN2606-0001", "amount": "1"}
    # unknown-field guard should not fire: every field name survives extraction
    assert check_rules(out, draft) == []


def test_extracted_rulebooks_pass_leak_guard_name_check():
    sys.path.insert(0, os.path.join(ROOT, "scripts", "hooks"))
    from public_leak_guard import name_keyed_object_violations

    out = extract(BOOK)
    assert name_keyed_object_violations(json.dumps(out)) == []


def test_shared_fixture_pair_matches_the_extractor():
    """test-fixtures/field-rules/{full,public}-book.json are read by the TS port's
    vitest tests too (B3) - keep them in lockstep with what this script produces."""
    fixtures = os.path.join(ROOT, "test-fixtures", "field-rules")
    full = json.load(open(os.path.join(fixtures, "full-book.json")))
    public = json.load(open(os.path.join(fixtures, "public-book.json")))
    assert extract(full) == public
