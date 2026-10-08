/**
 * Per-field rulebooks: TypeScript port of dev/form_rules.py's check_rules(), run inside
 * the MCP server right before a form is saved (see ipk-submit.ts, next to checkOrgPolicy).
 *
 * org-policy.ts checks *procedure* (English-only, draft-first, ...); this file checks the
 * content of individual fields against office/personal practice inferred from approved
 * documents (form_rules/<AppFrm>.json, local and gitignored - a plugin user never has
 * them). What ships in the plugin is the shareable slice, rules/public/<AppFrm>.json
 * (scripts/extract_public_rules.py), where a field this user cannot see the practice for
 * becomes a valueless stub:
 *
 *   {scope: "self", source: "profile",    on_missing: "block"}  - ask the person; never
 *     guess a card number or budget code from someone else's precedent (shared-knowledge-v4 B2).
 *   {scope: "org",  source: "team-pack",  on_missing: "warn"}   - a private pack (if the
 *     curator has shared one) or a team-derive lookup could decide this; absent either,
 *     warn rather than block - "no rule" (fail-closed, see FieldRulesUnavailable) is a
 *     different thing from "the rule exists but isn't shared here" (warn).
 *
 * A field with no rule entry at all (not in `fields`, not in `ignore`) is unavailable, not
 * passed - an unchecked field is not a checked one (same principle as baseline_gate.py).
 */
import type { Profile } from "../profile/profile.js";
import { cardMatches } from "../profile/profile.js";

export interface Check {
  type: "pattern" | "max_len" | "min_len" | "english" | "one_of" | "fixed";
  regex?: string;
  max?: number;
  min?: number;
  values?: string[];
  value?: string;
  form_values?: Record<string, string>;
}

export interface RuleField {
  label?: string;
  scope: "org" | "self" | "case";
  checks?: Check[];
  why?: string;
  evidence?: string[];
  visibility?: "public" | "private" | "local";
  dept?: string;
  fiscal_year?: string | number;
  valid_until?: string | number;
  /** Present on a stub field (rules/public/ output for a non-public field). */
  source?: "profile" | "team-derive" | "team-pack";
  on_missing?: "block" | "warn";
}

export interface Conditional {
  when: { field: string; regex: string };
  then: { field: string; value: string; form_values?: Record<string, string> };
  why?: string;
  evidence?: string[];
  visibility?: "public" | "private" | "local";
}

export interface Rulebook {
  form: string;
  title?: string;
  schema_version: number;
  fields: Record<string, RuleField>;
  conditional?: Conditional[];
  ignore?: string[];
}

export interface FieldRuleViolation {
  field: string;
  scope: string;
  message: string;
}

export interface FieldRuleResult {
  blocks: FieldRuleViolation[];
  warnings: FieldRuleViolation[];
}

export class FieldRulesUnavailable extends Error {}

const HANGUL = /[ᄀ-ᇿ㄰-㆏ꥠ-꥿가-힯ힰ-퟿]/;

/** form_rules/*.json regexes are written for Python's re (inline `(?i)` flag), which JS's
 *  RegExp does not accept - translate to the `i` flag so the same rulebook JSON works in
 *  both ports. */
function toRegExp(pattern: string): RegExp {
  const m = /^\(\?i\)/.exec(pattern);
  return m ? new RegExp(pattern.slice(m[0].length), "i") : new RegExp(pattern);
}

function runCheck(c: Check, rawValue: string): string | null {
  const v = c.form_values?.[rawValue] ?? rawValue;
  switch (c.type) {
    case "pattern":
      if (!toRegExp(c.regex!).test(v)) return `pattern /${c.regex}/ not matched`;
      return null;
    case "max_len":
      if (v.length > c.max!) return `max_len ${c.max} exceeded (${v.length})`;
      return null;
    case "min_len":
      if (v.length < c.min!) return `min_len ${c.min} not reached (${v.length})`;
      return null;
    case "english":
      if (HANGUL.test(v)) return "english: contains Hangul";
      return null;
    case "one_of":
      if (!c.values!.includes(v)) return `one_of: '${v}' not in ${JSON.stringify(c.values)}`;
      return null;
    case "fixed":
      if (v !== c.value) return `fixed: '${v}' != '${c.value}'`;
      return null;
  }
  return null;
}

