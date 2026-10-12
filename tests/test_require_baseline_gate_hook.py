"""Tests for scripts/hooks/require_baseline_gate.py's card ER (AppFrm-021) bypass check
(plan v6 P0) and the markdown-write exemption."""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts", "hooks"))

from require_baseline_gate import (  # noqa: E402
    card_er_command_needs_block,
    card_er_script_needs_block,
    targets_only_markdown,
)


def test_python_dash_c_with_check_form_request_is_blocked():
    cmd = 'python -c "import sys; print(1); mker=Y; Check_Form_Request("'
    assert card_er_command_needs_block(cmd)


def test_python_stdin_heredoc_with_form1_submit_and_appfrm021_is_blocked():
    cmd = (
        "python - <<EOF\n"
        "url = 'document_write.php?approve_type=AppFrm-021&mker=Y'\n"
        "form1.submit(\n"
        "EOF\n"
    )
    assert card_er_command_needs_block(cmd)


def test_submit_ai4sci_registration_er_script_is_blocked():
    """The real script (301306): calls baseline_gate.gate() correctly (so the OLDER
    SAVE_MARKERS check alone would wave it through), but still bypasses the MCP tool's
    card-er-location.ts / attachment-review.ts checks - this check never exempts it."""
    text = (
        "import baseline_gate\n"
        "baseline_gate.gate(gw, 'AppFrm-021', CHECK)\n"
        "fr.goto(f'{BASE}/Document/document_write.php?approve_type=AppFrm-021&mker=Y&trseq={trseq}')\n"
        "fr.evaluate(\"\"\"()=>{\n"
        "    document.all('mode1').value='draft';\n"
        "    const f=document.form1; f.submit();\n"
        "}\"\"\")\n"
    )
    assert card_er_script_needs_block(text)


def test_readonly_script_mentioning_appfrm021_without_markers_passes():
    text = (
        "# read-only: look up this account's AppFrm-021 ERs for reference\n"
        "import requests\n"
        "print('AppFrm-021 precedent lookup, mker=Y not used here')\n"
    )
    assert not card_er_script_needs_block(text)


def test_appfrm021_mention_alone_without_a_save_marker_does_not_block_a_command():
    cmd = 'python3 -c "print(\'AppFrm-021 reference\')"'
    assert not card_er_command_needs_block(cmd)


def test_save_marker_alone_without_appfrm021_mker_does_not_trip_this_check():
    # Some OTHER form's save - not this check's concern (the pre-existing SAVE_MARKERS/
    # baseline_gate check handles non-card-ER forms).
    cmd = 'python -c "Check_Form_Request("'
    assert not card_er_command_needs_block(cmd)


def test_markdown_only_heredoc_with_save_marker_words_in_prose_passes():
    cmd = (
        "cat > plan.md <<'MD'\n"
        "The save path calls form1.submit() after Check_Form_Request( runs, "
        "mker=Y on AppFrm-021.\n"
        "MD\n"
    )
    assert targets_only_markdown(cmd)
    assert not card_er_command_needs_block(cmd)  # no python/uv run interpreter either


def test_grep_on_a_plan_markdown_file_is_not_treated_as_execution():
    cmd = "grep -n 'AppFrm-021' .omc/plans/attachment-verification-v6.md"
    assert not card_er_command_needs_block(cmd)


def test_targets_only_markdown_false_when_any_redirect_target_is_not_md():
    assert not targets_only_markdown("cat x.py > out.py")
    assert not targets_only_markdown("echo hi")  # no redirect at all


# 2026-10-12 bypass found by probe: a redirect to .md does not mean nothing executed.
# The exemption must require BOTH "every redirect target is .md" AND "no executor
# token anywhere in the command" - five required cases below.

def test_exec_script_redirected_to_md_is_blocked_not_exempted():
    cmd = "uv run python submit_ai4sci_registration_er.py > /tmp/log.md"
    assert not targets_only_markdown(cmd)


def test_python_dash_c_redirected_to_md_is_blocked_not_exempted():
    cmd = (
        'python3 -c "url=\'AppFrm-021&mker=Y\'; form1.submit(" > /tmp/o.md'
    )
    assert not targets_only_markdown(cmd)
    assert card_er_command_needs_block(cmd)


def test_plain_script_execution_redirected_to_md_is_blocked_not_exempted():
    cmd = "./submit_ai4sci_registration_er.py > /tmp/o.md"
    assert not targets_only_markdown(cmd)


def test_cat_heredoc_into_md_with_no_executor_passes():
    cmd = (
        "cat > plan.md <<'MD'\n"
        "form1.submit() after Check_Form_Request(, mker=Y on AppFrm-021.\n"
        "MD\n"
    )
    assert targets_only_markdown(cmd)


def test_python_heredoc_piped_to_tee_md_is_blocked_not_exempted():
    cmd = (
        "python - <<'EOF' | tee /tmp/o.md\n"
        "url = 'AppFrm-021&mker=Y'\n"
        "form1.submit(\n"
        "EOF\n"
    )
    assert not targets_only_markdown(cmd)
    assert card_er_command_needs_block(cmd)
