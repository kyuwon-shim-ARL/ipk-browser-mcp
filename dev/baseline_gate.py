"""
Baseline gate: hold a draft to what colleagues have already had approved.

Before a script saves a draft it calls `gate(gw, kind, fields)`. The gate collects
approved documents of the same kind written by colleagues (never the user's own: on
2026-10-06 the user's own KMB report was the only reference, and the AI4Sci draft came
out 2-4x longer than every colleague's), measures each free-text field, and refuses
the draft when a field is longer than the colleagues' 75th percentile, or carries a
budget code no colleague writes in that field.

Too few precedents is BaselineUnavailable, not a pass: an unchecked draft is not a
checked one. Forms with no free text to compare call `skip(kind, reason)` instead,
which is logged. scripts/hooks/require_baseline_gate.py refuses to run a saving
script that does neither.

Only lengths and a has-budget-code flag are cached (data/baselines/<kind>.json);
colleagues' text is not stored.
"""

from __future__ import annotations

import hashlib
import json
import re
import time
import unicodedata
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = ROOT / "data" / "baselines"
OVERRIDE_LOG = ROOT / ".omc" / "state" / "rule-overrides.log"

MIN_PRECEDENTS = 5
# NN2606-0001 and the ways it gets written: next to Hangul, en dash, spaces, lower case.
BUDGET_CODE = re.compile(r"(?<![A-Za-z0-9])[A-Za-z]{2}\s?\d{4}\s?[-\u2010-\u2015_]\s?\d{3,4}(?!\d)")
CODED_MIN_DOCS = 2  # a budget code is accepted in a field once at least this many colleagues write one there


def _norm(s: str) -> str:
    """One unit for both sides: innerText of the view vs textarea.value of the draft."""
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", s or "")).strip()


def _len(s: str) -> int:
    return len(_norm(s))


class BaselineViolation(Exception):
    """The draft departs from what colleagues had approved."""


class BaselineUnavailable(Exception):
    """No usable baseline: the draft was NOT checked."""


@dataclass
class Baseline:
    kind: str
    doc_ids: list[str]
    lengths: dict[str, list[int]]
    texts_with_codes: set[str] = field(default_factory=set)  # fields where >= CODED_MIN_DOCS colleagues wrote a budget code
    fetched: str = ""
    me: str = ""
    excluded: list[str] = field(default_factory=list)  # own doc_ids left out
    parser: str = ""


# ------------------------------------------------------------------ domestic travel report

# (start label, end label, use last occurrence of start)
_REPORT_SECTIONS = {
    "purpose_field": ("Travel Purpose", "\nItinerary", False),
    "itinerary": ("Itinerary\n", "\n2. Travel Details", False),
    "agenda_field": ("meeting agendas.", "Meeting/Conference details", False),
    "result_field": ("Meeting/Conference details", "Others (Activities", False),
    "other_field": ("business travel purpose, etc.)", "3. Implications", False),
    "conclusion_field": ("Implications and remarks", "* Whether", True),
}

# report form fields that are rendered together as the itinerary table
_ITINERARY_FIELDS = ("date_field", "org_field", "person_field", "discuss_field")
_ITINERARY_HEADER = "Date\tOrganization to visit\tPerson to Meet / Contact information\tAgenda(s) to discuss"
# fields of the form that are not free text; any other key the gate does not know is refused
_REPORT_NON_TEXT = {"report_date", "report_name", "report_post", "report_group", "report_leader", "report_dest", "gift_p", "gift_r"}


def parse_domestic_report(text: str) -> dict[str, str]:
    """Sections of travel_report_view.php innerText; {} when the page holds no report."""
    if not re.search(r"Date of Report\s+20\d\d-\d\d-\d\d", text):
        return {}
    out = {}
    for name, (start, end, last) in _REPORT_SECTIONS.items():
        i = text.rfind(start) if last else text.find(start)
        if i < 0:
            continue
        j = text.find(end, i + len(start))
        if j < 0:
            continue
        v = text[i + len(start):j].strip()
        if name == "itinerary" and v.startswith(_ITINERARY_HEADER):
            v = v[len(_ITINERARY_HEADER):].strip()
        out[name] = v
    return out


def draft_lengths(fields: dict[str, str]) -> dict[str, int]:
    """Lengths in the same units as the baseline: itinerary columns count as one figure."""
    out = {k: _len(v) for k, v in fields.items() if k in _REPORT_SECTIONS}
    itin = [fields[k] for k in _ITINERARY_FIELDS if k in fields]
    if itin:
        out["itinerary"] = sum(_len(v) for v in itin)
    return out


