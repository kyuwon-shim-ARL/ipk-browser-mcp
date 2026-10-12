import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  readApprovalLineFromBodyText,
  readApprovalLineFromDocumentView,
  readWaitingListDocIds,
  isDocIdInWaitingList,
  determineCardErLocation,
} from "../../src/browser/card-er-location.js";

const FIXTURE_DIR = path.join(__dirname, "../fixtures/card-er-location");
const read = (name: string) => fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8");
const DRAFTER = "Kyuwon Shim";

describe("readApprovalLineFromBodyText on the REAL 301323 negative fixture", () => {
  const bodyText = read("document-view-301323-negative.rawtext.txt");

  it("parses ownActionPending=false, repossessOffered=false, firstUntimedStepIsDrafter=false", () => {
    const signal = readApprovalLineFromBodyText(bodyText, DRAFTER);
    expect(signal).toEqual({ ownActionPending: false, repossessOffered: false, firstUntimedStepIsDrafter: false });
  });

  it("feeds determineCardErLocation to DRAFT_WENT_TO_APPROVAL when also absent from the waiting list", () => {
    const signal = readApprovalLineFromBodyText(bodyText, DRAFTER);
    const result = determineCardErLocation({ inWaitingList: false, approvalLine: signal });
    expect(result.outcome).toBe("DRAFT_WENT_TO_APPROVAL");
  });
});

describe("readApprovalLineFromBodyText on the SYNTHETIC positive fixture", () => {
  const bodyText = read("document-view-synthetic-positive.rawtext.txt");

  it("parses ownActionPending=true, repossessOffered=false, firstUntimedStepIsDrafter=true", () => {
    const signal = readApprovalLineFromBodyText(bodyText, DRAFTER);
    expect(signal).toEqual({ ownActionPending: true, repossessOffered: false, firstUntimedStepIsDrafter: true });
  });

  it("feeds determineCardErLocation to AT_DRAFTER_TURN when also present in the waiting list", () => {
    const signal = readApprovalLineFromBodyText(bodyText, DRAFTER);
    const result = determineCardErLocation({ inWaitingList: true, approvalLine: signal });
    expect(result.outcome).toBe("AT_DRAFTER_TURN");
  });
});

describe("readApprovalLineFromDocumentView (frame glue)", () => {
  it("returns the parsed signal from the frame's body text", async () => {
    const bodyText = read("document-view-301323-negative.rawtext.txt");
    const frame = { evaluate: async (fn: any) => (typeof fn === "function" ? bodyText : undefined) };
    const signal = await readApprovalLineFromDocumentView(frame, DRAFTER);
    expect(signal?.ownActionPending).toBe(false);
  });

  it("returns null (never throws) when frame.evaluate rejects", async () => {
    const frame = { evaluate: async () => { throw new Error("detached frame"); } };
    expect(await readApprovalLineFromDocumentView(frame, DRAFTER)).toBeNull();
  });
});

describe("readWaitingListDocIds / isDocIdInWaitingList (frame glue)", () => {
  it("extracts doc_id values from anchor hrefs", async () => {
    const frame = {
      evaluate: async (fn: any) => {
        // Simulates the real DOM read this would run against document_list.php?type=appr.
        const hrefs = ["document_view.php?doc_id=301323&approve_type=AppFrm-021"];
        const fakeDoc = {
          querySelectorAll: () => hrefs.map((h) => ({ getAttribute: () => h })),
        };
        // Run the same extraction the real function's evaluate callback does, against fakeDoc.
        const out: string[] = [];
        for (const link of fakeDoc.querySelectorAll()) {
          const m = (link.getAttribute() || "").match(/doc_id=([^&]+)/);
          if (m) out.push(m[1]);
        }
        return out;
      },
    };
    const ids = await readWaitingListDocIds(frame);
    expect(ids).toEqual(["301323"]);
    expect(isDocIdInWaitingList(ids, "301323")).toBe(true);
    expect(isDocIdInWaitingList(ids, "999999")).toBe(false);
  });

  it("[REAL fixture: empty type=appr list, 2026-10-12] returns [] when the list has 0 rows", async () => {
    // test/fixtures/card-er-location/waiting-list-empty.txt: real capture, "document not
    // found." (0 rows) at the time the account's own counter read "Approval 0".
    const frame = { evaluate: async () => [] };
    const ids = await readWaitingListDocIds(frame);
    expect(ids).toEqual([]);
    expect(isDocIdInWaitingList(ids, "301323")).toBe(false);
  });

  it("returns 'unreadable' (never guesses membership) when frame.evaluate rejects", async () => {
    const frame = { evaluate: async () => { throw new Error("nav failed"); } };
    const ids = await readWaitingListDocIds(frame);
    expect(ids).toBe("unreadable");
    expect(isDocIdInWaitingList(ids, "301323")).toBe("unreadable");
  });
});
