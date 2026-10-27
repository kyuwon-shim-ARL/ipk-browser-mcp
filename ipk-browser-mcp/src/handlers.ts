/**
 * Handlers bundle entry (built to dist/handlers.mjs). The shim (index.ts) imports this
 * at startup and re-imports it when the file changes, so everything here must be
 * reload-safe: no long-lived state of its own. The SessionManager and Config are the
 * shim's and arrive through `ctx` on every call.
 */
import { z } from "zod";

import type { Config } from "./types.js";
import type { SessionManager } from "./browser/session.js";
import { SHIM_API_VERSION, withNotes, type ToolDef } from "./hot-reload.js";
import { firstSentence, makeActionTool, type ActionDef, type ActionRegistry } from "./actions.js";
import { updateNotice, type UpdateCheckState } from "./update-check.js";

import { ipkLoginSchema, ipkLoginDescription, handleIpkLogin } from "./tools/ipk-login.js";
import { ipkSubmitFormSchema, ipkSubmitFormDescription, handleIpkSubmitForm } from "./tools/ipk-submit.js";
import { ipkFetchApprovalsSchema, ipkFetchApprovalsDescription, handleIpkFetchApprovals } from "./tools/ipk-fetch.js";
import { ipkNavigateSchema, ipkNavigateDescription, handleIpkNavigate } from "./tools/ipk-navigate.js";
import { ipkGetContentSchema, ipkGetContentDescription, handleIpkGetContent } from "./tools/ipk-content.js";
import { screenshotSchema, screenshotDescription, handleScreenshot, cleanupExpiredScreenshots } from "./tools/screenshot.js";
import { ipkInspectFormSchema, ipkInspectFormDescription, handleIpkInspectForm } from "./tools/ipk-inspect.js";
import { ipkProfileInitSchema, ipkProfileInitDescription, handleIpkProfileInit } from "./tools/ipk-profile.js";
import { ipkReviseAttachmentsSchema, ipkReviseAttachmentsDescription, handleIpkReviseAttachments } from "./tools/ipk-revise-attachments.js";
import { ipkPrecedentAttachmentsSchema, ipkPrecedentAttachmentsDescription, handleIpkPrecedentAttachments } from "./tools/ipk-precedent-attachments.js";
import { ipkCardErFixVatSchema, ipkCardErFixVatDescription, handleIpkCardErFixVat } from "./tools/ipk-card-er-fix-vat.js";
import { ipkReviewerOpinionsSchema, ipkReviewerOpinionsDescription, handleIpkReviewerOpinions } from "./tools/ipk-reviewer-opinions.js";

export interface HandlerContext {
  sessionManager: SessionManager;
  config: Config;
  /** Per-process update-check state, kept on the shim's ctx so it survives handler reloads (update-check.ts). */
  updateCheck?: UpdateCheckState;
}

declare const __PACKAGE_VERSION__: string;

/** The handlers<->shim API version this bundle was built against; see hot-reload.ts. */
export const SHIM_API = SHIM_API_VERSION;

type Def = Omit<ToolDef, "handler"> & { handler: (ctx: HandlerContext, params: any) => Promise<any> };