def whoami(gw) -> str:
    fr = gw.page.frame("main_menu")
    fr.goto(f"{gw.BASE_URL}/Document/document_list.php?type=approved", wait_until="networkidle")
    m = re.search(r"Welcome,\s*(.+?)\s+Approved", fr.evaluate("() => document.body.innerText"))
    if not m:
        raise BaselineUnavailable("could not read the logged-in user's name; cannot exclude own documents")
    return m.group(1).strip()


def _fetch_domestic_report_texts(gw, me: str, keywords=("conference", "symposium", "meeting", "congress"),
                                 since_days=730) -> tuple[dict[str, str], list[str]]:
    """(colleague doc_id -> report page text, own doc_ids left out)."""
    base = gw.BASE_URL
    fr = gw.page.frame("main_menu")
    e = date.today()
    s = e - timedelta(days=since_days)
    rows: dict[str, str] = {}  # doc_id -> writer cell
    for kw in keywords:
        for p in range(1, 6):
            fr.goto(
                f"{base}/Document/document_list.php?type=groupapproved&s_date={s}&e_date={e}"
                f"&keyword={kw}&writer=Y&title=Y&contents=Y&attachment=Y&start_page={p}",
                wait_until="networkidle",
            )
            time.sleep(0.8)
            # columns on document_list.php: doc no, subject, department, writer, status, date
            found = fr.evaluate(
                """() => [...document.querySelectorAll('tr')]
                    .filter(tr => /approve_type=AppFrm-023/.test(tr.innerHTML))
                    .map(tr => [(tr.innerHTML.match(/doc_id=(\\d+)/) || [])[1],
                                ((tr.querySelectorAll('td')[3] || {}).innerText || '').replace(/\\s+/g, ' ').trim()])"""
            )
            if not found:
                break
            for doc_id, row in found:
                if doc_id:
                    rows[doc_id] = row
    own = sorted(d for d, w in rows.items() if w == me)
    if not own:
        # the user writes these reports too; none matched means the writer column was misread
        raise BaselineUnavailable(f"no document matched writer '{me}' exactly; own documents could not be excluded")
    pg = gw.context.new_page()
    texts = {}
    try:
        for doc_id, writer in rows.items():
            if doc_id in own or not writer:
                continue
            pg.goto(f"{base}/Document/travel_report_view.php?doc_id={doc_id}&pop=Y&approve_type=AppFrm-023",
                    wait_until="networkidle", timeout=30000)
            texts[doc_id] = pg.evaluate("() => document.body.innerText")
    finally:
        pg.close()
    return texts, own


KINDS = {
    "domestic_travel_report": (_fetch_domestic_report_texts, parse_domestic_report, _REPORT_NON_TEXT),
}


def _parser_version(kind: str) -> str:
    import inspect
    src = inspect.getsource(KINDS[kind][1]) + repr(_REPORT_SECTIONS) + _ITINERARY_HEADER + inspect.getsource(_norm)
    return hashlib.sha1(src.encode()).hexdigest()[:12]


# ------------------------------------------------------------------ baseline + check


def baseline_from_texts(kind: str, texts: dict[str, str]) -> Baseline:
    parse = KINDS[kind][1]
    ids, lengths, coded_n = [], {}, {}
    for doc_id, text in sorted(texts.items()):
        f = parse(text)
        if not f:
            continue
        ids.append(doc_id)
        for name, v in f.items():
            lengths.setdefault(name, []).append(_len(v))
            if BUDGET_CODE.search(_norm(v)):
                coded_n[name] = coded_n.get(name, 0) + 1
    coded = {k for k, n in coded_n.items() if n >= CODED_MIN_DOCS}
    return Baseline(kind=kind, doc_ids=ids, lengths=lengths, texts_with_codes=coded,
                    fetched=datetime.now().isoformat(timespec="seconds"), parser=_parser_version(kind))


def _p75(v: list[int]) -> int:
    s = sorted(v)
    return s[int(len(s) * 0.75)]


