/**
 * `ipk_action`: one MCP tool with a frozen schema that dispatches to an action registry.
 *
 * A client caches each tool's parameters and description at connect time and only refreshes
 * them on /mcp reconnect, so a new or changed tool parameter is invisible to it until then.
 * `ipk_action` sidesteps that: its schema ({ action, args }) and description never change,
 * and every action validates `args` with its own zod schema here, in the hot-reloaded handlers
 * bundle. Adding or changing an action needs only an edit to handlers.ts and `npm run build`.
 *
 * Each action reuses an existing tool's zod shape and handler function, so the safety checks
 * (org policy, field rules, authorization files, draft-only defaults) are the same code
 * whichever way it is called. Only imported by handlers.ts; never by the shim.
 */
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { textResult } from "./util.js";

export interface ActionDef {
  name: string;
  /** One line, shown in the `help` listing. */
  purpose: string;
  /** The full description of the underlying tool, shown by `help` for one action. */
  description: string;
  /** zod raw shape, the same object the matching individual tool registers. */
  schema: Record<string, unknown>;
  /** Safety notes worth seeing before the call (authorization files, refusals). */
  safety?: string[];
  handler: (ctx: any, params: any) => Promise<any>;
}

export type ActionRegistry = Record<string, ActionDef>;

export const IPK_ACTION_NAME = "ipk_action";

/** Frozen. Changing this or IPK_ACTION_SCHEMA makes every client need a /mcp reconnect. */
export const IPK_ACTION_DESCRIPTION =
  "Run one IPK groupware action by name. The list of actions and their args changes without a reconnect: " +
  "call ipk_action {action:'help'} for the current list of actions and their args " +
  "(or {action:'help', args:{action:'<name>'}} for one). Every action applies the same safety checks as its individual ipk_* tool.";

/** Frozen, see IPK_ACTION_DESCRIPTION. */
export const IPK_ACTION_SCHEMA = {
  action: z.string().describe("Action name, e.g. 'help', 'login', 'submit_form', 'screenshot'"),
  args: z.record(z.unknown()).optional().describe("The action's arguments; see ipk_action {action:'help'}"),
};

function refuse(code: string, message: string, extra: Record<string, unknown> = {}) {
  return { ...textResult({ error: true, code, message, ...extra }), isError: true };
}

/** First sentence of a tool description. */
export function firstSentence(text: string): string {
  const m = text.match(/^.*?[.!?](?=\s|$)/s);
  return (m ? m[0] : text).trim();
}

function argsJsonSchema(shape: Record<string, unknown>): unknown {
  const js = zodToJsonSchema(z.object(shape as z.ZodRawShape), { target: "jsonSchema7", $refStrategy: "none" }) as Record<string, unknown>;
  delete js.$schema;
  // zodToJsonSchema defaults to additionalProperties:false, but runAction's safeParse (no
  // .strict()) actually tolerates and silently drops unknown keys (reported as dropped_keys
  // in the result), rather than rejecting them - so the listed schema says what args() does.
  js.additionalProperties = true;
  return js;
}

function help(registry: ActionRegistry, args: Record<string, unknown>) {
  const one = args.action;
  if (one !== undefined) {
    const def = typeof one === "string" && Object.hasOwn(registry, one) ? registry[one] : undefined;
    if (!def) return refuse("UNKNOWN_ACTION", `No action ${JSON.stringify(one)}`, { actions: Object.keys(registry).sort() });
    return textResult({
      action: def.name,
      purpose: def.purpose,
      description: def.description,
      args: argsJsonSchema(def.schema),
      ...(def.safety ? { safety: def.safety } : {}),
    });
  }
  return textResult({
    usage: "ipk_action {action:'<name>', args:{...}}; ipk_action {action:'help', args:{action:'<name>'}} for one action's full description",
    actions: Object.values(registry)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((d) => ({ action: d.name, purpose: d.purpose, args: argsJsonSchema(d.schema), ...(d.safety ? { safety: d.safety } : {}) })),
  });
}

/** Dispatch one ipk_action call: `help`, or validate `args` with the action's own zod and run its handler. */
export async function runAction(registry: ActionRegistry, ctx: unknown, params: { action: string; args?: Record<string, unknown> }) {
  const args = params.args ?? {};
  if (params.action === "help") return help(registry, args);

  const def = Object.hasOwn(registry, params.action) ? registry[params.action] : undefined;
  if (!def) {
    return refuse("UNKNOWN_ACTION", `No action ${JSON.stringify(params.action)}; call ipk_action {action:'help'}`, {
      actions: ["help", ...Object.keys(registry).sort()],
    });
  }
  const parsed = z.object(def.schema as z.ZodRawShape).safeParse(args);
  if (!parsed.success) {
    return refuse("INVALID_ARGS", `${def.name}: args do not match its schema; see ipk_action {action:'help', args:{action:'${def.name}'}}`, {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  // z.object(...).safeParse without .strict() silently drops keys not in the schema rather
  // than rejecting them; surface what was dropped so the caller sees why an arg had no effect.
  const dropped_keys = Object.keys(args).filter((k) => !Object.hasOwn(def.schema, k));
  const result = await def.handler(ctx, parsed.data);
  if (dropped_keys.length === 0) return result;
  try {
    const first = result?.content?.[0];
    if (first?.type === "text") {
      const data = JSON.parse(first.text);
      return { ...result, content: [{ ...first, text: JSON.stringify({ ...data, dropped_keys }) }, ...result.content.slice(1)] };
    }
  } catch {
    // result wasn't JSON text; fall through to returning it unchanged below.
  }
  return result;
}

/** The ipk_action tool definition for a registry. Its schema and description do not depend on the registry. */
export function makeActionTool(registry: ActionRegistry) {
  return {
    name: IPK_ACTION_NAME,
    description: IPK_ACTION_DESCRIPTION,
    schema: IPK_ACTION_SCHEMA as Record<string, unknown>,
    handler: (ctx: unknown, params: { action: string; args?: Record<string, unknown> }) => runAction(registry, ctx, params),
  };
}
