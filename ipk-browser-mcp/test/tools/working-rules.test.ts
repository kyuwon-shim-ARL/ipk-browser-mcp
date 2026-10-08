import { describe, it, expect } from "vitest";
import { checkWorkingRows, isoWeekKey } from "../../src/forms/working.js";

describe("isoWeekKey", () => {
  it("groups dates in the same ISO week under the same key", () => {
    // 2026-11-07 is a Saturday, 2026-11-08 a Sunday - same ISO week.
    expect(isoWeekKey("2026-11-07")).toBe(isoWeekKey("2026-11-08"));
  });
  it("gives a different key for dates a week apart", () => {
    expect(isoWeekKey("2026-11-07")).not.toBe(isoWeekKey("2026-11-14"));
  });
});

describe("checkWorkingRows", () => {
  const row = (date: string, hours: number) => ({ date, hours });

  it("passes a single weekend row within range", () => {
    const r = checkWorkingRows([row("2026-11-07", 2)]); // Saturday
    expect(r.violations).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("requires at least one row", () => {
    const r = checkWorkingRows([]);
    expect(r.violations.some((v) => v.code === "MISSING_ROWS")).toBe(true);
  });

  it("rejects hours outside 1-12", () => {
    expect(checkWorkingRows([row("2026-11-07", 0)]).violations.some((v) => v.code === "HOURS_OUT_OF_RANGE")).toBe(true);
    expect(checkWorkingRows([row("2026-11-07", 13)]).violations.some((v) => v.code === "HOURS_OUT_OF_RANGE")).toBe(true);
    expect(checkWorkingRows([row("2026-11-07", 1)]).violations).toEqual([]);
    expect(checkWorkingRows([row("2026-11-07", 12)]).violations).toEqual([]);
  });

  it("rejects a non-integer or non-numeric hours value", () => {
    expect(checkWorkingRows([row("2026-11-07", 2.5)]).violations.some((v) => v.code === "HOURS_OUT_OF_RANGE")).toBe(true);
  });

  it("rejects an invalid date", () => {
    expect(checkWorkingRows([row("not-a-date", 2)]).violations.some((v) => v.code === "INVALID_DATE")).toBe(true);
  });

  it("caps the total hours per ISO week at 12, across rows", () => {
    const r = checkWorkingRows([row("2026-11-07", 7), row("2026-11-08", 6)]); // same week, 13 total
    expect(r.violations.some((v) => v.code === "WEEKLY_CAP_EXCEEDED")).toBe(true);
  });

  it("does not cap across different ISO weeks", () => {
    const r = checkWorkingRows([row("2026-11-07", 12), row("2026-11-14", 12)]);
    expect(r.violations.some((v) => v.code === "WEEKLY_CAP_EXCEEDED")).toBe(false);
  });

  it("allows exactly 12 hours in one week", () => {
    const r = checkWorkingRows([row("2026-11-07", 6), row("2026-11-08", 6)]);
    expect(r.violations.some((v) => v.code === "WEEKLY_CAP_EXCEEDED")).toBe(false);
  });

  it("warns, not blocks, when a row's date is a weekday - no public holiday calendar to check against", () => {
    const r = checkWorkingRows([row("2026-11-09", 2)]); // Monday
    expect(r.violations).toEqual([]);
    expect(r.warnings.some((v) => v.code === "WEEKDAY_DATE")).toBe(true);
  });

  it("does not warn for Saturday or Sunday", () => {
    expect(checkWorkingRows([row("2026-11-07", 2)]).warnings).toEqual([]); // Sat
    expect(checkWorkingRows([row("2026-11-08", 2)]).warnings).toEqual([]); // Sun
  });
});
