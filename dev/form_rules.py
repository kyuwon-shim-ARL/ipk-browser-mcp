"""
Per-field rulebooks: what each field of a groupware form must contain, and whose
practice decides it.

Inferred from approved documents and kept in form_rules/<AppFrm-XXX>.json. Every field
has a scope:

  org   - the department's practice (colleagues): wording, format, account codes, VAT
  self  - assigned to this person: budget codes, card number, approval line
  case  - a fact of this one case (date, amount, place): taken from the evidence and
          never copied from an earlier document, so it is not compared

Copying colleagues wholesale is wrong for `self` fields (form_templates/AppFrm-020.json
fixed another person's card number), and copying the user's own documents is wrong for
`org` fields (the AI4Sci report, 2026-10-06). The scope says which applies.

check_rules() returns violations; a draft field with no rule raises BaselineUnavailable,
because an unchecked field is not a checked one.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from baseline_gate import BaselineUnavailable

RULES_DIR = Path(__file__).resolve().parent.parent / "form_rules"
SCOPES = {"org", "self", "case"}
CHECK_TYPES = {"pattern", "max_len", "min_len", "english", "one_of", "fixed"}
HANGUL = re.compile(r"[가-힣ㄱ-ㆎ]")


def load_rulebook(form: str) -> dict:
    p = RULES_DIR / f"{form}.json"
    if not p.exists():
        raise BaselineUnavailable(f"no rulebook for {form} (form_rules/{form}.json)")
    return json.loads(p.read_text())


def validate_rulebook(book: dict) -> list[str]:
    errs = []
    for name, f in book.get("fields", {}).items():
        if f.get("scope") not in SCOPES:
            errs.append(f"{name}: scope '{f.get('scope')}' not in {sorted(SCOPES)}")
        for c in f.get("checks", []):
            if c.get("type") not in CHECK_TYPES:
                errs.append(f"{name}: check type '{c.get('type')}' not in {sorted(CHECK_TYPES)}")
        if f.get("scope") in ("org", "self") and f.get("checks") and not f.get("evidence"):
            errs.append(f"{name}: an {f['scope']} rule needs evidence (doc ids)")
    for i, c in enumerate(book.get("conditional", [])):
        if c.get("then", {}).get("field") not in book.get("fields", {}):
            errs.append(f"conditional[{i}]: then.field is not a field of the form")
    return errs


def _check(c: dict, v: str) -> str | None:
    t = c["type"]
    v = c.get("form_values", {}).get(v, v)  # a select's form value ("01") -> the label the view shows ("Transfer")
    if t == "pattern" and not re.search(c["regex"], v):
        return f"pattern /{c['regex']}/ not matched"
    if t == "max_len" and len(v) > c["max"]:
        return f"max_len {c['max']} exceeded ({len(v)})"
    if t == "min_len" and len(v) < c["min"]:
        return f"min_len {c['min']} not reached ({len(v)})"
    if t == "english" and HANGUL.search(v):
        return "english: contains Hangul"
    if t == "one_of" and v not in c["values"]:
        return f"one_of: '{v}' not in {c['values']}"
    if t == "fixed" and v != c["value"]:
        return f"fixed: '{v}' != '{c['value']}'"
    return None


def check_rules(book: dict, draft: dict[str, str]) -> list[str]:
    fields, ignore = book.get("fields", {}), set(book.get("ignore", []))
    unknown = sorted(k for k in draft if k not in fields and k not in ignore)
    if unknown:
        raise BaselineUnavailable(f"{book['form']}: no rule for field(s) {unknown}. The draft was not checked.")
    matched = [c for c in book.get("conditional", [])
               if c["when"]["field"] in draft and re.search(c["when"]["regex"], str(draft[c["when"]["field"]]))]
    decided = {c["then"]["field"] for c in matched}  # a specific rule overrides the field's general checks
    out = []
    for name, value in draft.items():
        f = fields.get(name)
        if not f or f["scope"] == "case" or name in decided:
            continue
        for c in f.get("checks", []):
            msg = _check(c, str(value))
            if msg:
                out.append(f"{name} [{f['scope']}]: {msg} - {f.get('why', '')}".rstrip(" -"))
    for c in matched:
        w, t = c["when"], c["then"]
        if t["field"] in draft:
            got = str(draft[t["field"]])
            if t.get("form_values", {}).get(got, got) != t["value"]:
                out.append(f"{t['field']}: must be '{t['value']}' when {w['field']} matches /{w['regex']}/ - {c.get('why', '')}")
    return out
