#!/usr/bin/env python3
"""
Claude Code PreToolUse hook (Bash): refuse to run groupware code that saves a draft
without going through dev/baseline_gate.py (gate() or a logged skip()).

Checked: every script python (or uv run, or ./x.py) is asked to execute, and the command
text itself (heredoc / -c code). A submit_/fix_/attach_ script that cannot be found is
blocked rather than waved through. Exit 2 blocks and shows stderr to Claude.

This is an early warning, not a proof: code that saves from inside a module the script
imports is not seen unless it goes through the ipk_gw.submit_* helpers listed below.
"""

import ast
import io
import json
import re
import sys
import tokenize
from pathlib import Path

SAVE_MARKERS = re.compile(
    r"Check_Form\(|Check_Form_Request\(|form1\.submit\(|mode1'\)\.value"
    r"|\.submit_(?:leave|overtime_meal|work_request|travel_request)\("  # ipk_gw helpers that save
)
GATED = re.compile(r"\b(?:gate|skip)\(")
GATE_IMPORT = re.compile(r"\bbaseline_gate\b")
SCRIPT_NAMES = re.compile(r"^(?:submit|fix|attach)_")

_ARG = r"""(?:'([^']+\.py)'|"([^"]+\.py)"|([\w./-]+\.py)\b)"""
_INTERP = (
    r"""(?:^|(?<=[\s;&|("'`]))"""
    r"(?:uv\s+run(?:\s+python[\d.]*)?|(?:[\w.-]*/)*python[\d.]*)"
    r"(?:\s+-[XW]\s+\S+|\s+-(?!m\b)[A-Za-z]+)*\s+" + _ARG  # -m: what follows are the module's args
)
EXECUTED = re.compile(_INTERP + r"|(?:^|(?<=[\s;&|(]))(\./[\w./-]+\.py)\b")
INTERPRETER = re.compile(r"(?:^|[\s;&|(\"'`/])(?:python[\d.]*|uv\s+run)\b")


def _single_quoted_spans(cmd: str) -> list[tuple[int, int]]:
    return [m.span() for m in re.finditer(r"'[^']*'", cmd)]


def executed_scripts(cmd: str) -> list[str]:
    """Scripts the command runs; an interpreter that only appears inside a '...' payload does not count."""
    spans = _single_quoted_spans(cmd)
    out = []
    for m in EXECUTED.finditer(cmd):
        start = m.start()
        if any(a < start < b for a, b in spans):
            continue
        out.append(next(g for g in m.groups() if g))
    return out


def _code_without_comments_and_docstrings(text: str) -> str:
    try:
        toks = list(tokenize.generate_tokens(io.StringIO(text).readline))
    except (tokenize.TokenError, IndentationError, SyntaxError):
        return text
    keep, at_stmt_start = [], True
    for t in toks:
        if t.type == tokenize.COMMENT:
            continue
        if t.type == tokenize.STRING and at_stmt_start:
            continue  # a bare string statement: docstring
        if t.type not in (tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT):
            keep.append(t.string)
        at_stmt_start = t.type in (tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT, tokenize.NL) or (
            at_stmt_start and t.type == tokenize.STRING)
    return "".join(keep)  # no separator, so a helper call keeps its "obj.method(" shape


def _swallows(handler: ast.ExceptHandler) -> bool:
    if handler.type is None:
        return True
    names = [handler.type] if not isinstance(handler.type, ast.Tuple) else list(handler.type.elts)
    for n in names:
        name = n.attr if isinstance(n, ast.Attribute) else getattr(n, "id", "")
        if name in ("Exception", "BaseException", "BaselineViolation", "BaselineUnavailable"):
            return True
    return False


def _has_effective_gate(text: str) -> bool:
    """A gate()/skip() call bound to baseline_gate whose failure is not caught."""
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return bool(GATE_IMPORT.search(text) and GATED.search(text))
    modules, funcs = set(), set()
    for n in ast.walk(tree):
        if isinstance(n, ast.Import):
            modules |= {a.asname or a.name for a in n.names if a.name == "baseline_gate"}
        elif isinstance(n, ast.ImportFrom) and n.module == "baseline_gate":
            funcs |= {a.asname or a.name for a in n.names if a.name in ("gate", "skip")}

    def is_gate(call: ast.Call) -> bool:
        f = call.func
        if isinstance(f, ast.Attribute) and f.attr in ("gate", "skip"):
            return isinstance(f.value, ast.Name) and f.value.id in modules
        return isinstance(f, ast.Name) and f.id in funcs

    def visit(node, swallowed: bool) -> bool:
        if isinstance(node, ast.Call) and is_gate(node) and not swallowed:
            return True
        if isinstance(node, ast.Try):
            inner = swallowed or any(_swallows(h) for h in node.handlers)
            return any(visit(c, inner) for c in node.body) or any(
                visit(c, swallowed) for c in node.handlers + node.orelse + node.finalbody)
        return any(visit(c, swallowed) for c in ast.iter_child_nodes(node))

    return visit(tree, False)


def script_needs_block(text: str) -> bool:
    return bool(SAVE_MARKERS.search(_code_without_comments_and_docstrings(text))) and not _has_effective_gate(text)


def command_needs_block(cmd: str) -> bool:
    """Code written straight into the command (heredoc, -c)."""
    if not INTERPRETER.search(cmd) or not SAVE_MARKERS.search(cmd):
        return False
    return not (GATE_IMPORT.search(cmd) and GATED.search(cmd))


def resolve_script(token: str, cwd: Path, cmd: str) -> Path | None:
    p = Path(token)
    if p.is_absolute():
        return p if p.is_file() else None
    dirs = [cwd] + [cwd / d for d in re.findall(r"(?:^|[\s;&|(])(?:cd|pushd)\s+([^\s;&|)]+)", cmd)]
    for d in dirs:
        if (d / p).is_file():
            return d / p
    return None


def unresolved_blocks(scripts: list[str], cwd: Path, cmd: str) -> list[str]:
    return [s for s in scripts if resolve_script(s, cwd, cmd) is None and SCRIPT_NAMES.match(Path(s).name)]


def main() -> int:
    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0
    cmd = (data.get("tool_input") or {}).get("command", "")
    cwd = Path(data.get("cwd") or ".")
    problems = []
    scripts = executed_scripts(cmd)
    for s in scripts:
        p = resolve_script(s, cwd, cmd)
        if p and script_needs_block(p.read_text(errors="ignore")):
            problems.append(f"{p}: saves a draft without an uncaught baseline_gate.gate()/skip()")
    for s in unresolved_blocks(scripts, cwd, cmd):
        problems.append(f"{s}: script not found, so it could not be checked")
    if command_needs_block(cmd):
        problems.append("the command itself contains code that saves a draft without baseline_gate")
    if problems:
        print(
            "BLOCKED (baseline gate):\n  " + "\n  ".join(problems)
            + "\nCall baseline_gate.gate(gw, kind, fields) before saving (dev/baseline_gate.py) and let its "
            "exceptions stop the script, or baseline_gate.skip(kind, reason) for a form with nothing to compare.",
            file=sys.stderr,
        )
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
