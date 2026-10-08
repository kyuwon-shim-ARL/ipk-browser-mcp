/**
 * AppFrm-074 "Application for Working on Weekends & Holidays" - checks written down
 * from the live write page and the department's printed rules on it (read 2026-10-09):
 * the working_time[] select only offers 01:00-12:00 whole hours (so "more than 1 hour"
 * is enforced structurally by the options, not checked here), and the form's own
 * printed rule caps total overtime at 12 hours per week. Separate from org-policy.ts's
 * ENGLISH_ONLY (which already covers `subject`/`reason` generically via FREE_TEXT_PARAMS)
 * - this file is the content specific to this form: the date/hour rows.
 *
 * B0: the MCP `working` type used to target AppFrm-027 (a Facility/Construction Work
 * Request, unrelated) - see src/tools/ipk-submit.ts submitWorking.
 */

export interface WorkingRow {
  date: string;
  hours: number;
}

export interface FormRuleViolation {
  code: string;
  message: string;
  fields: string[];
}

function parseDate(date: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const d = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** ISO week key ("2026-W41") - Sat/Sun of the same week share a key, a week apart does
 *  not. Used only to group rows for the 12h/week cap, not displayed anywhere. */
export function isoWeekKey(date: string): string {
  const d = parseDate(date);
  if (!d) return `invalid:${date}`;
  // ISO week: Monday start, week 1 contains the year's first Thursday.
  const t = new Date(d.getTime());
  const dayNum = (t.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  t.setUTCDate(t.getUTCDate() - dayNum + 3); // Thursday of this week
  const firstThursday = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((t.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function isWeekend(date: string): boolean {
  const d = parseDate(date);
  if (!d) return false;
  const day = d.getUTCDay(); // 0=Sun, 6=Sat
  return day === 0 || day === 6;
}

/**
 * Validates the rows a working-form draft would carry. Blocks (violations) on anything
 * the form itself would also reject or that breaks the department's printed hour rules;
 * warns (does not block) on a weekday date, since there is no public-holiday calendar
 * here to tell a holiday weekday from an ordinary one.
 */
export function checkWorkingRows(rows: WorkingRow[]): { violations: FormRuleViolation[]; warnings: FormRuleViolation[] } {
  const violations: FormRuleViolation[] = [];
  const warnings: FormRuleViolation[] = [];

  if (!rows || rows.length === 0) {
    violations.push({ code: "MISSING_ROWS", message: "At least one {date, hours} row is required.", fields: ["rows"] });
    return { violations, warnings };
  }

  const weekTotals = new Map<string, number>();

  rows.forEach((row, i) => {
    const field = `rows[${i}]`;
    if (!Number.isInteger(row.hours) || row.hours < 1 || row.hours > 12) {
      violations.push({
        code: "HOURS_OUT_OF_RANGE",
        message: `${field}: hours must be a whole number from 1 to 12 (the form's working_time[] select only offers 01:00-12:00) - got ${row.hours}.`,
        fields: [field],
      });
    }

    const d = parseDate(row.date);
    if (!d) {
      violations.push({ code: "INVALID_DATE", message: `${field}: date '${row.date}' is not a valid YYYY-MM-DD date.`, fields: [field] });
      return; // nothing more to check about a date that doesn't parse
    }

    if (!isWeekend(row.date)) {
      warnings.push({
        code: "WEEKDAY_DATE",
        message: `${field}: ${row.date} is a weekday. This form is for weekend/holiday work - if it's a public holiday that's fine, but there is no holiday calendar here to confirm it.`,
        fields: [field],
      });
    }

    if (Number.isFinite(row.hours)) {
      const key = isoWeekKey(row.date);
      weekTotals.set(key, (weekTotals.get(key) ?? 0) + row.hours);
    }
  });

  for (const [week, total] of weekTotals) {
    if (total > 12) {
      violations.push({
        code: "WEEKLY_CAP_EXCEEDED",
        message: `Total working hours for ISO week ${week} is ${total}, over the department's 12-hour/week cap.`,
        fields: ["rows"],
      });
    }
  }

  return { violations, warnings };
}
