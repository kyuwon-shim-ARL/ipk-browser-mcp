"""
stdio JSON-RPC bridge for Python pipeline.
Reads JSON requests from stdin, processes, writes JSON responses to stdout.

Protocol:
  Request:  {"id": "1", "method": "infer_fields", "params": {"form_type": "...", "user_input": {...}, "writer": "..."}}
  Response: {"id": "1", "result": {...}}  or  {"id": "1", "error": "..."}

Methods:
  - infer_fields: load_template + load_traveler_profile + infer_fields
  - fill_form: infer_fields + fill_form (pipeline)
  - load_registry: return form-registry.json contents
"""
import sys
import json
import logging
from pipeline import load_template, load_traveler_profile, infer_fields, fill_form, load_registry

logging.basicConfig(level=logging.WARNING, stream=sys.stderr)


def handle_request(req: dict) -> dict:
    method = req.get("method")
    params = req.get("params", {})

    try:
        if method == "infer_fields":
            form_type = params.get("form_type")
            if not form_type:
                return _error(req, "INVALID_PARAMS", "Missing required param: form_type")
            user_input = params.get("user_input", {})
            writer = params.get("writer", "")
            template = load_template(form_type)
            if template is None:
                return _error(req, "TEMPLATE_NOT_FOUND", f"No template for form_type: {form_type}")
            profile = load_traveler_profile(writer) if writer else {}
            result = infer_fields(template, profile, user_input)
            return {"id": req.get("id"), "result": result}

        elif method == "fill_form":
            form_type = params.get("form_type")
            if not form_type:
                return _error(req, "INVALID_PARAMS", "Missing required param: form_type")
            user_input = params.get("user_input", {})
            writer = params.get("writer", "")
            template = load_template(form_type)
            if template is None:
                return _error(req, "TEMPLATE_NOT_FOUND", f"No template for form_type: {form_type}")
            profile = load_traveler_profile(writer) if writer else {}
            field_values = infer_fields(template, profile, user_input)
            result = fill_form(form_type, field_values)
            return {"id": req.get("id"), "result": result}

        elif method == "load_registry":
            return {"id": req.get("id"), "result": load_registry()}

        else:
            return _error(req, "UNKNOWN_METHOD", f"Unknown method: {method}")

    except KeyError as e:
        return _error(req, "INVALID_PARAMS", f"Missing param: {e}")
    except Exception as e:
        logging.exception("Bridge internal error")
        return _error(req, "INTERNAL_ERROR", str(e))


def _error(req: dict, code: str, message: str) -> dict:
    """Return a structured error response. Errors go to stdout as JSON; tracebacks to stderr."""
    return {"id": req.get("id"), "error": {"code": code, "message": message}}


def run_bridge():
    """Main bridge loop: read lines from stdin, write to stdout."""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            print(json.dumps({"id": None, "error": f"JSON parse error: {e}"}), flush=True)
            continue
        response = handle_request(req)
        print(json.dumps(response, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    run_bridge()
