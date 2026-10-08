"""Tests for dev/baseline_gate.py - drafts are held to colleagues' approved documents."""
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "dev"))
sys.path.insert(0, os.path.join(ROOT, "scripts", "hooks"))

from baseline_gate import (  # noqa: E402
    Baseline,
    BaselineUnavailable,
    baseline_from_texts,
    check,
    draft_lengths,
    parse_domestic_report,
)
from require_baseline_gate import (  # noqa: E402
    command_needs_block,
    executed_scripts,
    resolve_script,
    script_needs_block,
    unresolved_blocks,
)


def report_text(purpose: str, agenda: str, result: str, other: str, concl: str, itin: str = "x" * 300) -> str:
    """Shape of travel_report_view.php innerText (labels as the groupware renders them)."""
    return (
        "1. Travel Information\nDate of Report\t2026-08-28\n"
        "Business Period\t2026-08-25 ~ 2026-08-27 ( 2 Night / 3 Days )\n"
        f"Travel Purpose\t{purpose}\nItinerary\n"
        "Date\tOrganization to visit\tPerson to Meet / Contact information\tAgenda(s) to discuss\n"
        f"{itin}\n2. Travel Details\nMail activities and meeting agendas.\n{agenda}\n"
        f"Meeting/Conference details\n{result}\n"
        f"Others (Activities related to business travel purpose, etc.)\n{other}\n"
        f"3. Implications and remarks\nImplications and remarks\n{concl}\n"
        "* Whether gifts are provided : No\n"
    )


def colleague_texts(n: int = 6) -> dict:
    # purpose ~150-250, agenda ~200-400, result ~200-400, other ~100-150, conclusion ~150-250
    out = {}
    for i in range(n):
        out[str(300000 + i)] = report_text(
            "p" * (150 + 20 * i), "a" * (200 + 40 * i), "r" * (200 + 40 * i), "o" * (100 + 10 * i), "c" * (150 + 20 * i)
        )
    return out


# ---------------------------------------------------------------- parsing


def test_parse_domestic_report_reads_each_section():
    f = parse_domestic_report(report_text("PURPOSE", "AGENDA", "RESULT", "OTHER", "CONCL", itin="ITIN"))
    assert f == {
        "purpose_field": "PURPOSE",
        "itinerary": "ITIN",
        "agenda_field": "AGENDA",
        "result_field": "RESULT",
        "other_field": "OTHER",
        "conclusion_field": "CONCL",
    }


def test_parse_returns_empty_for_a_page_without_a_report():
    assert parse_domestic_report("Forbidden: Page Not Found.") == {}


def test_draft_lengths_folds_itinerary_columns_into_one_figure():
    d = draft_lengths({"date_field": "aa", "org_field": "bbb", "person_field": "c", "discuss_field": "dddd", "purpose_field": "pp"})
    assert d["itinerary"] == 10
    assert d["purpose_field"] == 2


# ---------------------------------------------------------------- the check


def test_concise_draft_passes():
    b = baseline_from_texts("domestic_travel_report", colleague_texts())
    fields = {"purpose_field": "p" * 200, "agenda_field": "a" * 250, "result_field": "r" * 250,
              "other_field": "o" * 90, "conclusion_field": "c" * 170}
    assert check(fields, b) == []


def test_field_longer_than_colleague_p75_is_a_violation():
    b = baseline_from_texts("domestic_travel_report", colleague_texts())
    v = check({"purpose_field": "p" * 900, "agenda_field": "a" * 250}, b)
    assert len(v) == 1 and "purpose_field" in v[0] and "900" in v[0]


def test_budget_code_absent_from_every_precedent_is_a_violation():
    b = baseline_from_texts("domestic_travel_report", colleague_texts())
    v = check({"purpose_field": "Supported by the program [NN2606-0001]."}, b)
    assert any("NN2606-0001" in x for x in v)


