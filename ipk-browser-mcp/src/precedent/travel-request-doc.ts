/**
 * Read the practice fields off a rendered travel request (AppFrm-023 document_view).
 *
 * Input is the page's innerText. The view is a label/value table, so each field is a
 * line that starts with its label. Nothing here touches the network; fetching is the
 * caller's job (bench/reconcile.mjs and the submit handler both already have a page).
 */

export interface TravelRequestDoc {
  subject?: string;
  budget_code?: string;
  credit_card_no?: string;
  /** "in" when the view prints the metro label (bound_code 19), "out" when it prints a city. */
  bound?: "in" | "out";
  province?: string;
  city?: string;
  transport?: string;
  purpose_type?: string;
  /** Food Expense row "Standard" column: 0 when the trip carries no meal allowance (meals_served N). The count itself is not rendered. */
  food_allowance?: number;
  daily_expense?: number;
  attachments: { slot: string; file: string }[];
  /** How many field labels were found. 0 means this was not a rendered request; treat as a parse failure. */
  labels_found: number;
}

const SLOT_LABELS: [RegExp, string][] = [
  [/^Transport$/, "transport"],
  [/^Accommodation$/, "accommodation"],
  [/^Boarding Pass/, "boarding"],
  [/^ETC \(Visa/, "etc"],
  [/^Business trip verification/, "verification"],
  [/^Poster$/, "poster"],
  [/^Travel Report$/, "report"],
];

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

export function parseTravelRequestDoc(text: string): TravelRequestDoc {
  const lines = text.split("\n").map(norm);
  const doc: TravelRequestDoc = { attachments: [], labels_found: 0 };
  const after = (label: string) => {
    const l = lines.find((x) => x.startsWith(label + " "));
    if (l) doc.labels_found++;
    return l ? l.slice(label.length + 1).trim() : undefined;
  };

  doc.subject = after("Subject");

  const budget = lines.find((x) => x.startsWith("Budget Account Code"));
  if (budget) doc.labels_found++;
  const codes = budget ? [...budget.matchAll(/\[([A-Z]{2}\d{4}-\d{4})\]/g)].map((m) => m[1]) : [];
  // "[EZ: NN2602-0000] [NN2602-0001]" - the second bracket is the code the form stores.
  if (codes.length) doc.budget_code = codes[codes.length - 1];

  const card = after("Institute Credit Card No");
  if (card && /\d{4}/.test(card)) doc.credit_card_no = card;

  const cityLine = after("City & Transportation");
  if (cityLine) {
    const parts = cityLine.split(" - ").map(norm);
    if (parts.length >= 3) {
      doc.bound = "out";
      [doc.province, doc.city, doc.transport] = parts;
    } else {
      doc.bound = /Metropolitan/.test(cityLine) ? "in" : undefined;
      doc.transport = parts[parts.length - 1];
    }
  }

  doc.purpose_type = after("Type of Business Travel");

  const daily = lines.find((x) => /^Daily Expense \d/.test(x));
  if (daily) doc.daily_expense = Number(daily.split(" ")[2]);
  const food = lines.find((x) => /^Food Expense \d/.test(x));
  // "Food Expense <standard> <days> <card> <individual> <sum>"
  if (food) doc.food_allowance = Number(food.split(" ")[2]);

  // Attachment rows: a slot label line, then zero or more "<file> [<n>Bytes]..." lines.
  let slot: string | null = null;
  for (const l of lines) {
    const hit = SLOT_LABELS.find(([re]) => re.test(l));
    if (hit) { slot = hit[1]; continue; }
    if (slot && /\[\d+Bytes\]/.test(l)) {
      doc.attachments.push({ slot, file: l.replace(/\s*\[\d+Bytes\].*$/, "") });
    } else if (slot && l) {
      // Any other non-empty line, in any script, ends the attachment block.
      slot = null;
    }
  }
  return doc;
}

export interface PracticeProfile {
  /** Fields whose value is identical across all precedents. */
  stable: Record<string, { value: string; n: number }>;
  /** Fields that differ, with the count of each value seen. */
  varied: Record<string, Record<string, number>>;
  n: number;
}

/**
 * Fields a precedent may speak to, fixed by name rather than inferred: at N=3 every
 * small-option field looks "stable" by chance (critique finding 7). These are properties
 * of how the form is used. budget_code is included as a note only - it is a fact about
 * the fiscal year, never a default. credit_card_no is reported as presence, never as a
 * value: which card is a fact about the traveler, and a number has no place in a result.
 */
const PRACTICE_FIELDS = ["budget_code", "bound", "province", "city", "transport", "purpose_type", "food_allowance"] as const;

/**
 * What the department does the same way every time. N < 2 yields nothing: one document
 * is an example, not a practice.
 */
export function practiceProfile(docs: TravelRequestDoc[]): PracticeProfile {
  const out: PracticeProfile = { stable: {}, varied: {}, n: docs.length };
  if (docs.length < 2) return out;

  const tally = (key: string, values: (string | undefined)[]) => {
    const seen = values.filter((v): v is string => v != null && v !== "");
    if (seen.length !== docs.length) {
      if (seen.length) out.varied[key] = count(seen);
      return;
    }
    const c = count(seen);
    const keys = Object.keys(c);
    if (keys.length === 1) out.stable[key] = { value: keys[0], n: docs.length };
    else out.varied[key] = c;
  };

  for (const f of PRACTICE_FIELDS) tally(f, docs.map((d) => (d[f] == null ? undefined : String(d[f]))));
  tally("credit_card_no", docs.map((d) => (d.credit_card_no ? "present" : "absent")));
  // One slot per document; a document with files in two slots or none is "varied".
  tally(
    "attachment_slot",
    docs.map((d) => {
      const slots = [...new Set(d.attachments.map((a) => a.slot))];
      return slots.length === 1 ? slots[0] : undefined;
    })
  );
  return out;
}

function count(xs: string[]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const x of xs) c[x] = (c[x] ?? 0) + 1;
  return c;
}
