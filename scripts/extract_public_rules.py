#!/usr/bin/env python3
"""
Extract the shareable slice of each local form_rules/<AppFrm>.json into
rules/public/<AppFrm>.json (committed; see shared-knowledge-v4 B1).

form_rules/ is gitignored and may name colleagues or carry pot/project identifiers
(`why`/`evidence` text written for the curator, not for distribution). rules/public/
ships in the plugin, so it keeps only what `visibility: "public"` field/conditional
entries allow, and turns everything else into a valueless stub that still lets
check_rules() recognise the field name (so a draft with that field is not an
"unknown field" BaselineUnavailable) without carrying any checkable value or sensitive
text:

  org,  visibility != public  -> {"scope": "org",  "source": "team-pack", "on_missing": "warn"}
  self (always local)         -> {"scope": "self", "source": "profile",   "on_missing": "block"}
  case                        -> kept as-is (never compared to precedent, so never secret)

Run: python3 scripts/extract_public_rules.py [AppFrm-021 ...]   (default: all rulebooks)
Then: python3 scripts/hooks/public_leak_guard.py  (after `git add -N rules/public/`)
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "dev"))

from form_rules import RULES_DIR, load_rulebook, validate_rulebook  # noqa: E402

PUBLIC_DIR = ROOT / "rules" / "public"


def _field_stub(name: str, f: dict) -> dict:
    stub = {"source": "profile" if f["scope"] == "self" else "team-pack",
            "on_missing": "block" if f["scope"] == "self" else "warn",
            "scope": f["scope"]}
    if f.get("label"):
        stub["label"] = f["label"]
    # key order to match the plan's literal shape: label, scope, source, on_missing
    return {k: stub[k] for k in ("label", "scope", "source", "on_missing") if k in stub}


def extract(book: dict) -> dict:
    errs = validate_rulebook(book)
    if errs:
        raise ValueError(f"{book.get('form')}: cannot extract an invalid rulebook: {errs}")

    out_fields = {}
    for name, f in book.get("fields", {}).items():
        if f["scope"] == "case":
            out_fields[name] = dict(f)  # never compared, never secret - pass through
        elif f["scope"] == "org" and f.get("visibility") == "public":
            out_fields[name] = dict(f)
        else:  # org/local-or-private, or self (always local)
            out_fields[name] = _field_stub(name, f)

    out_conditional = [dict(c) for c in book.get("conditional", []) if c.get("visibility") == "public"]

    out = {
        "form": book["form"],
        "title": book.get("title", ""),
        "schema_version": book["schema_version"],
        "fields": out_fields,
        "conditional": out_conditional,
    }
    if book.get("ignore"):
        out["ignore"] = list(book["ignore"])
    return out


def main(argv: list[str]) -> int:
    forms = argv or [p.stem for p in sorted(RULES_DIR.glob("AppFrm-*.json"))]
    PUBLIC_DIR.mkdir(parents=True, exist_ok=True)
    for form in forms:
        out = extract(load_rulebook(form))
        dest = PUBLIC_DIR / f"{form}.json"
        dest.write_text(json.dumps(out, indent=1, ensure_ascii=False, sort_keys=False) + "\n")
        print("wrote", dest.relative_to(ROOT))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