def test_budget_code_is_fine_when_two_colleagues_write_one_too():
    texts = colleague_texts()
    for k in list(texts)[:2]:  # one colleague is not a practice; two are
        texts[k] = texts[k].replace("Travel Purpose\t", "Travel Purpose\tFunded by [NN2606-0002]. ")
    b = baseline_from_texts("domestic_travel_report", texts)
    assert check({"purpose_field": "Supported by [NN2606-0001]."}, b) == []


def test_too_few_precedents_is_unavailable_not_a_pass():
    b = baseline_from_texts("domestic_travel_report", colleague_texts(3))
    with pytest.raises(BaselineUnavailable):
        check({"purpose_field": "p" * 100}, b)


def test_pages_without_a_report_do_not_count_as_precedents():
    texts = colleague_texts(4)
    texts.update({"1": "Forbidden", "2": "Forbidden"})
    b = baseline_from_texts("domestic_travel_report", texts)
    assert b.doc_ids == sorted(colleague_texts(4))
    with pytest.raises(BaselineUnavailable):
        check({"purpose_field": "p" * 100}, b)


def test_ai4sci_first_draft_would_have_been_stopped():
    """2026-10-06: the first AI4Sci draft (purpose 438, agenda 1034 chars) against ARL p75 (324, 612)."""
    b = Baseline(
        kind="domestic_travel_report",
        doc_ids=[str(i) for i in range(18)],
        lengths={"purpose_field": [111, 134, 137, 137, 177, 181, 196, 242, 246, 249, 267, 273, 277, 324, 419, 495, 527, 695],
                 "agenda_field": [107, 119, 145, 188, 207, 234, 236, 266, 329, 421, 495, 508, 558, 612, 688, 757, 1204, 2024]},
        texts_with_codes=set(),
    )
    v = check({"purpose_field": "p" * 438, "agenda_field": "a" * 1034}, b)
    assert len(v) == 2
    assert check({"purpose_field": "p" * 208, "agenda_field": "a" * 257}, b) == []


# ---------------------------------------------------------------- hook


SAVING = 'pg.evaluate("Check_Form(\'D\')")'


def test_hook_blocks_saving_script_without_gate():
    assert script_needs_block(f"import x\n{SAVING}\n")


def test_hook_allows_saving_script_that_calls_gate():
    assert not script_needs_block(f"import baseline_gate\nbaseline_gate.gate(gw, 'domestic_travel_report', F)\n{SAVING}\n")


def test_hook_allows_saving_script_with_logged_skip():
    assert not script_needs_block(f"import baseline_gate\nbaseline_gate.skip('card_er', 'no free text')\n{SAVING}\n")


def test_hook_ignores_read_only_scripts():
    assert not script_needs_block("page.goto(url)\nprint(page.content())\n")


@pytest.mark.parametrize("cmd,expected", [
    ("timeout 200 python3 submit_x.py", ["submit_x.py"]),
    ("python3 -u /abs/submit_x.py --dry", ["/abs/submit_x.py"]),
    ("cd repo; python submit_a.py && python3.12 b.py", ["submit_a.py", "b.py"]),
    ("grep Check_Form submit_x.py", []),
    ("printf '{\"command\":\"python3 submit_x.py\"}' | python3 hook.py", ["hook.py"]),
    ("python3 - <<'EOF'\nopen('submit_x.py')\nEOF", []),
])
def test_hook_only_looks_at_scripts_python_executes(cmd, expected):
    assert executed_scripts(cmd) == expected


@pytest.mark.parametrize("marker", ["Check_Form_Request('insert')", "form1.submit()", "document.all('mode1').value='draft'"])
def test_hook_recognises_every_save_path(marker):
    assert script_needs_block(f"fr.evaluate(\"{marker}\")\n")


# ---------------------------------------------------------------- review 2026-10-06: silent passes


def _b():
    return baseline_from_texts("domestic_travel_report", colleague_texts())


def test_unknown_field_name_is_unavailable_not_a_pass():
    with pytest.raises(BaselineUnavailable):
        check({"purpose": "x" * 5000}, _b())


