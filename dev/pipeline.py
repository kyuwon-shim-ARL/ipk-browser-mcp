"""
Generic form pipeline for IPK groupware.
Implements: load_template → infer_fields → fill_form
See form_templates/INTEGRATION_SPEC.md for inference priority rules.
"""
import json
import os
from pathlib import Path
from typing import Any

# Project root relative paths
PROJECT_ROOT = Path(__file__).parent
FORM_REGISTRY_PATH = PROJECT_ROOT / "ipk-browser-mcp" / "src" / "form-registry.json"
FORM_TEMPLATES_DIR = PROJECT_ROOT / "form_templates"
TRAVELER_PROFILES_PATH = PROJECT_ROOT / "analysis_results" / "traveler_profiles.json"


def load_registry() -> dict:
    """Load form registry (form_type → appFrmCode, templateFile, status)."""
    with open(FORM_REGISTRY_PATH, encoding="utf-8") as f:
        return json.load(f)


def load_template(form_type: str) -> dict:
    """Load form template JSON for given form_type via form-registry.json."""
    registry = load_registry()
    entry = registry.get(form_type)
    if not entry:
        raise ValueError(f"Unknown form_type: {form_type}")
    template_file = FORM_TEMPLATES_DIR / entry["templateFile"]
    if not template_file.exists():
        raise FileNotFoundError(f"Template not found: {template_file}")
    with open(template_file, encoding="utf-8") as f:
        return json.load(f)


def load_traveler_profile(writer: str) -> dict:
    """Load traveler profile for given writer name."""
    if not TRAVELER_PROFILES_PATH.exists():
        return {}
    with open(TRAVELER_PROFILES_PATH, encoding="utf-8") as f:
        profiles = json.load(f)
    return profiles.get(writer, {})


def infer_fields(template: dict, profile: dict, user_input: dict) -> dict:
    """
    Infer complete field values from template + traveler profile + user input.

    Priority (INTEGRATION_SPEC.md):
    1. User explicit input (always wins)
    2. Deterministic lookup (BC# → budget_account)
    3. Inference rules (destination → transport)
    4. Traveler profile (corp_card soft default)
    5. Template fixed value
    """
    result: dict[str, Any] = {}

    # Priority 5: template fixed_fields
    for field, value in template.get("fixed_fields", {}).items():
        result[field] = value

    # Priority 4: traveler profile soft defaults
    if profile:
        corp_card = profile.get("corp_card", {})
        if corp_card.get("soft_default") and corp_card.get("default"):
            result.setdefault("corp_card", corp_card["default"])

        # Budget account: pick highest recency_score
        budget_accounts = profile.get("budget_accounts", [])
        if budget_accounts:
            best = max(budget_accounts, key=lambda x: x.get("recency_score", 0))
            result.setdefault("budget_account", best.get("account", ""))

    # Priority 3: inference rules
    for rule in template.get("inference_rules", []):
        if_field = rule.get("if_field")
        contains = rule.get("contains", "")
        then_set = rule.get("then_set")
        to = rule.get("to")
        if if_field and then_set and to:
            field_value = user_input.get(if_field, result.get(if_field, ""))
            if contains.lower() in str(field_value).lower():
                result.setdefault(then_set, to)

    # Priority 1: user explicit input (overrides everything)
    result.update(user_input)

    return result


def fill_form(form_type: str, field_values: dict) -> dict:
    """
    Fill and submit a form using the generic pipeline.
    Returns a result dict with success status.

    Note: actual Playwright execution is handled by ipk_gw.py.
    This function orchestrates the pipeline and delegates to ipk_gw.
    """
    try:
        template = load_template(form_type)
    except (ValueError, FileNotFoundError) as e:
        return {"success": False, "error": str(e)}

    registry = load_registry()
    entry = registry.get(form_type, {})
    status = entry.get("status", "unknown")

    if status == "stub":
        return {
            "success": False,
            "error": f"Form type '{form_type}' is not yet fully implemented. Status: stub.",
            "appFrmCode": entry.get("appFrmCode"),
        }

    return {
        "success": True,
        "form_type": form_type,
        "appFrmCode": entry.get("appFrmCode"),
        "field_values": field_values,
        "template_name": template.get("form_name", form_type),
    }
