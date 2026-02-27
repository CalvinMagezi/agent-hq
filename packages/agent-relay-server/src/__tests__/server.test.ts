/**
 * Integration tests for RelayServer — startup, HTTP endpoints, WebSocket auth.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { RelayServer } from "../server";
import type { RelayServerConfig } from "../config";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

// Use a temp vault for tests
const TEST_VAULT_PATH = path.join(os.tmpdir(), `relay-test-vault-${Date.now()}`);
const TEST_PORT = 18901; // Different from default to avoid conflicts
const TEST_API_KEY = "test-relay-key";

function makeTestConfig(): RelayServerConfig {
  return {
    port: TEST_PORT,
    host: "127.0.0.1",
    vaultPath: TEST_VAULT_PATH,
    apiKey: TEST_API_KEY,
    debug: false,
  };
}

function createMinimalVault(vaultPath: string): void {
  const dirs = [
    "_jobs/pending",
    "_jobs/running",
    "_jobs/done",
    "_jobs/failed",
    "_system",
    "_delegation/pending",
    "_delegation/claimed",
    "_delegation/completed",
    "_threads/active",
    "_logs",
    "Notebooks",
  ];
  for (const dir of dirs) {
    fs.mkdirSync(path.join(vaultPath, dir), { recursive: true });
  }

  // Initialize fbmq queues
  const jobsPath = path.join(vaultPath, "_fbmq/jobs");
  const delegationPath = path.join(vaultPath, "_fbmq/delegation");
  const stagedPath = path.join(vaultPath, "_fbmq/staged");
  fs.mkdirSync(jobsPath, { recursive: true });
  fs.mkdirSync(delegationPath, { recursive: true });
  fs.mkdirSync(stagedPath, { recursive: true });
  Bun.spawnSync(["fbmq", "init", jobsPath, "--priority"]);
  Bun.spawnSync(["fbmq", "init", delegationPath, "--priority"]);
  Bun.spawnSync(["fbmq", "init", stagedPath]);

  // Create minimal system files
  fs.writeFileSync(
    path.join(vaultPath, "_system/SOUL.md"),
    "---\nnoteType: system-file\n---\n# Soul\nYou are a helpful assistant.\n",
  );
  fs.writeFileSync(
    path.join(vaultPath, "_system/MEMORY.md"),
    "---\nnoteType: system-file\n---\n# Memory\n",
  );
}

let server: RelayServer;

beforeAll(async () => {
  createMinimalVault(TEST_VAULT_PATH);
  server = new RelayServer(makeTestConfig());
  await server.start();
});

afterAll(() => {
  server.stop();
  fs.rmSync(TEST_VAULT_PATH, { recursive: true, force: true });
});

// ─── HTTP Endpoints ────────────────────────────────────────────────────

describe("HTTP endpoints", () => {
  test("GET /health returns 200 with status ok", async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.status).toBe("ok");
    expect(body.version).toBe("0.1.0");
  });

  test("GET /api/status requires auth (returns 401 without key)", async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/status`);
    expect(res.status).toBe(401);
  });

  test("GET /api/status returns system info with valid Bearer key", async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/status`, {
      headers: { Authorization: `Bearer ${TEST_API_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.serverVersion).toBe("0.1.0");
    expect(typeof body.pendingJobs).toBe("number");
    expect(typeof body.runningJobs).toBe("number");
    expect(typeof body.uptime).toBe("number");
  });

  test("POST /api/jobs creates a job", async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/jobs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ instruction: "Test job via REST" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.jobId).toBeDefined();
    expect(body.status).toBe("pending");
    expect(body.createdAt).toBeDefined();
  });

  test("POST /api/jobs returns 400 without instruction", async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/jobs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ priority: 50 }),
    });
    expect(res.status).toBe(400);
  });

  test("GET /api/threads returns threads list", async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/threads`, {
      headers: { Authorization: `Bearer ${TEST_API_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(Array.isArray(body.threads)).toBe(true);
  });

  test("GET /api/notes/search requires q parameter", async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/notes/search`, {
      headers: { Authorization: `Bearer ${TEST_API_KEY}` },
    });
    expect(res.status).toBe(400);
  });
});

// ─── WebSocket Auth ────────────────────────────────────────────────────

describe("WebSocket authentication", () => {
  test("rejects wrong API key", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
    await new Promise<void>((resolve) => { ws.onopen = () => resolve(); });

    const response = await new Promise<any>((resolve) => {
      ws.onmessage = (e) => resolve(JSON.parse(e.data));
      ws.send(JSON.stringify({ type: "auth", apiKey: "wrong-key" }));
    });

    expect(response.type).toBe("auth-ack");
    expect(response.success).toBe(false);
    ws.close();
  });

  test("accepts correct API key and returns session token", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
    await new Promise<void>((resolve) => { ws.onopen = () => resolve(); });

    const response = await new Promise<any>((resolve) => {
      ws.onmessage = (e) => resolve(JSON.parse(e.data));
      ws.send(JSON.stringify({ type: "auth", apiKey: TEST_API_KEY, clientId: "test-client", clientType: "cli" }));
    });

    expect(response.type).toBe("auth-ack");
    expect(response.success).toBe(true);
    expect(response.sessionToken).toBeDefined();
    expect(response.serverVersion).toBe("0.1.0");
    ws.close();
  });

  test("ping/pong works after authentication", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
    await new Promise<void>((resolve) => { ws.onopen = () => resolve(); });

    // Authenticate first
    await new Promise<void>((resolve) => {
      ws.onmessage = () => resolve();
      ws.send(JSON.stringify({ type: "auth", apiKey: TEST_API_KEY }));
    });

    // Send ping, expect pong
    const pong = await new Promise<any>((resolve) => {
      ws.onmessage = (e) => resolve(JSON.parse(e.data));
      ws.send(JSON.stringify({ type: "ping", timestamp: 12345 }));
    });

    expect(pong.type).toBe("pong");
    ws.close();
  });

  test("unauthenticated messages get NOT_AUTHENTICATED error", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
    await new Promise<void>((resolve) => { ws.onopen = () => resolve(); });

    const response = await new Promise<any>((resolve) => {
      ws.onmessage = (e) => resolve(JSON.parse(e.data));
      ws.send(JSON.stringify({ type: "system:status" }));
    });

    expect(response.type).toBe("error");
    expect(response.code).toBe("NOT_AUTHENTICATED");
    ws.close();
  });
});

// ─── WebSocket — Job Submission ─────────────────────────────────────────

describe("WebSocket job submission", () => {
  async function connectAndAuth(): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
    await new Promise<void>((resolve) => { ws.onopen = () => resolve(); });
    await new Promise<void>((resolve) => {
      ws.onmessage = () => resolve();
      ws.send(JSON.stringify({ type: "auth", apiKey: TEST_API_KEY }));
    });
    return ws;
  }

  test("job:submit creates a job and returns job:submitted", async () => {
    const ws = await connectAndAuth();

    const response = await new Promise<any>((resolve) => {
      ws.onmessage = (e) => resolve(JSON.parse(e.data));
      ws.send(JSON.stringify({
        type: "job:submit",
        instruction: "Test job via WebSocket",
        requestId: "ws-req-001",
      }));
    });

    expect(response.type).toBe("job:submitted");
    expect(response.jobId).toBeDefined();
    expect(response.requestId).toBe("ws-req-001");
    expect(response.status).toBe("pending");

    // Verify job was enqueued to fbmq
    const result = Bun.spawnSync(["fbmq", "depth", path.join(TEST_VAULT_PATH, "_fbmq/jobs")]);
    const depth = parseInt(new TextDecoder().decode(result.stdout).trim(), 10);
    expect(depth).toBeGreaterThanOrEqual(1);

    ws.close();
  });

  test("system:status returns status response", async () => {
    const ws = await connectAndAuth();

    const response = await new Promise<any>((resolve) => {
      ws.onmessage = (e) => resolve(JSON.parse(e.data));
      ws.send(JSON.stringify({ type: "system:status" }));
    });

    expect(response.type).toBe("system:status-response");
    expect(response.serverVersion).toBe("0.1.0");
    expect(typeof response.connectedClients).toBe("number");
    ws.close();
  });
});
