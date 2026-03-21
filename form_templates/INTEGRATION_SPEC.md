# Form Template Integration Spec

How `form_templates/*.json` + `traveler_profiles.json` drive `ipk_gw.py` form submission.

## Data Flow

```
User Input (minimal)          form_templates/AppFrm-XXX.json
       │                                │
       ▼                                ▼
┌─────────────┐    ┌──────────────────────────────┐
│ User params │    │ Template:                     │
│ - form_type │    │   fixed_fields (always same)  │
│ - dates     │    │   field_schema (all fields)   │
│ - purpose   │    │   inference_rules             │
│ - BC#       │    │   ajax_cascade_sequence       │
│             │    │   city_transport_lookup        │
└──────┬──────┘    └──────────────┬───────────────┘
       │                          │
       ▼                          ▼
┌──────────────────────────────────────┐
│         Inference Engine             │
│                                      │
│ 1. Load template for form_type       │
│ 2. Apply fixed_fields directly       │
│ 3. Load traveler profile             │
│ 4. Apply inference_rules:            │
│    - destination → transport_method  │
│    - nights → daily_expense          │
│    - BC# → budget_account (lookup)   │
│    - writer → corp_card (soft default)│
│ 5. Merge user overrides              │
│ 6. Return complete field_values      │
└──────────────┬───────────────────────┘
               │
               ▼
┌──────────────────────────────────────┐
│      ipk_gw.py Form Filler          │
│                                      │
│ 1. Navigate to form write page       │
│ 2. Execute AJAX cascades in order    │
│ 3. Fill fields using form_utils:     │
│    - set_field() for text inputs     │
│    - set_select() for dropdowns      │
│    - set_radio() for radio buttons   │
│ 4. Trigger dependent field updates   │
│ 5. Validate before submission        │
└──────────────────────────────────────┘
```

## Template Schema

Each `form_templates/AppFrm-XXX.json`:

```json
{
  "form_code": "AppFrm-XXX",
  "form_name": "human readable name",
  "fixed_fields": {
    "field_name": "always_this_value"
  },
  "field_schema": {
    "field_name": {
      "type": "text|select|radio|hidden",
      "required": true,
      "source": "user_input|inference|fixed|profile",
      "html_name": "actual HTML input name attribute"
    }
  },
  "inference_rules": [
    {
      "if_field": "destination",
      "contains": "Seoul",
      "then_set": "transport_method",
      "to": "Public Transportation"
    }
  ],
  "ajax_cascade_sequence": [
    {
      "trigger_field": "budget_type",
      "trigger_event": "change",
      "populates": ["account_code", "budget_account"],
      "wait_ms": 1000
    }
  ]
}
```

## Traveler Profile Schema

`analysis_results/traveler_profiles.json`:

```json
{
  "Writer Name": {
    "total_docs": 43,
    "low_confidence": false,
    "corp_card": {
      "default": "5525-xxxx-xxxx-xxxx",
      "confidence": 0.95,
      "soft_default": true
    },
    "budget_accounts": [
      {"account": "R&D - ...", "frequency": 30, "recency_score": 0.8}
    ],
    "typical_destinations": ["Seoul", "Daejeon"],
    "travel_type_distribution": {"conference": 0.47, "visit": 0.44}
  }
}
```

## Inference Priority

When multiple sources provide a value, priority order:

1. **User explicit input** (always wins)
2. **Deterministic lookup** (BC# → budget_account)
3. **Inference rule** (destination → transport)
4. **Traveler profile** (corp_card soft default)
5. **Template fixed value** (retention=5yr)

## AJAX Cascade Handling

Some fields trigger server-side lookups that populate other fields. These must be executed in order:

1. Set trigger field value
2. Dispatch `change` event
3. Wait for AJAX response (poll for populated field)
4. Continue to next cascade

Example for travel_request:
```
budget_type (R&D/General) → triggers account_code population
BC# input → triggers budget_account lookup
```

## Per-Form Integration Notes

### AppFrm-023 (Travel Request)
- Reference implementation: `submit_rapid_q1_travel_request.py`
- Complex AJAX cascades for budget fields
- 3 subtypes: day-trip, overnight, PI-submitted
- Corp card is shared lab resource (soft default)

### AppFrm-073 (Leave)
- Simpler form: leave_type, dates, reason, substitute
- Substitute info from credentials/profile
- Leave type determines available date ranges

### AppFrm-027 (Working / Schedule Change)
- Simple: date, time range, reason, work_type
- Few inference rules needed

### AppFrm-076 (Travel Report)
- Links to AppFrm-023 travel request
- Cross-reference: can pre-fill from matching travel request doc
- Expense summary fields

## Implementation Plan

1. Add `load_template(form_code)` to ipk_gw.py
2. Add `infer_fields(template, profile, user_input)` engine
3. Add `fill_form(form_code, field_values)` generic filler using form_utils
4. Each form type gets a thin wrapper calling the generic pipeline
5. Migrate `submit_rapid_q1_travel_request.py` to use generic pipeline as proof
