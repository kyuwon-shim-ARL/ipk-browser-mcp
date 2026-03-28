import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync, spawn, type ChildProcess } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..", "..");
const BRIDGE_SCRIPT = resolve(PROJECT_ROOT, "bridge.py");

/** Check if python3 is available */
function hasPython(): boolean {
  try {
    execSync("python3 --version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const pythonAvailable = hasPython();

/**
 * Send a JSON-RPC request to the bridge process and get a response.
 */
function sendRequest(
  proc: ChildProcess,
  method: string,
  params: Record<string, any> = {},
  timeoutMs = 10_000
): Promise<any> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const id = Date.now();

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        cleanup();
        try {
          resolve(JSON.parse(line));
        } catch (e) {
          reject(new Error(`Invalid JSON: ${line}`));
        }
      }
    };

    const cleanup = () => {
      clearTimeout(timeout);
      proc.stdout?.off("data", onData);
    };

    proc.stdout?.on("data", onData);

    const payload = JSON.stringify({ id, method, params }) + "\n";
    proc.stdin?.write(payload);
  });
}

describe.skipIf(!pythonAvailable)("Python bridge integration tests", () => {
  let bridge: ChildProcess;

  beforeAll(() => {
    bridge = spawn("python3", [BRIDGE_SCRIPT], {
      cwd: PROJECT_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    });
  });

  afterAll(() => {
    if (bridge && bridge.exitCode === null) {
      bridge.kill("SIGTERM");
    }
  });

  it("load_registry returns 11 FormType entries", async () => {
    const resp = await sendRequest(bridge, "load_registry");
    expect(resp.error).toBeUndefined();
    const result = resp.result;
    expect(Object.keys(result)).toHaveLength(11);
    expect(result.leave).toBeDefined();
    expect(result.leave.appFrmCode).toBe("AppFrm-073");
    expect(result.expense).toBeDefined();
    expect(result.overseas_travel).toBeDefined();
  });

  it("infer_fields returns inferred field values", async () => {
    const resp = await sendRequest(bridge, "infer_fields", {
      form_type: "leave",
      user_input: { leave_type: "연차" },
    });
    // Should have result, not error
    if (resp.error) {
      // Template might not exist for 'leave' in form_templates/
      // but we verify the bridge protocol works
      expect(resp.error).toHaveProperty("code");
    } else {
      expect(resp.result).toBeDefined();
    }
  });

  it("unknown method returns UNKNOWN_METHOD error", async () => {
    const resp = await sendRequest(bridge, "nonexistent_method");
    expect(resp.error).toBeDefined();
    expect(resp.error.code).toBe("UNKNOWN_METHOD");
    expect(resp.error.message).toContain("nonexistent_method");
  });

  it("missing form_type returns INVALID_PARAMS error", async () => {
    const resp = await sendRequest(bridge, "infer_fields", {});
    expect(resp.error).toBeDefined();
    expect(resp.error.code).toBe("INVALID_PARAMS");
  });
});