def test_non_text_fields_are_allowed_without_a_baseline():
    assert check({"report_date": "2026-10-06", "report_leader": "Colleague P", "purpose_field": "p" * 100}, _b()) == []


def test_field_with_too_few_precedents_is_unavailable():
    texts = colleague_texts()
    for k in list(texts)[:3]:
        texts[k] = texts[k].replace("Others (Activities related to business travel purpose, etc.)", "Others:")
    with pytest.raises(BaselineUnavailable):
        check({"other_field": "o" * 50}, baseline_from_texts("domestic_travel_report", texts))


def test_itinerary_header_row_is_not_counted_in_the_baseline():
    b = baseline_from_texts("domestic_travel_report", colleague_texts())
    assert max(b.lengths["itinerary"]) == 300


@pytest.mark.parametrize("text", ["과제NN2606-0001로 지원", "NN2606–0001", "nn2606-0001", "[NN 2606-0001]"])
def test_budget_code_spellings_are_caught(text):
    assert any("budget code" in v for v in check({"purpose_field": text}, _b()))


# ---------------------------------------------------------------- review 2026-10-06: hook bypasses


@pytest.mark.parametrize("cmd,expected", [
    (".venv/bin/python submit_x.py", ["submit_x.py"]),
    ("/usr/bin/python3 -X dev -W ignore submit_x.py", ["submit_x.py"]),
    ("uv run submit_x.py", ["submit_x.py"]),
    ("uv run python submit_x.py", ["submit_x.py"]),
    ("./submit_x.py", ["./submit_x.py"]),
    ("bash -c \"python3 submit_x.py\"", ["submit_x.py"]),
    ("python3 'submit x.py'", ["submit x.py"]),
    ("python3 -m pytest tests/test_x.py -q", []),
    ("python3 -u -m pytest tests/test_x.py", []),
])
def test_more_ways_of_running_a_script(cmd, expected):
    assert executed_scripts(cmd) == expected


def test_save_markers_in_the_command_itself_are_checked():
    assert command_needs_block("python3 - <<'EOF'\npg.evaluate(\"Check_Form('D')\")\nEOF")
    assert not command_needs_block("python3 - <<'EOF'\nimport baseline_gate\nbaseline_gate.gate(gw, 'k', F)\npg.evaluate(\"Check_Form('D')\")\nEOF")
    assert not command_needs_block("grep -n \"Check_Form(\" submit_x.py")


def test_ipk_gw_save_helpers_count_as_saving():
    assert script_needs_block("gw.submit_leave(start, end)\n")


def test_marker_only_in_comment_or_docstring_is_not_saving():
    assert not script_needs_block('"""Saves with Check_Form(\'D\')."""\n# Check_Form_Request(\'insert\')\nprint(1)\n')


@pytest.mark.parametrize("src", [
    "from baseline_gate import gate\ngate(gw, 'k', F)\n",
    "import baseline_gate as bg\nbg.gate(gw, 'k', F)\n",
])
def test_aliased_gate_calls_are_recognised(src):
    assert not script_needs_block(src + "pg.evaluate(\"Check_Form('D')\")\n")


def test_gate_whose_failure_is_swallowed_does_not_count():
    src = ("import baseline_gate\ntry:\n    baseline_gate.gate(gw, 'k', F)\nexcept Exception:\n    pass\n"
           "pg.evaluate(\"Check_Form('D')\")\n")
    assert script_needs_block(src)


def test_unresolvable_submit_script_is_blocked(tmp_path):
    assert unresolved_blocks(["submit_missing.py"], tmp_path, "python3 submit_missing.py")
    assert not unresolved_blocks(["helper_missing.py"], tmp_path, "python3 helper_missing.py")


def test_script_is_found_after_cd(tmp_path):
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "submit_y.py").write_text("pg.evaluate(\"Check_Form('D')\")\n")
    assert resolve_script("submit_y.py", tmp_path, "cd sub && python3 submit_y.py") == tmp_path / "sub" / "submit_y.py"
