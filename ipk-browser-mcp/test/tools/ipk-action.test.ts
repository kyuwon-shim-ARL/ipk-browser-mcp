/**
 * ipk_action: one frozen-schema tool over a hot-reloaded action registry (src/actions.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { tools, actions } from "../../src/handlers.js";
import { makeActionTool, IPK_ACTION_NAME, type ActionRegistry } from "../../src/actions.js";
import { dispatchToolCall, toolFingerprint, PARAMS_CHANGED_NOTE, type Registration } from "../../src/hot-reload.js";

const parse = (r: any) => JSON.parse(r.content[0].text);
const actionTool = () => tools.find((t) => t.name === IPK_ACTION_NAME)!;
const loggedOut = { sessionManager: { isLoggedIn: () => false, getLoginState: () => "logged_out" }, config: {} };

describe("registry", () => {
  it("exposes every individual tool under its name without the ipk_ prefix, same schema and handler", () => {
    const individual = tools.filter((t) => t.name !== IPK_ACTION_NAME);
    expect(Object.keys(actions).sort()).toEqual(individual.map((t) => t.name.replace(/^ipk_/, "")).sort());
    expect(Object.keys(actions).sort()).toEqual([
      "card_er_fix_vat", "fetch_approvals", "get_content", "inspect_form", "login", "navigate",
      "precedent_attachments", "profile_init", "reviewer_opinions", "revise_attachments", "screenshot", "submit_form",
    ]);
    for (const t of individual) expect(actions[t.name.replace(/^ipk_/, "")].schema).toBe(t.schema);
  });

  it("keeps the individual tools registered", () => {
    expect(tools.map((t) => t.name)).toContain("ipk_submit_form");
    expect(tools.map((t) => t.name)).toContain("screenshot");
    expect(tools).toHaveLength(13);
  });
});

describe("help", () => {
  it("lists every action with purpose, args as JSON Schema, and safety notes", async () => {
    const out = parse(await actionTool().handler(loggedOut as any, { action: "help" }));
    const names = out.actions.map((a: any) => a.action);
    expect(names).toContain("submit_form");
    const submit = out.actions.find((a: any) => a.action === "submit_form");
    expect(submit.purpose).toBe("Submit a form in IPK groupware.");
    expect(submit.args.type).toBe("object");
    expect(submit.args.properties.form_type).toBeDefined();
    expect(submit.args.required).toContain("form_type");
    expect(submit.safety.join(" ")).toMatch(/card-er-draft-authorizations\.json/);
  });

  it("describes one action in full", async () => {
    const out = parse(await actionTool().handler(loggedOut as any, { action: "help", args: { action: "screenshot" } }));
    expect(out.action).toBe("screenshot");
    expect(out.description).toMatch(/screenshot/i);
    expect(out.args.type).toBe("object");
  });

  it("help for an unknown action is UNKNOWN_ACTION", async () => {
    const r = await actionTool().handler(loggedOut as any, { action: "help", args: { action: "nope" } });
    expect(r.isError).toBe(true);
    expect(parse(r).code).toBe("UNKNOWN_ACTION");
  });
});

describe("dispatch", () => {
  it("unknown action is UNKNOWN_ACTION with the list", async () => {
    const r = await actionTool().handler(loggedOut as any, { action: "frobnicate" });
    const out = parse(r);
    expect(r.isError).toBe(true);
    expect(out.code).toBe("UNKNOWN_ACTION");
    expect(out.actions).toContain("help");
    expect(out.actions).toContain("submit_form");
  });

  it("args failing the action's zod schema are INVALID_ARGS with the issues, handler not run", async () => {
    let ran = false;
    const reg: ActionRegistry = {
      x: { name: "x", purpose: "x", description: "x", schema: { n: (await import("zod")).z.number() }, handler: async () => { ran = true; return {}; } },
    };
    const r = await makeActionTool(reg).handler({}, { action: "x", args: { n: "one" } });
    const out = parse(r);
    expect(out.code).toBe("INVALID_ARGS");
    expect(out.issues[0].path).toBe("n");
    expect(ran).toBe(false);
  });

  it("runs the same handler as the individual tool (screenshot while logged out -> NOT_LOGGED_IN)", async () => {
    const out = parse(await actionTool().handler(loggedOut as any, { action: "screenshot" }));
    expect(out.code).toBe("NOT_LOGGED_IN");
  });

  it("an omitted default-having field (e.g. draft_only) reaches the handler as its zod default", async () => {
    const z = (await import("zod")).z;
    let seen: any = null;
    const reg: ActionRegistry = {
      x: {
        name: "x", purpose: "x", description: "x",
        schema: { draft_only: z.boolean().default(true) },
        handler: async (_c: unknown, p: any) => { seen = p; return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] }; },
      },
    };
    await makeActionTool(reg).handler({}, { action: "x", args: {} });
    expect(seen).toEqual({ draft_only: true });
  });

  it("unknown keys are not passed to the handler, and are reported as dropped_keys", async () => {
    const z = (await import("zod")).z;
    let seen: any = null;
    const reg: ActionRegistry = {
      x: {
        name: "x", purpose: "x", description: "x",
        schema: { n: z.number() },
        handler: async (_c: unknown, p: any) => { seen = p; return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] }; },
      },
    };
    const r = await makeActionTool(reg).handler({}, { action: "x", args: { n: 1, bogus: "nope" } });
    expect(seen).toEqual({ n: 1 });
    expect(parse(r)).toEqual({ ok: true, dropped_keys: ["bogus"] });
  });
});

describe("a new action is callable without the shim's registered schema changing", () => {
  it("fingerprint of ipk_action is stable and the shim dispatches the new action without a reconnect note", async () => {
    const z = (await import("zod")).z;
    const before = makeActionTool(actions);
    const after = makeActionTool({
      ...actions,
      hello: { name: "hello", purpose: "Say hello.", description: "Say hello.", schema: { who: z.string() },
        handler: async (_c: unknown, p: any) => ({ content: [{ type: "text", text: JSON.stringify({ hi: p.who }) }] }) },
    });
    expect(toolFingerprint(after)).toBe(toolFingerprint(before));

    // The shim registered ipk_action from the old build; the reloaded build adds `hello`.
    const fp = toolFingerprint(before);
    const updates: unknown[] = [];
    const reg: Registration = { connectFp: fp, currentFp: fp, update: (u) => updates.push(u) };
    const reloader = { current: async () => ({ mod: { tools: [after], parseArgs: (await import("../../src/handlers.js")).parseArgs } }) };
    const r = await dispatchToolCall(IPK_ACTION_NAME, { action: "hello", args: { who: "kim" } }, reloader as any, {}, reg, () => undefined);
    expect(JSON.parse(r.content[0].text)).toEqual({ hi: "kim" });
    expect(r.content.map((c: any) => c.text).join(" ")).not.toContain(PARAMS_CHANGED_NOTE);
    expect(updates).toHaveLength(0);
  });
});

describe("safety is identical via ipk_action", () => {
  const prev = process.env.IPK_ALLOW_SUBMIT;
  beforeEach(() => { process.env.IPK_ALLOW_SUBMIT = "1"; });
  afterEach(() => { if (prev === undefined) delete process.env.IPK_ALLOW_SUBMIT; else process.env.IPK_ALLOW_SUBMIT = prev; });

  it("card_expense_rd draft_only=false is refused (CARD_ER_NO_SUBMIT) before the page is touched", async () => {
    const touched: string[] = [];
    const page = new Proxy({}, { get: (_t, k) => { touched.push(String(k)); return () => { throw new Error(`page.${String(k)} touched`); }; } });
    const ctx = {
      sessionManager: {
        isLoggedIn: () => true, getLoginState: () => "logged_in", getPage: () => page,
        getSessionRemainingMs: () => 3_600_000, touchActivity: () => undefined, getUserInfo: () => ({ name: "Tester" }),
      },
      config: { baseUrl: "https://gw.ip-korea.org", navTimeoutMs: 1000, screenshotDir: "/nonexistent", screenshotTtlMinutes: 1 },
    };
    const args = {
      form_type: "card_expense_rd", trseq: "26040417102", appr_no: "19984403", subject: "Google Cloud usage fee",
      item_name: "Google Cloud Gemini API service", seller_en: "Google Cloud Korea LLC", p_reason: "Cloud compute",
      item_account_code: "410318", draft_only: false, confirm_submit: true,
    };
    const viaAction = parse(await actionTool().handler(ctx as any, { action: "submit_form", args }));
    expect(viaAction.error).toBe(true);
    expect(viaAction.message).toMatch(/CARD_ER_NO_SUBMIT/);
    expect(touched).toEqual([]);

    const viaTool = parse(await tools.find((t) => t.name === "ipk_submit_form")!.handler(ctx as any, args));
    expect(viaTool.message).toMatch(/CARD_ER_NO_SUBMIT/);
  });
});

describe("update notice wiring (handlers.ts)", () => {
  const saved = { HOME: process.env.HOME, IPK_UPDATE_CHECK: process.env.IPK_UPDATE_CHECK };
  afterEach(() => {
    process.env.HOME = saved.HOME;
    if (saved.IPK_UPDATE_CHECK === undefined) delete process.env.IPK_UPDATE_CHECK;
    else process.env.IPK_UPDATE_CHECK = saved.IPK_UPDATE_CHECK;
  });

  it("appends the note to one tool result per process (state on ctx), from a fresh cache without fetching", async () => {
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ipk-home-"));
    fs.mkdirSync(path.join(home, ".cache", "ipk-mcp"), { recursive: true });
    fs.writeFileSync(path.join(home, ".cache", "ipk-mcp", "update-check.json"), JSON.stringify({ checkedAt: Date.now(), remoteVersion: "99.0.0" }));
    process.env.HOME = home;
    delete process.env.IPK_UPDATE_CHECK;

    const ctx: any = { ...loggedOut };
    const texts = async (name: string, params: unknown) =>
      (await tools.find((t) => t.name === name)!.handler(ctx, params)).content.map((c: any) => c.text).join("\n");
    const first = await texts("screenshot", {});
    expect(first).toMatch(/note: ipk-browser-mcp 99\.0\.0 available/);
    expect(first).toContain("NOT_LOGGED_IN");
    expect(await texts(IPK_ACTION_NAME, { action: "screenshot" })).not.toMatch(/available/);
  });
});