const individualTools: Def[] = [
  { name: "ipk_login", description: ipkLoginDescription, schema: ipkLoginSchema,
    handler: (c, p) => handleIpkLogin(c.sessionManager, p) },
  { name: "ipk_submit_form", description: ipkSubmitFormDescription, schema: ipkSubmitFormSchema,
    handler: (c, p) => handleIpkSubmitForm(c.sessionManager, c.config, p) },
  { name: "ipk_fetch_approvals", description: ipkFetchApprovalsDescription, schema: ipkFetchApprovalsSchema,
    handler: (c, p) => handleIpkFetchApprovals(c.sessionManager, c.config, p) },
  { name: "ipk_navigate", description: ipkNavigateDescription, schema: ipkNavigateSchema,
    handler: (c, p) => handleIpkNavigate(c.sessionManager, c.config, p) },
  { name: "ipk_get_content", description: ipkGetContentDescription, schema: ipkGetContentSchema,
    handler: (c, p) => handleIpkGetContent(c.sessionManager, c.config, p) },
  { name: "screenshot", description: screenshotDescription, schema: screenshotSchema,
    handler: (c, p) => handleScreenshot(c.sessionManager, c.config, p) },
  { name: "ipk_inspect_form", description: ipkInspectFormDescription, schema: ipkInspectFormSchema,
    handler: (c, p) => handleIpkInspectForm(c.sessionManager, c.config, p) },
  { name: "ipk_profile_init", description: ipkProfileInitDescription, schema: ipkProfileInitSchema,
    handler: (c, p) => handleIpkProfileInit(c.sessionManager, c.config, p) },
  { name: "ipk_revise_attachments", description: ipkReviseAttachmentsDescription, schema: ipkReviseAttachmentsSchema,
    handler: (c, p) => handleIpkReviseAttachments(c.sessionManager, c.config, p) },
  { name: "ipk_precedent_attachments", description: ipkPrecedentAttachmentsDescription, schema: ipkPrecedentAttachmentsSchema,
    handler: (c, p) => handleIpkPrecedentAttachments(c.sessionManager, c.config, p) },
  { name: "ipk_reviewer_opinions", description: ipkReviewerOpinionsDescription, schema: ipkReviewerOpinionsSchema,
    handler: (c, p) => handleIpkReviewerOpinions(c.sessionManager, c.config, p) },
  { name: "ipk_card_er_fix_vat", description: ipkCardErFixVatDescription, schema: ipkCardErFixVatSchema,
    handler: (c, p) => handleIpkCardErFixVat(c.sessionManager, c.config, p) },
];

/** Safety notes shown by ipk_action help. The checks themselves are in the handlers, shared by both call paths. */
const ACTION_SAFETY: Record<string, string[]> = {
  submit_form: [
    "draft_only defaults to true; a real submission also needs confirm_submit=true and IPK_ALLOW_SUBMIT=1, and org policy refuses some forms outright",
    "card_expense_rd: draft_only=false is refused (CARD_ER_NO_SUBMIT); allow_card_er_save needs a one-time per-transaction entry in ~/.config/ipk-browser-mcp/card-er-draft-authorizations.json, written by a person",
  ],
  card_er_fix_vat: [
    "dry_run defaults to true; a save needs a one-time \"doc:<doc_id>\" entry in ~/.config/ipk-browser-mcp/card-er-draft-authorizations.json, written by a person; never presses [Request]",
  ],
  revise_attachments: ["dry_run defaults to true; a write needs dry_run=false AND confirm_submit=true; never repossesses"],
  profile_init: ["read-only on the groupware; writes ~/.config/ipk-browser-mcp/profile.json"],
};

/**
 * Actions for ipk_action: every individual tool under its name without the ipk_ prefix, with
 * the same zod shape and handler function. Add a new action here; no shim change is needed.
 */
export const actions: ActionRegistry = Object.fromEntries(
  individualTools.map((t): [string, ActionDef] => {
    const name = t.name.replace(/^ipk_/, "");
    return [name, { name, purpose: firstSentence(t.description), description: t.description, schema: t.schema, safety: ACTION_SAFETY[name], handler: t.handler }];
  })
);

const localVersion = typeof __PACKAGE_VERSION__ === "string" ? __PACKAGE_VERSION__ : "0.0.0";

/** Append the update-available note (update-check.ts) to a tool's result, when there is one. */
function withUpdateNotice(def: Def): Def {
  return {
    ...def,
    handler: async (ctx, params) => {
      const state = (ctx.updateCheck ??= { notified: new Set() });
      const note = updateNotice(state, { localVersion });
      const result = await def.handler(ctx, params);
      return note ? withNotes(result, [note]) : result;
    },
  };
}

export const tools: Def[] = [...individualTools, makeActionTool(actions)].map(withUpdateNotice);

/** Run once at server start, not on reload. */
export function startup(ctx: HandlerContext): void {
  cleanupExpiredScreenshots(ctx.config);
}

/** Validate args with this bundle's zod (used when a reloaded schema differs from the registered one). */
export function parseArgs(
  shape: Record<string, unknown>,
  args: unknown
): { success: true; data: any } | { success: false; error: string } {
  const r = z.object(shape as z.ZodRawShape).safeParse(args);
  return r.success ? { success: true, data: r.data } : { success: false, error: r.error.message };
}
