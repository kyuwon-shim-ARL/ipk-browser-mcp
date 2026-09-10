/**
 * Precedent: how this department has filled the same form before.
 *
 * Read-only against the groupware. Returns parsed approved documents so the handler can
 * tell the caller where a draft departs from practice. It never supplies a value: the
 * card number, budget pot and file are facts about this trip, and precedent only knows
 * about past trips (critique 2026-09-10, findings 4-6).
 *
 * Documents the tool itself drafted are excluded, otherwise the tool would be checking
 * its own output against its own output (finding 1).
 */
import { parseTravelRequestDoc, practiceProfile, type TravelRequestDoc, type PracticeProfile } from "./travel-request-doc.js";
import { toolDraftedDocIds } from "../internal/audit.js";

export interface PrecedentSet {
  docs: { docId: string; docNo: string; writer: string; doc: TravelRequestDoc }[];
  excluded: string[];
  profile: PracticeProfile;
  error?: string;
}

export interface PrecedentQuery {
  baseUrl: string;
  formCode: string; // e.g. "AppFrm-023"
  keyword?: string;
  /** Prefer documents by this writer; fall back to the department when fewer than `n`. */
  writer?: string;
  n?: number;
  sinceDays?: number;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

export async function fetchTravelRequestPrecedents(page: any, q: PrecedentQuery): Promise<PrecedentSet> {
  const n = q.n ?? 3;
  const origin = new URL(q.baseUrl).origin;
  const excluded = toolDraftedDocIds();
  const out: PrecedentSet = { docs: [], excluded: [], profile: practiceProfile([]) };
  try {
    const e = new Date();
    const s = new Date(e.getTime() - (q.sinceDays ?? 365) * 86400000);
    const listUrl =
      `${origin}/Document/document_list.php?type=groupapproved&s_date=${ymd(s)}&e_date=${ymd(e)}` +
      `&keyword=${encodeURIComponent(q.keyword ?? "")}&writer=Y&title=Y&contents=Y&attachment=Y`;
    await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1500);
    const rows: { href: string; docId: string; docNo: string; writer: string; subject: string }[] = await page.mainFrame().$$eval(
      "tr",
      (trs: any[]) =>
        trs
          .map((r) => {
            const a = r.querySelector("a[href*='doc_id=']");
            if (!a) return null;
            const href = a.getAttribute("href") || "";
            const m = href.match(/doc_id=(\d+)/);
            const cells = Array.from(r.querySelectorAll("td")).map((td: any) => (td.innerText || "").replace(/\s+/g, " ").trim());
            // Columns on document_list.php: doc no, subject, department, writer, status, date.
            return { href, docId: m ? m[1] : "", docNo: cells[0] ?? "", subject: cells[1] ?? "", writer: cells[3] ?? "" };
          })
          .filter(Boolean)
    );
    const ofForm = rows.filter((r) => r.href.includes(`approve_type=${q.formCode}`) && r.docId);
    const mine = q.writer ? ofForm.filter((r) => r.writer === q.writer) : [];
    const ordered = [...mine, ...ofForm.filter((r) => !mine.includes(r))];
    const picked: typeof ordered = [];
    for (const r of ordered) {
      if (excluded.has(r.docId)) { out.excluded.push(r.docId); continue; }
      if (picked.length < n) picked.push(r);
    }
    for (const r of picked) {
      await page.goto(new URL(r.href, `${origin}/Document/`).href, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(1500);
      const text: string = await page.evaluate(() => document.body.innerText);
      out.docs.push({ docId: r.docId, docNo: r.docNo, writer: r.writer, doc: parseTravelRequestDoc(text) });
    }
    const unreadable = out.docs.filter((d) => d.doc.labels_found === 0).map((d) => d.docId);
    if (unreadable.length) out.error = `could not read fields off document(s) ${unreadable.join(", ")}: the view did not render as a label/value table`;
    out.profile = practiceProfile(out.docs.filter((d) => d.doc.labels_found > 0).map((d) => d.doc));
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
  }
  return out;
}

/** Read a draft's rendered view by id (document_view needs the list's full query string). */
export async function readDraftText(page: any, baseUrl: string, docId: string): Promise<{ text: string | null; reason?: string }> {
  const origin = new URL(baseUrl).origin;
  await page.goto(`${origin}/Document/document_list.php?type=drafts`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1500);
  const href: string | null = await page
    .mainFrame()
    .$eval(`a[href*='doc_id=${docId}']`, (a: any) => a.getAttribute("href"))
    .catch(() => null);
  if (!href) return { text: null, reason: `draft ${docId} is not on the first page of the drafts list` };
  await page.goto(new URL(href, `${origin}/Document/`).href, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1500);
  return { text: await page.evaluate(() => document.body.innerText) };
}

export interface PrecedentDiff {
  field: string;
  draft: string | undefined;
  practice: string;
  n: number;
}

/** Precedent minus draft, on rendered documents: every stable field the draft does not match. */
export function diffAgainstPractice(draft: TravelRequestDoc, profile: PracticeProfile): PrecedentDiff[] {
  const out: PrecedentDiff[] = [];
  const draftSlot = [...new Set(draft.attachments.map((a) => a.slot))];
  const value = (field: string): string | undefined => {
    if (field === "attachment_slot") return draftSlot.length === 1 ? draftSlot[0] : draftSlot.join("+") || undefined;
    if (field === "credit_card_no") return draft.credit_card_no ? "present" : "absent";
    const v = (draft as any)[field];
    return v == null ? undefined : String(v);
  };
  for (const [field, st] of Object.entries(profile.stable)) {
    const d = value(field);
    if (d !== st.value) out.push({ field, draft: d, practice: st.value, n: st.n });
  }
  return out;
}