def check(fields: dict[str, str], b: Baseline, min_n: int = MIN_PRECEDENTS) -> list[str]:
    """Violations of `fields` against `b`; raises BaselineUnavailable when `b` is too thin."""
    if len(b.doc_ids) < min_n:
        raise BaselineUnavailable(
            f"{b.kind}: only {len(b.doc_ids)} colleague precedent(s), need {min_n}. The draft was not checked."
        )
    non_text = KINDS[b.kind][2] if b.kind in KINDS else set()
    unknown = sorted(k for k in fields if k not in non_text and k not in _REPORT_SECTIONS and k not in _ITINERARY_FIELDS)
    if unknown:
        raise BaselineUnavailable(f"{b.kind}: no baseline for field(s) {unknown}. The draft was not checked.")
    out = []
    for name, n in draft_lengths(fields).items():
        v = b.lengths.get(name) or []
        if len(v) < min_n:
            raise BaselineUnavailable(f"{b.kind}: field {name} has {len(v)} colleague precedent(s), need {min_n}.")
        limit = _p75(v)
        if n > limit:
            out.append(f"{name}: {n} chars > colleague p75 {limit} (median {sorted(v)[len(v) // 2]}, n={len(v)})")
    for name, text in fields.items():
        if name in _ITINERARY_FIELDS:
            name = "itinerary"
        for code in BUDGET_CODE.findall(_norm(text)):
            if name not in b.texts_with_codes:
                out.append(f"{name}: budget code {code} - no colleague writes a budget code in this field")
    return out


# ------------------------------------------------------------------ entry points for scripts


def _load(kind: str, me: str, max_age_days: int) -> Baseline | None:
    """Cached baseline, unless stale, thin, built for another user, or by another parser."""
    p = CACHE_DIR / f"{kind}.json"
    if not p.exists():
        return None
    d = json.loads(p.read_text())
    if (datetime.now() - datetime.fromisoformat(d["fetched"]) > timedelta(days=max_age_days)
            or d.get("me") != me or d.get("parser") != _parser_version(kind)
            or len(d["doc_ids"]) < MIN_PRECEDENTS):
        return None
    return Baseline(kind=d["kind"], doc_ids=d["doc_ids"], lengths=d["lengths"],
                    texts_with_codes=set(d["texts_with_codes"]), fetched=d["fetched"],
                    me=d["me"], excluded=d.get("excluded", []), parser=d["parser"])


def _save(b: Baseline) -> None:
    if len(b.doc_ids) < MIN_PRECEDENTS:
        return  # a thin fetch is retried next time, not trusted for 30 days
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    (CACHE_DIR / f"{b.kind}.json").write_text(json.dumps(
        {"kind": b.kind, "doc_ids": b.doc_ids, "lengths": b.lengths, "texts_with_codes": sorted(b.texts_with_codes),
         "fetched": b.fetched, "me": b.me, "excluded": b.excluded, "parser": b.parser}, indent=1))


def gate(gw, kind: str, fields: dict[str, str], refresh: bool = False, max_age_days: int = 30) -> Baseline:
    """Call before saving a draft. Raises BaselineViolation / BaselineUnavailable; returns the baseline used."""
    if kind not in KINDS:
        from form_rules import check_rules, load_rulebook  # form_rules imports this module

        book = load_rulebook(kind)  # raises BaselineUnavailable when there is none
        v = check_rules(book, fields)
        print(f"[baseline] {kind}: rulebook form_rules/{kind}.json ({book.get('inferred', {}).get('date', '?')})")
        if v:
            raise BaselineViolation("draft breaks the form's rulebook:\n  " + "\n  ".join(v))
        print("[baseline] pass")
        return book
    me = whoami(gw)
    b = None if refresh else _load(kind, me, max_age_days)
    if b is None:
        texts, own = KINDS[kind][0](gw, me)
        b = baseline_from_texts(kind, texts)
        b.me, b.excluded = me, own
        _save(b)
    print(f"[baseline] {kind}: {len(b.doc_ids)} colleague precedents (fetched {b.fetched[:10]}, "
          f"{len(b.excluded)} own excluded): {', '.join(b.doc_ids)}")
    v = check(fields, b)
    if v:
        raise BaselineViolation("draft departs from colleagues' approved documents:\n  " + "\n  ".join(v))
    print("[baseline] pass")
    return b


def skip(kind: str, reason: str) -> None:
    """For a form with nothing to compare. Logged, so a skip is visible later."""
    if not reason.strip():
        raise ValueError("skip() needs a reason")
    OVERRIDE_LOG.parent.mkdir(parents=True, exist_ok=True)
    with OVERRIDE_LOG.open("a") as f:
        f.write(f"{datetime.now().isoformat(timespec='seconds')}\tbaseline_gate.skip\t{kind}\t{reason}\n")
    print(f"[baseline] SKIPPED for {kind}: {reason}")
