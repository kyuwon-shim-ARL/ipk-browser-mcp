"""Tests for dev/form_rules.py - per-field rulebooks inferred from approved documents."""
import json
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "dev"))

from baseline_gate import BaselineUnavailable  # noqa: E402
from form_rules import check_rules, load_rulebook, validate_rulebook  # noqa: E402

BOOK = {
    "form": "AppFrm-999",
    "title": "Test form",
    "schema_version": 1,
    "fields": {
        "subject": {"label": "Subject", "scope": "org", "visibility": "public", "dept": "ARL",
                    "checks": [{"type": "pattern", "regex": r"^\[Card\] "}, {"type": "max_len", "max": 60}, {"type": "english"}],
                    "why": "all colleague ERs", "evidence": ["1", "2"]},
        "budget_code": {"label": "Budget", "scope": "self", "visibility": "local", "fiscal_year": "2026",
                        "checks": [{"type": "one_of", "values": ["NN2606-0001", "NN2606-0002"]}],
                        "why": "budgets assigned to this person", "evidence": ["3"]},
        "amount": {"label": "Amount", "scope": "case", "checks": [], "why": "from the receipt", "evidence": []},
        "vat": {"label": "VAT", "scope": "org", "visibility": "public", "dept": "ARL",
                "checks": [{"type": "one_of", "values": ["0", "split"]}], "why": "", "evidence": ["1"]},
        "saving_years": {"label": "Saving years", "scope": "org", "visibility": "public", "dept": "ARL",
                          "checks": [{"type": "fixed", "value": "5"}], "why": "", "evidence": ["1"]},
    },
    "conditional": [
        {"when": {"field": "subject", "regex": "(?i)runpod|openai"}, "then": {"field": "vat", "value": "0"},
         "visibility": "public",
         "why": "overseas IT: no Korean VAT", "evidence": ["4"]},
    ],
    "ignore": ["hidden_token"],
}

GOOD = {"subject": "[Card] ARL RunPod GPU Compute Credits", "budget_code": "NN2606-0001", "amount": "123", "vat": "0",
        "saving_years": "5", "hidden_token": "x"}


def test_valid_draft_passes():
    assert check_rules(BOOK, GOOD) == []


@pytest.mark.parametrize("field,value,needle", [
    ("subject", "ARL RunPod credits", "pattern"),
    ("subject", "[Card] " + "x" * 80, "max_len"),
    ("subject", "[Card] 런팟 크레딧", "english"),
    ("budget_code", "NN2602-0002", "one_of"),
    ("saving_years", "3", "fixed"),
])
def test_each_check_type_reports(field, value, needle):
    v = check_rules(BOOK, dict(GOOD, **{field: value}))
    assert len(v) == 1 and field in v[0] and needle in v[0]


def test_violation_names_the_scope_so_the_reader_knows_whose_practice_it_is():
    v = check_rules(BOOK, dict(GOOD, budget_code="GW17_ARRL"))
    assert "[self]" in v[0]


def test_conditional_rule():
    v = check_rules(BOOK, dict(GOOD, vat="split"))
    assert any("overseas IT" in x for x in v)


def test_a_matching_conditional_overrides_the_fields_own_checks():
    """A rule the user set (RunPod note text) wins over a statistical length limit."""
    book = json.loads(json.dumps(BOOK))
    book["fields"]["note"] = {"label": "Notes", "scope": "org", "checks": [{"type": "max_len", "max": 10}],
                              "why": "colleague p75", "evidence": ["1"]}
    book["conditional"].append({"when": {"field": "subject", "regex": "(?i)runpod"},
                                "then": {"field": "note", "value": "A fixed sentence that is long"},
                                "why": "memory: fixed RunPod note", "evidence": ["memory:x"]})
    assert check_rules(book, dict(GOOD, note="A fixed sentence that is long")) == []
    assert check_rules(book, dict(GOOD, subject="[Card] coffee", vat="split", note="x" * 20))  # no conditional -> length applies


def test_one_of_accepts_the_form_value_or_the_shown_label():
    book = json.loads(json.dumps(BOOK))
    book["fields"]["vat"]["checks"] = [{"type": "one_of", "values": ["Transfer"], "form_values": {"01": "Transfer"}}]
    assert check_rules(book, dict(GOOD, subject="[Card] coffee", vat="01")) == []
    assert check_rules(book, dict(GOOD, subject="[Card] coffee", vat="Transfer")) == []
    assert check_rules(book, dict(GOOD, subject="[Card] coffee", vat="02"))


def test_case_fields_are_not_compared_to_precedent():
    assert check_rules(BOOK, dict(GOOD, amount="999999")) == []


def test_field_without_a_rule_is_unavailable():
    with pytest.raises(BaselineUnavailable):
        check_rules(BOOK, dict(GOOD, note="hello"))


def test_validate_rejects_unknown_scope_and_check_type():
    bad = json.loads(json.dumps(BOOK))
    bad["fields"]["subject"]["scope"] = "colleague"
    bad["fields"]["vat"]["checks"] = [{"type": "vibes"}]
    errs = validate_rulebook(bad)
    assert any("scope" in e for e in errs) and any("vibes" in e for e in errs)


def test_validate_requires_evidence_for_org_and_self_rules():
    bad = json.loads(json.dumps(BOOK))
    bad["fields"]["saving_years"]["evidence"] = []
    assert any("saving_years" in e and "evidence" in e for e in validate_rulebook(bad))


def test_validate_requires_schema_version():
    bad = json.loads(json.dumps(BOOK))
    del bad["schema_version"]
    assert any("schema_version" in e for e in validate_rulebook(bad))
    bad["schema_version"] = 0
    assert any("schema_version" in e for e in validate_rulebook(bad))


def test_validate_requires_visibility_on_non_case_fields():
    bad = json.loads(json.dumps(BOOK))
    del bad["fields"]["subject"]["visibility"]
    errs = validate_rulebook(bad)
    assert any("subject" in e and "visibility" in e for e in errs)
    # case fields need no visibility
    assert "amount" not in "\n".join(errs)


def test_validate_requires_dept_on_org_fields():
    bad = json.loads(json.dumps(BOOK))
    del bad["fields"]["vat"]["dept"]
    errs = validate_rulebook(bad)
    assert any("vat" in e and "dept" in e for e in errs)


def test_validate_requires_visibility_on_conditional():
    bad = json.loads(json.dumps(BOOK))
    del bad["conditional"][0]["visibility"]
    errs = validate_rulebook(bad)
    assert any("conditional[0]" in e and "visibility" in e for e in errs)


def test_shipped_rulebooks_are_valid():
    d = os.path.join(ROOT, "form_rules")
    files = [f for f in os.listdir(d) if f.endswith(".json")] if os.path.isdir(d) else []
    for f in files:
        assert validate_rulebook(load_rulebook(f[:-5])) == [], f