export interface FieldRulesOptions {
  /** B4's profile.json. See HARD_SELF_FIELD_CHECKS/SOFT_SELF_FIELD_SOURCES below for
   *  which self-field DOM names map to which part of it. */
  profile?: Profile;
  /** The handler's own env fallbacks for self fields the person configures once rather
   *  than through profile.json (ipk-submit.ts already reads these same vars when it
   *  fills these fields - see IPK_GROUP_LEADER, IPK_SUBSTITUTE_NAME,
   *  IPK_EMERGENCY_ADDRESS, IPK_EMERGENCY_TELEPHONE). Passed in rather than read from
   *  process.env directly so this module stays a pure function. */
  env?: Partial<Record<"IPK_GROUP_LEADER" | "IPK_SUBSTITUTE_NAME" | "IPK_EMERGENCY_ADDRESS" | "IPK_EMERGENCY_TELEPHONE", string>>;
  /**
   * How to treat a field present in the draft but absent from `fields`/`ignore`:
   *   "block" (default) - fail-closed, exactly dev/form_rules.py's BaselineUnavailable.
   *     Right for a curator-controlled draft (the local full rulebook, scripted params):
   *     every field there was deliberately named.
   *   "warn"  - the plugin's actual DOM has fields no rulebook has caught up with yet
   *     (a form widget the colleague corpus never showed, a template row). Blocking a
   *     save over that would refuse everyone's draft the day the groupware adds a field.
   *     Used when the draft comes from serializing the live form (see iframe-helper.ts
   *     serializeFormFields + ipk-submit.ts checkFieldRulesAgainstForm).
   */
  unknownFields?: "block" | "warn";
}

