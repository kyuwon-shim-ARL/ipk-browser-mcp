import * as fs from "fs";
import type { FrameLike } from "../../types.js";

/**
 * Multi-file attachment primitive for IPK groupware forms.
 *
 * Widget mechanism (verified 2026-04-07 against AppFrm-020 / -021 / -026 /
 * -027 / -054 / -073 — applies to ALL IPK forms with file attachments):
 *   - The form pre-renders 20 `<input type="file" name="doc_attach_file[]">`
 *     elements but only the first is visible. The remaining 19 have
 *     `style="display: none"`.
 *   - A `<select name="file_attach_cnt" onchange="attach_reseth()">` dropdown
 *     (options 1..20) controls how many slots are visible.
 *   - Setting file_attach_cnt = N and firing onchange exposes the first N
 *     file inputs. After that, each `doc_attach_file[]` element accepts a
 *     single file via setInputFiles.
 *
 * Manual flow: pick the count once, attach N files. This primitive does the same.
 *
 * Existing-attachment deletion uses `del_file(orderNo)` which is a SYNCHRONOUS
 * page-reload action: each call sets `del_no` + `mode=file` and submits the
 * form, the server deletes one file and re-renders the page. Multiple deletes
 * MUST be done one-at-a-time with a navigation wait between calls
 * (see clearAllAttachments).
 *
 * Accepts FrameLike so both Page and Frame can be passed; Page-only APIs
 * are forbidden by the type system.
 */

export interface AttachResult {
  attached: number;
  skipped: { path: string; reason: string }[];
}

/**
 * Attach multiple files to a form's File Attachment widget.
 * Sets file_attach_cnt to filePaths.length, then feeds each file into the
 * corresponding doc_attach_file[] input.
 */
export async function attachFiles(
  ctx: FrameLike,
  filePaths: string[]
): Promise<AttachResult> {
  const result: AttachResult = { attached: 0, skipped: [] };

  // Pre-filter missing files
  const valid: string[] = [];
  for (const p of filePaths) {
    if (!fs.existsSync(p)) {
      result.skipped.push({ path: p, reason: "file not found on local fs" });
    } else {
      valid.push(p);
    }
  }
  if (valid.length === 0) return result;

  // Set the count dropdown and trigger onchange (attach_reseth)
  await ctx.evaluate((n) => {
    const sel = document.querySelector(
      'select[name="file_attach_cnt"]'
    ) as HTMLSelectElement | null;
    if (sel) {
      sel.value = String(n);
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, valid.length);

  // Wait briefly for attach_reseth() to expose the slots
  await ctx.waitForTimeout(300);

  // Feed each file into its slot
  const fileLocators = ctx.locator('input[name="doc_attach_file[]"]');
  for (let i = 0; i < valid.length; i++) {
    try {
      await fileLocators.nth(i).setInputFiles(valid[i]);
      result.attached += 1;
    } catch (err) {
      result.skipped.push({
        path: valid[i],
        reason: `setInputFiles failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return result;
}

/**
 * Delete ALL existing attachments from an IPK form (any form type).
 *
 * IPK's del_file(orderNo) is synchronous: each call submits form1 with
 * mode=file & del_no=orderNo, the server removes one attachment and
 * re-renders the page. We MUST wait for navigation between calls — a tight
 * loop only the first call survives the navigation.
 *
 * Algorithm: query existing del_file('N') links, delete the first one,
 * wait for reload, re-query, repeat until none remain. Bounded by maxIter
 * (default 25) to avoid infinite loops on pathological forms.
 *
 * `ctx` must have a dialog handler that auto-accepts the "attachment file
 * delete!" confirm prompt configured on the owning Page before calling.
 */
export async function clearAllAttachments(
  ctx: FrameLike,
  opts: { maxIter?: number; waitMs?: number } = {}
): Promise<{ deleted: number; remaining: string[] }> {
  const maxIter = opts.maxIter ?? 25;
  const waitMs = opts.waitMs ?? 1500;
  let deleted = 0;

  // Helper to read existing attachment order numbers from del_file('N') links
  const readExisting = async (): Promise<string[]> => {
    return await ctx.evaluate(() => {
      const out: string[] = [];
      for (const a of Array.from(document.querySelectorAll("a"))) {
        const href = a.getAttribute("href") || "";
        const m = href.match(/del_file\('(\d+)'\)/);
        if (m) out.push(m[1]);
      }
      return [...new Set(out)];
    });
  };

  let existing = await readExisting();
  let iter = 0;
  while (existing.length > 0 && iter < maxIter) {
    iter += 1;
    const order = existing[0];
    try {
      await ctx.evaluate((flag: string) => {
        const delNo = document.getElementById("del_no") as HTMLInputElement | null;
        const modeEl = (document as any).all?.("mode") as HTMLInputElement | undefined;
        if (delNo) delNo.value = flag;
        if (modeEl) modeEl.value = "file";
        const form = (document as any).form1 as HTMLFormElement | undefined;
        if (form) form.submit();
      }, order);
    } catch {
      break;
    }
    // Wait for the page reload
    try {
      await ctx.waitForLoadState("networkidle", { timeout: 15000 });
    } catch {
      // ignore
    }
    await ctx.waitForTimeout(waitMs);
    deleted += 1;
    existing = await readExisting();
  }

  return { deleted, remaining: existing };
}
