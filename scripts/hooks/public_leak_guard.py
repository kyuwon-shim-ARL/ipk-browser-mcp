#!/usr/bin/env python3
"""
git pre-commit guard for this public repo: block a commit that would leak personal data.

Checks run on staged added/modified files only (git diff --cached, status A/M):
  1. A real-looking 16-digit card number (Visa/Mastercard prefix), except the dummy
     1234-5678-9012-3456 used everywhere in docs/tests.
  2. A masked card number (NNNN-XXXX-XXXX-NNNN) whose outer groups are real digits -
     only the fully-masked XXXX-XXXX-XXXX-XXXX form is allowed.
  3. A JSON object where most of >=3 keys look like a person's name (2-4 Hangul
     syllables, or capitalized "First Last" English) - e.g. a writer_profiles or
     substitute_lookup table.
  4. A NEW file (status A) outside the path allowlist for this repo.

Exit 2 and print the problems when any check fires; exit 0 otherwise. This is a local
warning, not a server-side guarantee - see CLAUDE.md "SSoT 게이트의 실제 강제력". It is
not installed as the repo's pre-commit hook automatically; see README.md Development.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent

CARD_RE = re.compile(r"\b[45][0-9]{3}-?[0-9]{4}-?[0-9]{4}-?[0-9]{4}\b")
DUMMY_CARD = "1234-5678-9012-3456"
MASKED_CARD_RE = re.compile(r"\b([0-9]{4})-((?:X|\*){4})-((?:X|\*){4})-([0-9]{4})\b")

HANGUL_NAME = r"[가-힣]{2,4}"
ENGLISH_NAME = r"[A-Z][a-z]+(?:[- ][A-Z][a-z]+)+"
NAME_KEY_RE = re.compile(rf"^(?:{HANGUL_NAME}|{ENGLISH_NAME})$")

# New (status A) files only; existing tracked files under dev/, docs/ etc. are left alone -
# they are needed by the local Python workflow and are not this guard's job (v4 A3 note:
# "allowlist는 신규·수정 경로에만 적용(dev/·docs/ 등 기존 추적 파일은 ... 강제 untrack 안 함)").
# Interpreted here as: the allowlist gates new files, so an existing dev/ script being
# edited is not blocked by path, only by the content checks above.
NEW_FILE_ALLOWLIST = (
    "ipk-browser-mcp/src/",
    "ipk-browser-mcp/test/",
    "ipk-browser-mcp/dist/",
    "ipk-browser-mcp/bench/",
    "form_templates/",
    "rules/public/",
    "test-fixtures/",
    "skills/",
    "scripts/",
    ".claude-plugin/",
    "docs/",
    "tests/",
    "dev/",
)
NEW_FILE_ALLOWLIST_FILES = (
    "README.md",
    "ARCHITECTURE.md",
    "CLAUDE.md",
    ".gitignore",
    "pyproject.toml",
    "uv.lock",
)


def card_number_violations(text: str) -> list[str]:
    return [m.group(0) for m in CARD_RE.finditer(text) if m.group(0).replace("-", "") != DUMMY_CARD.replace("-", "")]


DUMMY_CARD_OUTER = DUMMY_CARD.split("-")  # ["1234", "5678", "9012", "3456"]


def masked_card_violations(text: str) -> list[str]:
    out = []
    for m in MASKED_CARD_RE.finditer(text):
        first, last = m.group(1), m.group(4)
        if first == "XXXX" and last == "XXXX":
            continue  # fully masked - allowed
        if first == DUMMY_CARD_OUTER[0] and last == DUMMY_CARD_OUTER[3]:
            continue  # the dummy's own masked form (1234-XXXX-XXXX-3456) - not a real card
        out.append(m.group(0))
    return out


def _is_name_key(key: str) -> bool:
    return bool(NAME_KEY_RE.match(key.strip()))


def name_keyed_object_violations(text: str) -> list[str]:
    """Paths (as JSON Pointer-ish dotted keys) of objects whose keys are mostly person names."""
    try:
        data = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return []
    out: list[str] = []

    def walk(node, path: str):
        if isinstance(node, dict):
            keys = list(node.keys())
            if len(keys) >= 3:
                name_like = sum(1 for k in keys if _is_name_key(k))
                if name_like > len(keys) / 2:
                    out.append(path or "$")
            for k, v in node.items():
                walk(v, f"{path}.{k}" if path else k)
        elif isinstance(node, list):
            for i, v in enumerate(node):
                walk(v, f"{path}[{i}]")

    walk(data, "")
    return out


def path_allowed(path: str) -> bool:
    if path in NEW_FILE_ALLOWLIST_FILES:
        return True
    return any(path.startswith(prefix) for prefix in NEW_FILE_ALLOWLIST)


def staged_files() -> list[tuple[str, str]]:
    """[(status, path), ...] for staged added/modified files (git diff --cached)."""
    out = subprocess.run(
        ["git", "diff", "--cached", "--name-status", "--diff-filter=AM"],
        cwd=REPO_ROOT, capture_output=True, text=True, check=True,
    ).stdout
    result = []
    for line in out.splitlines():
        if not line.strip():
            continue
        status, path = line.split("\t", 1)
        result.append((status, path))
    return result


def staged_content(path: str) -> str:
    return subprocess.run(
        ["git", "show", f":{path}"], cwd=REPO_ROOT, capture_output=True, text=True, check=True,
    ).stdout


def check_file(status: str, path: str, text: str) -> list[str]:
    problems = []
    for card in card_number_violations(text):
        problems.append(f"{path}: real-looking card number {card} (use dummy {DUMMY_CARD})")
    for card in masked_card_violations(text):
        problems.append(f"{path}: masked card {card} still has real digits (use XXXX-XXXX-XXXX-XXXX)")
    if path.endswith(".json"):
        for p in name_keyed_object_violations(text):
            problems.append(f"{path}: object at '{p}' has mostly person-name keys")
    if status == "A" and not path_allowed(path):
        problems.append(f"{path}: new file outside the public-repo path allowlist")
    return problems


def main() -> int:
    problems = []
    for status, path in staged_files():
        try:
            text = staged_content(path)
        except (subprocess.CalledProcessError, UnicodeDecodeError):
            continue  # e.g. a binary file; not this guard's job
        problems.extend(check_file(status, path, text))
    if problems:
        print("BLOCKED (public leak guard):\n  " + "\n  ".join(problems), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
