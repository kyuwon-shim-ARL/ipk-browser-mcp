import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseCardListRows,
  dedupeCards,
  parseBudgetPotOptions,
  parseApprovedCardDoc,
  bucketApprovedCards,
  handleIpkProfileInit,
  type ProfileInitDeps,
} from "../../src/tools/ipk-profile.js";
import { loadProfile, maskCardNumber } from "../../src/profile/profile.js";
import { isMeetingAccount } from "../../src/forms/card-er.js";

const FIXTURES = join(__dirname, "..", "fixtures", "profile");
const cardListRows: { cardCell: string; ownerCell: string }[] = JSON.parse(readFileSync(join(FIXTURES, "card-list-rows.json"), "utf-8"));
const budgetOptions: { value: string; text: string }[] = JSON.parse(readFileSync(join(FIXTURES, "budget-select-options.json"), "utf-8"));

const MY_ALIASES = ["Kyuwon Shim", "kyuwon.shim"];

// ── pure parsers, synthetic HTML-derived fixtures ───────────────────────────
// Fixtures mirror the live page's actual quirk (confirmed 2026-10-09, read-only
// inspection, column names only): each cell carries a leading, differently-shaped
// digit/id run before its real content - the real card is the LAST dashed
// NNNN-NNNN-NNNN-NNNN run, the real owner is the capitalised-name-shaped run.

describe("parseCardListRows", () => {
  it("takes the LAST dashed card run in the cell, not a leading id/garbage run", () => {
    const rows = parseCardListRows(cardListRows, MY_ALIASES);
    expect(rows.map((r) => r.number)).toEqual([
      "1234-5678-9012-3456", // own
      "9999-8888-7777-6666", // colleague's
      "9999-8888-7777-6666", // same colleague card again (dup pending row)
    ]);
  });

  it("marks a row 'own' only when the extracted Owner name matches a configured alias", () => {
    const rows = parseCardListRows(cardListRows, MY_ALIASES);
    expect(rows.map((r) => r.kind)).toEqual(["own", "shared", "shared"]);
    expect(rows.map((r) => r.holder_match)).toEqual([true, false, false]);
  });

  it("drops a row with no card-shaped tail in its cell", () => {
    expect(parseCardListRows([{ cardCell: "9988776655 no card here", ownerCell: "Someone Else" }], MY_ALIASES)).toEqual([]);
  });

  it("matches an id-shaped alias (kyuwon.shim) against a name-shaped Owner the same way session.ts derives a display name", () => {
    const rows = parseCardListRows(
      [{ cardCell: "000000000000 1234-5678-9012-3456", ownerCell: "111 Kyuwon Shim" }],
      ["kyuwon.shim"] // alias given as the login id, not the display name
    );
    expect(rows[0].kind).toBe("own");
  });
});

describe("dedupeCards", () => {
  it("collapses the same card (seen on multiple pending rows) to one entry", () => {
    const parsed = parseCardListRows(cardListRows, MY_ALIASES);
    const cards = dedupeCards(parsed, "corporation_card_list.php");
    expect(cards).toEqual([
      { number: "1234-5678-9012-3456", kind: "own", holder_match: true, source: "corporation_card_list.php" },
      { number: "9999-8888-7777-6666", kind: "shared", holder_match: false, source: "corporation_card_list.php" },
    ]);
  });

  it("promotes a card to 'own' if ANY occurrence of it was owner-matched", () => {
    const rows = [
      { number: "1111-2222-3333-4444", kind: "shared" as const, holder_match: false },
      { number: "1111-2222-3333-4444", kind: "own" as const, holder_match: true },
    ];
    expect(dedupeCards(rows, "test")[0].kind).toBe("own");
  });
});

describe("parseBudgetPotOptions", () => {
  it("keeps only code-shaped option values, dropping the placeholder and '0'", () => {
    const pots = parseBudgetPotOptions(budgetOptions, "AppFrm-021 budget_code select");
    expect(pots.map((p) => p.code)).toEqual(["NN2606-0001", "NN2606-0002"]);
  });

  it("derives fiscal_year from the code and keeps the option's own label", () => {
    const pots = parseBudgetPotOptions(budgetOptions, "test");
    expect(pots[0]).toEqual({ code: "NN2606-0001", label: "NN2606-0001 R&D Pot A", fiscal_year: 2026, source: "test" });
  });
});

