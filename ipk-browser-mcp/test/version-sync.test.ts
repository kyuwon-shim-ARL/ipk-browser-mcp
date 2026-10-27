import { describe, it, expect } from "vitest";
// @ts-expect-error - plain .mjs script without type declarations
import { readVersions } from "../scripts/check-version-sync.mjs";

describe("version sync", () => {
  it("plugin.json, marketplace.json and package.json carry the same version", () => {
    const versions = readVersions();
    expect(Object.values(versions).every((v) => typeof v === "string")).toBe(true);
    expect(new Set(Object.values(versions)).size, JSON.stringify(versions)).toBe(1);
  });
});
