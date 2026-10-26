import { describe, it, expect, vi } from "vitest";

// A dead Chromium must not wedge the server: ensureBrowser() relaunches instead of reusing
// a disconnected Browser ("browser.newContext: Target page, context or browser has been closed").
const launched: Array<{ connected: boolean; handlers: Record<string, () => void> }> = [];
vi.mock("playwright", () => ({
  chromium: {
    launch: vi.fn(async () => {
      const b = {
        connected: true,
        handlers: {} as Record<string, () => void>,
        isConnected() { return this.connected; },
        on(ev: string, fn: () => void) { this.handlers[ev] = fn; },
        close: vi.fn(async () => {}),
      };
      launched.push(b);
      return b;
    }),
  },
}));

const { SessionManager } = await import("../../src/browser/session.js");

describe("SessionManager browser relaunch", () => {
  it("relaunches when the cached browser is no longer connected", async () => {
    const sm = new SessionManager({ headless: true } as never);
    const ensure = (sm as unknown as { ensureBrowser(): Promise<unknown> }).ensureBrowser.bind(sm);

    const first = await ensure();
    expect(await ensure()).toBe(first);           // healthy browser is reused
    launched[0].connected = false;
    launched[0].handlers.disconnected?.();         // Chromium died
    const second = await ensure();
    expect(second).not.toBe(first);
    expect(launched).toHaveLength(2);
  });

  it("drops the session whose context lived in the dead browser", async () => {
    const sm = new SessionManager({ headless: true } as never);
    const ensure = (sm as unknown as { ensureBrowser(): Promise<unknown> }).ensureBrowser.bind(sm);
    await ensure();
    (sm as unknown as { session: unknown }).session = { userInfo: { username: "x", name: "X" } };
    const b = launched[launched.length - 1];
    b.connected = false;
    b.handlers.disconnected?.();
    expect(sm.getUserInfo()).toBeNull();
  });
});