function toValues(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

/**
 * Self-scope DOM fields split by how expensive getting them wrong is (B4, and the B4
 * follow-up: unmapped self fields blocking by default turned out to refuse everyone's
 * draft, every time, for fields nothing here can actually verify).
 *
 * HARD: wrong is expensive and hard to undo - a card charge or budget pot posting is a
 * financial document. No independent source (profile.json has no entry, or the DOM
 * value isn't in it) -> BLOCK. This is the only tier that still blocks on "not
 * configured".
 *
 * SOFT: a name/address/phone the groupware prints from this person's own settings
 * (approval line, substitute). Checkable only if the person has configured the one
 * source for it (profile.approval_line or the matching env var ipk-submit.ts itself
 * reads when filling the field) - configured-and-matches passes silently,
 * configured-and-differs blocks (that reads as the wrong person on the document),
 * NOT configured warns rather than blocking (nothing to check against yet, but nothing
 * says it's wrong either).
 *
 * Everything else self-scoped (budget_type, substitute_payroll/position/contact,
 * edu_member, ...) has no mapping at all - substitute_payroll/position/contact in
 * particular are the groupware's own lookup result for whatever substitute_name says,
 * not an independently-configurable fact, so there is nothing to compare them to.
 * These always WARN, never block (see the final else in checkFieldRules below).
 */
/** card_no/credit_card_no/copcard get their own check (CARD_SELF_FIELDS below), not this
 *  dict, because a card match needs to distinguish "not this person's card at all" from
 *  "a card on the list, but someone else's" (two different block messages). */
const HARD_SELF_FIELD_CHECKS: Record<string, (profile: Profile, values: string[]) => boolean> = {
  budget_code: (p, values) => values.every((v) => p.budget_pots.some((b) => b.code === v)),
};

/** card_no/credit_card_no/copcard: only a profile card with kind "own" satisfies this -
 *  a "shared" entry (corporation_card_list.php's Owner column named someone else) is
 *  recorded but never passes here on its own. Sharing a card for one account (the lab's
 *  Team Activities card) is handled by a form_rules conditional, not by this check -
 *  see checkFieldRules: a matching conditional puts the field in `decided` and this
 *  branch is skipped entirely for that row. */
const CARD_SELF_FIELDS = new Set(["card_no", "credit_card_no", "copcard"]);

function ownCardMatch(profile: Profile, values: string[]): boolean {
  return values.every((v) => profile.cards.some((c) => c.kind === "own" && cardMatches(c.number, v)));
}

/** "own-unconfirmed" still satisfies the HARD check (it is this person's own document,
 *  not someone else's) but is reported, not silent - see the dispatch site below. */
function unconfirmedOwnCardMatch(profile: Profile, values: string[]): boolean {
  return values.every((v) => profile.cards.some((c) => c.kind === "own-unconfirmed" && cardMatches(c.number, v)));
}

function matchesSomeoneElsesCard(profile: Profile, values: string[]): boolean {
  return values.some((v) => profile.cards.some((c) => c.kind === "shared" && cardMatches(c.number, v)));
}

const SOFT_SELF_FIELD_SOURCES: Record<string, (profile: Profile | undefined, env: FieldRulesOptions["env"]) => string | undefined> = {
  approver: (p, env) => p?.approval_line?.group_leader ?? env?.IPK_GROUP_LEADER,
  substitute_name: (p, env) => p?.approval_line?.substitute ?? env?.IPK_SUBSTITUTE_NAME,
  emergency_address: (_p, env) => env?.IPK_EMERGENCY_ADDRESS,
  emergency_telephone: (_p, env) => env?.IPK_EMERGENCY_TELEPHONE,
};

/**
 * Mirrors dev/form_rules.py check_rules(), plus stub handling for a rulebook that has no
 * private pack behind it (B2), and array-valued fields (DOM `name[]` repeating rows -
 * item_name[], account_str[], ... - each value is checked independently; see
 * iframe-helper.ts serializeFormFields, which is where draft values actually become
 * string[] rather than string).
 */
export function checkFieldRules(book: Rulebook, draft: Record<string, unknown>, options: FieldRulesOptions = {}): FieldRuleResult {
  const fields = book.fields ?? {};
  const ignore = new Set(book.ignore ?? []);
  const unknownMode = options.unknownFields ?? "block";

  const blocks: FieldRuleViolation[] = [];
  const warnings: FieldRuleViolation[] = [];

  const unknown = Object.keys(draft).filter((k) => !(k in fields) && !ignore.has(k));
  if (unknown.length > 0) {
    if (unknownMode === "block") {
      throw new FieldRulesUnavailable(`${book.form}: no rule for field(s) ${unknown.join(", ")}. The draft was not checked.`);
    }
    const nonEmpty = unknown.filter((k) => toValues(draft[k]).some((v) => v !== ""));
    if (nonEmpty.length > 0) {
      warnings.push({
        field: nonEmpty.join(", "),
        scope: "unknown",
        message: `no rule for field(s) ${nonEmpty.join(", ")} - not checked against office/personal practice (the rulebook may not have caught up with this form field yet)`,
      });
    }
  }

  const conditionals = book.conditional ?? [];
  const matched = conditionals.filter(
    (c) => c.when.field in draft && toValues(draft[c.when.field]).some((v) => toRegExp(c.when.regex).test(v))
  );
  const decided = new Set(matched.map((c) => c.then.field));

  for (const [name, value] of Object.entries(draft)) {
    const f = fields[name];
    if (!f || f.scope === "case" || decided.has(name)) continue;
    // A repeating-row field (name[]) carries one entry per table row, including unused
    // ones (a hidden template row, or a row the person never filled) - an empty slot is
    // not a fact to check, so it is dropped before any rule sees it.
    const values = toValues(value).filter((v) => v !== "");
    if (values.length === 0) continue;

    if (f.source) {
      // Stub field: no checks shipped here, only a scope + where a real check would come from.
      if (f.scope === "self") {
        if (CARD_SELF_FIELDS.has(name)) {
          if (!options.profile) {
            blocks.push({
              field: name, scope: f.scope,
              message: `${name} [self]: no profile loaded - ask the person; run ipk_profile_init to read your own cards from the groupware.`,
            });
          } else if (ownCardMatch(options.profile, values)) {
            // confirmed own - pass silently.
          } else if (unconfirmedOwnCardMatch(options.profile, values)) {
            warnings.push({
              field: name, scope: f.scope,
              message: `${name} [self]: this card appeared on only one of this person's own approved documents - not blocked, but unconfirmed (seen on <2 non-meeting approved AppFrm-021 docs). Re-run ipk_profile_init later to confirm it.`,
            });
          } else {
            const message = matchesSomeoneElsesCard(options.profile, values)
              ? `${name} [self]: this card belongs to someone else - ask the person; a shared card is only allowed where an explicit rule names it (e.g. the Team Activities account conditional).`
              : `${name} [self]: value not found in the profile - ask the person; never fill a self field from someone else's precedent.`;
            blocks.push({ field: name, scope: f.scope, message });
          }
        } else if (name in HARD_SELF_FIELD_CHECKS) {
          const check = HARD_SELF_FIELD_CHECKS[name];
          if (!options.profile) {
            blocks.push({
              field: name, scope: f.scope,
              message: `${name} [self]: no profile loaded - ask the person; run ipk_profile_init to read your own cards/budget pots from the groupware.`,
            });
          } else if (!check(options.profile, values)) {
            blocks.push({
              field: name, scope: f.scope,
              message: `${name} [self]: value not found in the profile - ask the person; never fill a self field from someone else's precedent.`,
            });
          }
        } else if (name in SOFT_SELF_FIELD_SOURCES) {
          const configured = SOFT_SELF_FIELD_SOURCES[name](options.profile, options.env);
          if (configured === undefined) {
            warnings.push({
              field: name, scope: f.scope,
              message: `${name} [self]: not independently verifiable yet - configure profile.approval_line or the matching env var (see ipk-submit.ts) to check this field.`,
            });
          } else if (!values.every((v) => v === configured)) {
            blocks.push({
              field: name, scope: f.scope,
              message: `${name} [self]: shows '${values.join(", ")}' but the configured value is '${configured}' - ask the person (this may be the wrong person on the document).`,
            });
          }
        } else {
          // No mapping at all (budget_type, substitute_payroll/position/contact,
          // edu_member, ...): nothing here can verify it, so it is reported, not blocked.
          warnings.push({
            field: name, scope: f.scope,
            message: `${name} [self]: no profile mapping defined for '${name}' yet - not verifiable, not blocked.`,
          });
        }
      } else {
        // org stub (team-derive / team-pack): no local source to check against -> warn, never block.
        warnings.push({
          field: name,
          scope: f.scope,
          message: `${name} [org]: no ${f.source} data available to check this field against office practice`,
        });
      }
      continue;
    }

    for (const c of f.checks ?? []) {
      for (const v of values) {
        const msg = runCheck(c, v);
        if (msg) blocks.push({ field: name, scope: f.scope, message: `${name} [${f.scope}]: ${msg}${f.why ? ` - ${f.why}` : ""}` });
      }
    }
  }

  for (const c of matched) {
    if (c.then.field in draft) {
      const got = toValues(draft[c.then.field]).filter((g) => g !== "");
      const mismatched = got.length > 0 && got.some((g) => (c.then.form_values?.[g] ?? g) !== c.then.value);
      if (mismatched) {
        blocks.push({
          field: c.then.field,
          scope: fields[c.then.field]?.scope ?? "org",
          message: `${c.then.field}: must be '${c.then.value}' when ${c.when.field} matches /${c.when.regex}/${c.why ? ` - ${c.why}` : ""}`,
        });
      }
    }
  }

  return { blocks, warnings };
}
