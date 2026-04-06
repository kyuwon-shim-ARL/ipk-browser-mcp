/**
 * Singleton Python bridge: spawns bridge.py as a child process and communicates
 * via newline-delimited JSON over stdio (JSON-RPC style).
 *
 * Protocol (matches bridge.py):
 *   Request:  {"id": N, "method": "...", "params": {...}}\n
 *   Response: {"id": N, "result": {...}}  or  {"id": N, "error": "..."}
 */
import { spawn, type ChildProcess } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..");
const BRIDGE_SCRIPT = resolve(PROJECT_ROOT, "bridge.py");

const MAX_QUEUE = 10;
const RPC_TIMEOUT_MS = 30_000;
const SHUTDOWN_GRACE_MS = 3_000;

interface RpcRequest {
  id: number;
  method: string;
  params: Record<string, any>;
}

interface RpcResponse {
  id: number;
  result?: any;
  error?: { code: string; message: string } | string;
}

interface QueueItem {
  request: RpcRequest;
  resolve: (resp: RpcResponse) => void;
  reject: (err: Error) => void;
}

let child: ChildProcess | null = null;
let crashCount = 0;
let nextId = 1;
let currentResolve: ((resp: RpcResponse) => void) | null = null;
let buffer = "";
const queue: QueueItem[] = [];
let processing = false;

function ensureProcess(): ChildProcess | null {
  if (child && child.exitCode === null) return child;

  if (crashCount >= 2) return null;

  child = spawn("python3", [BRIDGE_SCRIPT], {
    cwd: PROJECT_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.on("exit", () => {
    crashCount++;
    child = null;
    buffer = "";
    // Reject current in-flight request
    if (currentResolve) {
      currentResolve({ id: -1, error: { code: "BRIDGE_UNAVAILABLE", message: "Python bridge process exited" } });
      currentResolve = null;
    }
    // Drain queue if crash limit reached
    if (crashCount >= 2) {
      drainQueue("BRIDGE_UNAVAILABLE", "Python bridge crashed and restart limit reached");
    }
  });

  child.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (!line) continue;
      try {
        const resp: RpcResponse = JSON.parse(line);
        if (currentResolve) {
          currentResolve(resp);
          currentResolve = null;
        }
      } catch {
        // Ignore malformed JSON from Python
      }
    }
  });

  return child;
}

function drainQueue(code: string, message: string): void {
  while (queue.length > 0) {
    const item = queue.shift()!;
    item.resolve({ id: item.request.id, error: { code, message } });
  }
}

async function processQueue(): Promise<void> {
  if (processing) return;
  processing = true;

  while (queue.length > 0) {
    const item = queue.shift()!;
    const proc = ensureProcess();
    if (!proc) {
      item.resolve({ id: item.request.id, error: { code: "BRIDGE_UNAVAILABLE", message: "Python bridge unavailable" } });
      continue;
    }

    try {
      const resp = await new Promise<RpcResponse>((resolve, reject) => {
        currentResolve = resolve;
        const timeout = setTimeout(() => {
          currentResolve = null;
          resolve({ id: item.request.id, error: { code: "TIMEOUT", message: `RPC call timed out after ${RPC_TIMEOUT_MS}ms` } });
        }, RPC_TIMEOUT_MS);

        const origResolve = currentResolve;
        currentResolve = (resp) => {
          clearTimeout(timeout);
          resolve(resp);
        };

        const payload = JSON.stringify(item.request) + "\n";
        proc.stdin!.write(payload, (err) => {
          if (err) {
            clearTimeout(timeout);
            currentResolve = null;
            resolve({ id: item.request.id, error: { code: "BRIDGE_UNAVAILABLE", message: `Failed to write to bridge: ${err.message}` } });
          }
        });
      });

      // Reset crash count only after successful RPC response (not on spawn)
      if (!resp.error) {
        crashCount = 0;
      }
      item.resolve(resp);
    } catch (err) {
      item.resolve({ id: item.request.id, error: { code: "INTERNAL_ERROR", message: String(err) } });
    }
  }

  processing = false;
}

/**
 * Call a Python bridge method via JSON-RPC over stdio.
 * Returns the RPC response (either {result} or {error}).
 */
async function callPythonBridge(
  method: string,
  params: Record<string, any> = {}
): Promise<RpcResponse> {
  if (queue.length >= MAX_QUEUE) {
    return { id: -1, error: { code: "QUEUE_OVERFLOW", message: `Request queue full (max ${MAX_QUEUE})` } };
  }

  const request: RpcRequest = { id: nextId++, method, params };

  return new Promise<RpcResponse>((resolve) => {
    queue.push({ request, resolve, reject: () => {} });
    processQueue();
  });
}

/** Graceful shutdown: kill the Python process on MCP server exit. */
export function shutdownBridge(): void {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child && child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }, SHUTDOWN_GRACE_MS);
  }
}

// Auto-cleanup on process exit
process.on("exit", shutdownBridge);
process.on("SIGINT", shutdownBridge);
process.on("SIGTERM", shutdownBridge);