describe("parseApprovedCardDoc", () => {
  it("reads the masked card off the 'Card Number' label line and the account code off its bracketed line", () => {
    const text =
      "Subject [Card] ARL RunPod GPU Compute Credits\n" +
      "Payment Corporate Credit Card Card Number 1234-XXXX-XXXX-3456\n" +
      "Account Code [410318] IT Software (IT Subscription)\n";
    expect(parseApprovedCardDoc(text)).toEqual({ cardNumber: "1234-XXXX-XXXX-3456", accountCode: "410318" });
  });

  it("returns nulls when the document has neither line", () => {
    expect(parseApprovedCardDoc("Subject [Request] Something\n")).toEqual({ cardNumber: null, accountCode: null });
  });
});

describe("bucketApprovedCards", () => {
  const CARD_A = "1234-5678-9012-3456";
  const CARD_B = "9999-8888-7777-6666";

  it("a card seen on >=2 non-meeting documents becomes 'own'", () => {
    const cards = bucketApprovedCards(
      [{ cardNumber: CARD_A, accountCode: "410318" }, { cardNumber: CARD_A, accountCode: "410911" }],
      isMeetingAccount,
      "test"
    );
    expect(cards).toEqual([{ number: CARD_A, kind: "own", holder_match: true, source: "test" }]);
  });

  it("a card seen on exactly 1 non-meeting document becomes 'own-unconfirmed'", () => {
    const cards = bucketApprovedCards([{ cardNumber: CARD_A, accountCode: "410318" }], isMeetingAccount, "test");
    expect(cards).toEqual([{ number: CARD_A, kind: "own-unconfirmed", holder_match: true, source: "test" }]);
  });

  it("a card seen only on meeting-account documents (e.g. 412107 Team Activities) is dropped entirely - never 'own'", () => {
    const cards = bucketApprovedCards(
      [{ cardNumber: CARD_B, accountCode: "412107" }, { cardNumber: CARD_B, accountCode: "412107" }],
      isMeetingAccount,
      "test"
    );
    expect(cards).toEqual([]);
  });

  it("a meeting-account document doesn't corroborate a card that also appears on one real document", () => {
    const cards = bucketApprovedCards(
      [{ cardNumber: CARD_A, accountCode: "410318" }, { cardNumber: CARD_A, accountCode: "412107" }],
      isMeetingAccount,
      "test"
    );
    expect(cards).toEqual([{ number: CARD_A, kind: "own-unconfirmed", holder_match: true, source: "test" }]);
  });

  it("a document with no card read (cardNumber null) contributes nothing", () => {
    expect(bucketApprovedCards([{ cardNumber: null, accountCode: "410318" }], isMeetingAccount, "test")).toEqual([]);
  });
});

// ── handler, injectable deps (no real Playwright Page) ─────────────────────

function fakeSession(loggedIn = true) {
  return {
    isLoggedIn: () => loggedIn,
    getLoginState: () => (loggedIn ? "active" : "none"),
    getPage: () => ({} as any),
    getUserInfo: () => ({ username: "tester", name: "Tester", dept: "ARL" }),
  } as any;
}

const fakeConfig = { baseUrl: "https://gw.ip-korea.org", navTimeoutMs: 1000 } as any;

