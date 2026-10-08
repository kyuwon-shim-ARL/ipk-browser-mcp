import { describe, it, expect, afterEach } from "vitest";
import { loadConfig } from "../../src/types.js";

describe("loadConfig baseUrl", () => {
  const saved = process.env.IPK_BASE_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.IPK_BASE_URL;
    else process.env.IPK_BASE_URL = saved;
  });
  it("keeps only the origin when IPK_BASE_URL points at main.php", () => {
    process.env.IPK_BASE_URL = "https://gw.ip-korea.org/main.php";
    expect(loadConfig().baseUrl).toBe("https://gw.ip-korea.org");
  });
  it("drops a trailing slash", () => {
    process.env.IPK_BASE_URL = "https://gw.ip-korea.org/";
    expect(loadConfig().baseUrl).toBe("https://gw.ip-korea.org");
  });
  it("assumes https for a scheme-less host", () => {
    process.env.IPK_BASE_URL = "gw.ip-korea.org";
    expect(loadConfig().baseUrl).toBe("https://gw.ip-korea.org");
    process.env.IPK_BASE_URL = "gw.ip-korea.org/main.php";
    expect(loadConfig().baseUrl).toBe("https://gw.ip-korea.org");
  });
  it("keeps an explicit http scheme", () => {
    process.env.IPK_BASE_URL = "http://localhost:8080/";
    expect(loadConfig().baseUrl).toBe("http://localhost:8080");
  });
});
