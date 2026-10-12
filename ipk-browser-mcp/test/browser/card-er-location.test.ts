import { describe, it, expect } from "vitest";
import { determineCardErLocation, findDocIdBySubjectAndDate } from "../../src/browser/card-er-location.js";

// Fixtures: test/fixtures/card-er-location/ - document-view-301323-negative.txt (real, redacted,
// captured 2026-10-12) and waiting-list-empty.txt (real, type=appr list, confirms the URL param).
// There is no real positive fixture yet (plan v6.1) - the AT_DRAFTER_TURN case below is built
// from the negative fixture's structure with the three signals flipped, and is explicitly
// SYNTHETIC, not captured.

describe("determineCardErLocation", () => {
  it("[REAL fixture: doc 301323, 2026-10-12] not in the waiting list + past-drafter approval line -> DRAFT_WENT_TO_APPROVAL", () => {
    const result = determineCardErLocation({
      inWaitingList: false, // absent from document_list.php?type=appr (empty at capture time)
      approvalLine: {
        ownActionPending: false, // [Sign] shown on Approver A/B's rows, not the drafter's
        repossessOffered: false, // not observed on this document (still routable either way)
        firstUntimedStepIsDrafter: false, // the drafter's row (step 1) carries a date - already actioned
      },
    });
    expect(result.outcome).toBe("DRAFT_WENT_TO_APPROVAL");
  });

  it("[SYNTHETIC - no live fixture yet] waiting-list hit + own action pending + no repossess + first untimed step is drafter -> AT_DRAFTER_TURN", () => {
    const result = determineCardErLocation({
      inWaitingList: true,
      approvalLine: {
        ownActionPending: true,
        repossessOffered: false,
        firstUntimedStepIsDrafter: true,
      },
    });
    expect(result.outcome).toBe("AT_DRAFTER_TURN");
  });

  it("[SYNTHETIC] repossess offered even with a waiting-list hit -> DRAFT_WENT_TO_APPROVAL (not success)", () => {
    const result = determineCardErLocation({
      inWaitingList: true,
      approvalLine: { ownActionPending: true, repossessOffered: true, firstUntimedStepIsDrafter: true },
    });
    expect(result.outcome).toBe("DRAFT_WENT_TO_APPROVAL");
  });

  it("unreadable waiting list -> DRAFT_NOT_CONFIRMED, never AT_DRAFTER_TURN", () => {
    const result = determineCardErLocation({
      inWaitingList: "unreadable",
      approvalLine: { ownActionPending: true, repossessOffered: false, firstUntimedStepIsDrafter: true },
    });
    expect(result.outcome).toBe("DRAFT_NOT_CONFIRMED");
  });

  it("unreadable approval line -> DRAFT_NOT_CONFIRMED", () => {
    const result = determineCardErLocation({ inWaitingList: true, approvalLine: null });
    expect(result.outcome).toBe("DRAFT_NOT_CONFIRMED");
  });

  it("a mismatch (in waiting list, but approval line disagrees) -> DRAFT_WENT_TO_APPROVAL, not a silent success", () => {
    const result = determineCardErLocation({
      inWaitingList: true,
      approvalLine: { ownActionPending: false, repossessOffered: false, firstUntimedStepIsDrafter: true },
    });
    expect(result.outcome).toBe("DRAFT_WENT_TO_APPROVAL");
  });
});

describe("findDocIdBySubjectAndDate", () => {
  const list = [
    { docId: "301400", subject: "[Card] Test subject A", date: "2026-10-12" },
    { docId: "301401", subject: "[Card] Test subject B", date: "2026-10-12" },
  ];
  it("resolves a unique match", () => {
    expect(findDocIdBySubjectAndDate(list, "[Card] Test subject A", "2026-10-12")).toBe("301400");
  });
  it("refuses on no match", () => {
    expect(findDocIdBySubjectAndDate(list, "[Card] Nothing like this", "2026-10-12")).toBeNull();
  });
  it("refuses on an ambiguous match rather than guessing", () => {
    const dup = [...list, { docId: "301402", subject: "[Card] Test subject A", date: "2026-10-12" }];
    expect(findDocIdBySubjectAndDate(dup, "[Card] Test subject A", "2026-10-12")).toBeNull();
  });
});