describe("handleIpkProfileInit", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ipk-profile-init-test-"));
    process.env.IPK_HOME_DIR = home;
  });
  afterEach(() => {
    delete process.env.IPK_HOME_DIR;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const deps = (over: Partial<ProfileInitDeps> = {}): ProfileInitDeps => ({
    fetchCards: async () => [{ number: "1234-5678-9012-3456", kind: "own", holder_match: true, source: "corporation_card_list.php" }],
    fetchOwnCardsFallback: async () => [],
    fetchBudgetPots: async () => [{ code: "NN2606-0001", fiscal_year: 2026, source: "test" }],
    ...over,
  });

  it("refuses when not logged in", async () => {
    const r = JSON.parse((await handleIpkProfileInit(fakeSession(false), fakeConfig, {}, deps())).content[0].text);
    expect(r.error).toBe(true);
    expect(r.code).toBe("NOT_LOGGED_IN");
  });

  it("writes profile.json and masks the card number in its response", async () => {
    const r = JSON.parse((await handleIpkProfileInit(fakeSession(), fakeConfig, {}, deps())).content[0].text);
    expect(r.error).toBe(false);
    expect(r.data.cards_found).toBe(1);
    expect(r.data.cards_masked).toEqual([maskCardNumber("1234-5678-9012-3456")]);
    expect(JSON.stringify(r)).not.toContain("1234-5678-9012-3456"); // never the raw number
    expect(r.data.budget_pots_found).toBe(1);

    const saved = loadProfile();
    expect(saved).not.toBeNull();
    expect(saved!.cards[0].number).toBe("1234-5678-9012-3456");
    expect(saved!.cards[0].kind).toBe("own");
    expect(saved!.user).toEqual({ name: "Tester", dept: "ARL" });
  });

  it("a 'shared' card alone (not own) does not satisfy cards_found and triggers the approved-ER fallback", async () => {
    const r = JSON.parse((await handleIpkProfileInit(fakeSession(), fakeConfig, {}, deps({
      fetchCards: async () => [{ number: "9999-8888-7777-6666", kind: "shared", holder_match: false, source: "corporation_card_list.php" }],
      fetchOwnCardsFallback: async () => [{ number: "1234-XXXX-XXXX-3456", kind: "own", holder_match: true, source: "AppFrm-021 approved (masked)" }],
    }))).content[0].text);
    expect(r.data.cards_found).toBe(1);
    expect(r.data.shared_cards_seen).toBe(1);
    expect(r.data.cards_signal).toMatch(/approved documents/);
  });

  it("lists cards/budget_pots as not derived when nothing own was found, instead of asking blindly for everything", async () => {
    const r = JSON.parse((await handleIpkProfileInit(fakeSession(), fakeConfig, {}, deps({ fetchCards: async () => [], fetchBudgetPots: async () => [] }))).content[0].text);
    expect(r.data.not_derived.some((k: string) => k.startsWith("cards"))).toBe(true);
    expect(r.data.not_derived.some((k: string) => k.startsWith("budget_pots"))).toBe(true);
  });

  it("never asks for a key it found", async () => {
    const r = JSON.parse((await handleIpkProfileInit(fakeSession(), fakeConfig, {}, deps())).content[0].text);
    expect(r.data.not_derived.some((k: string) => k.startsWith("cards"))).toBe(false);
    expect(r.data.not_derived.some((k: string) => k.startsWith("budget_pots"))).toBe(false);
  });

  it("works with a session that has 0 approved documents - cards/pots come from the card list and the form's own select, not history", async () => {
    const r = JSON.parse((await handleIpkProfileInit(fakeSession(), fakeConfig, {}, deps())).content[0].text);
    expect(r.error).toBe(false);
  });

  it("works offline with injected deps - no live Page object is required", async () => {
    const calls: string[] = [];
    const d = deps({
      fetchCards: async () => { calls.push("cards"); return []; },
      fetchOwnCardsFallback: async () => { calls.push("fallback"); return []; },
      fetchBudgetPots: async () => { calls.push("pots"); return []; },
    });
    await handleIpkProfileInit(fakeSession(), fakeConfig, {}, d);
    expect(calls).toEqual(["cards", "fallback", "pots"]);
  });
});

// ── read-only guarantee ──────────────────────────────────────────────────

describe("ipk-profile.ts never writes to the groupware", () => {
  it("its source never references a save/submit path", () => {
    const src = readFileSync(join(__dirname, "..", "..", "src", "tools", "ipk-profile.ts"), "utf-8");
    for (const forbidden of ["submitForm", "Check_Form_Request", "form1.submit", "setFormMode", ".submit("]) {
      expect(src).not.toContain(forbidden);
    }
  });
});
