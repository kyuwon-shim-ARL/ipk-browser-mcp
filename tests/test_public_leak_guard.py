"""Tests for scripts/hooks/public_leak_guard.py - the public-repo pre-commit guard."""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts", "hooks"))

from public_leak_guard import (  # noqa: E402
    DUMMY_CARD,
    card_number_violations,
    check_file,
    masked_card_violations,
    name_keyed_object_violations,
    path_allowed,
)


# Built at runtime so this file never contains a literal the guard would flag.
TEST_CARD = "-".join(["4111"] + ["1111"] * 3)
TEST_CARD_BARE = TEST_CARD.replace("-", "")
TEST_MASKED = "-".join(["4111", "XXXX", "XXXX", "1111"])

def test_card_number_violations_flags_a_real_looking_card():
    assert card_number_violations(f"call {TEST_CARD} now") == [TEST_CARD]


def test_card_number_violations_flags_bare_16_digits():
    assert card_number_violations(f"parse('{TEST_CARD_BARE}')") == [TEST_CARD_BARE]


def test_card_number_violations_allows_the_dummy():
    assert card_number_violations(f"example: {DUMMY_CARD}") == []


def test_masked_card_violations_flags_real_digits_at_the_ends():
    assert masked_card_violations(f"Card No\t{TEST_MASKED}") == [TEST_MASKED]


def test_masked_card_violations_allows_fully_masked():
    assert masked_card_violations("Card No\tXXXX-XXXX-XXXX-XXXX") == []


def test_masked_card_violations_allows_the_dummys_masked_form():
    # The B4 self-field tests use the dummy card's masked form (its own outer digits,
    # mirroring an approved document's own masked display) - this must not trip the
    # guard the way a real masked card would.
    dummy_outer = DUMMY_CARD.split("-")
    dummy_masked = "-".join([dummy_outer[0], "XXXX", "XXXX", dummy_outer[3]])
    assert masked_card_violations(f"Card No\t{dummy_masked}") == []


def test_masked_card_violations_still_flags_a_different_cards_masked_form():
    # Only the dummy's own outer digits are exempt - a masked card with real-looking but
    # different outer digits must still be flagged.
    test_outer = TEST_MASKED.split("-")
    assert masked_card_violations(f"Card No\t{TEST_MASKED}") == [TEST_MASKED]
    assert test_outer[0] != DUMMY_CARD.split("-")[0]


def test_name_keyed_object_violations_flags_a_writer_profiles_style_table():
    doc = json.dumps({
        "writer_profiles": {
            "Jane Doe": {"total_docs": 53},
            "John Roe": {"total_docs": 4},
            "Sam Poe": {"total_docs": 1},
        }
    })
    assert name_keyed_object_violations(doc) == ["writer_profiles"]


def test_name_keyed_object_violations_ignores_normal_objects():
    doc = json.dumps({"field_schema": {"subject": {}, "budget_code": {}, "item_date": {}}})
    assert name_keyed_object_violations(doc) == []


def test_name_keyed_object_violations_ignores_non_json_text():
    assert name_keyed_object_violations("not json at all") == []


def test_path_allowed_for_listed_prefixes():
    assert path_allowed("form_templates/AppFrm-021.json")
    assert path_allowed("ipk-browser-mcp/src/tools/ipk-submit.ts")
    assert path_allowed("README.md")


def test_path_allowed_rejects_unlisted_path():
    assert not path_allowed("analysis_results/traveler_profiles.json")
    assert not path_allowed("notes/private.txt")


def test_check_file_flags_card_in_modified_file_regardless_of_path():
    problems = check_file("M", "dev/pipeline.py", f"card = '{TEST_CARD}'")
    assert len(problems) == 1
    assert TEST_CARD in problems[0]


def test_check_file_blocks_new_file_outside_allowlist():
    problems = check_file("A", "notes/private.txt", "hello")
    assert len(problems) == 1
    assert "outside the public-repo path allowlist" in problems[0]


def test_check_file_allows_new_file_inside_allowlist():
    assert check_file("A", "form_templates/AppFrm-099.json", "{}") == []


def test_check_file_does_not_block_a_modified_file_outside_allowlist():
    # The allowlist gates NEW files only; an existing tracked dev/ or docs/ file being
    # edited is not blocked by path (v4 A3).
    assert check_file("M", "analysis_results/traveler_profiles.json", "{}") == []


def test_check_file_clean_file_has_no_problems():
    assert check_file("M", "form_templates/AppFrm-021.json", json.dumps({"fixed_fields": {}})) == []
