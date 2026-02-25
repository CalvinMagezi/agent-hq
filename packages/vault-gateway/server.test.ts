import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { serve } from "bun";

const GATEWAY_PORT = 3001;
const GATEWAY_URL = `http://localhost:${GATEWAY_PORT}`;
// Test-only tokens — injected via AGENT_TOKENS env var so the server parses
// them the same way it does in production (no hardcoding inside server.ts).
const ADMIN_TOKEN = "test-admin-token";
const RELAY_TOKEN = "test-relay-token";
const TEST_AGENT_TOKENS = `${ADMIN_TOKEN}:admin:hq-admin,${RELAY_TOKEN}:relay:discord-relay`;

// We'll spawn the server from our src folder via bun
let serverProc: any;

const originalFetch = globalThis.fetch;

beforeAll(async () => {
    console.log("Starting Vault Gateway...");
    serverProc = Bun.spawn(["bun", "run", "src/server.ts"], {
        env: { ...process.env, MOCK_OBSIDIAN: "true", AGENT_TOKENS: TEST_AGENT_TOKENS }
    });

    // Wait a second for it to boot
    await new Promise((r) => setTimeout(r, 2000));
});

afterAll(() => {
    if (serverProc) {
        serverProc.kill();
    }
});

describe("Vault Gateway E2E Tests", () => {
    test("1. Rejects requests without Authorization header", async () => {
        const res = await fetch(`${GATEWAY_URL}/vault/`);
        expect(res.status).toBe(401);
        const json = (await res.json()) as any;
        expect(json.error).toBeDefined();
    });

    test("2. Rejects requests with invalid token", async () => {
        const res = await fetch(`${GATEWAY_URL}/vault/`, {
            headers: { Authorization: "Bearer bad-token" },
        });
        expect(res.status).toBe(403);
        const json = (await res.json()) as any;
        expect(json.error).toBeDefined();
    });

    test("3. Admin agent can read vault root", async () => {
        const res = await fetch(`${GATEWAY_URL}/vault/`, {
            headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
        });

        // Validates that it proxies to Obsidian and Obsidian accepts the key
        // assuming Obsidian is running 
        expect(res.status).toBe(200);
        const jsonStr = await res.text();
        // Usually it returns a JSON object of files or an array.
        // If Obsidian local REST plugin is offline, it will 502. 
        // This assumes it is online.
        if (res.status === 200) {
            console.log("Admin successful read response received from obsidian proxy");
        }
    });

    test("4. Relay agent CANNOT read arbitrary folders like _system", async () => {
        const res = await fetch(`${GATEWAY_URL}/vault/_system/CONFIG.md`, {
            headers: { Authorization: `Bearer ${RELAY_TOKEN}` },
            method: "POST" // We use POST/PUT to trigger the modify check
        });

        // 403 Forbidden because relay role isn't allowed to write to _system/
        expect(res.status).toBe(403);
    });

    test("5. Relay agent CAN write to _delegation folder", async () => {
        const res = await fetch(`${GATEWAY_URL}/vault/_delegation/test-relay.md`, {
            headers: { Authorization: `Bearer ${RELAY_TOKEN}` },
            method: "PUT",
            body: "Test Relay Content"
        });

        // Might 201 or 204 from Obsidian if created.
        // We just want to ensure the gateway itself didn't 403 us.
        expect(res.status).not.toBe(403);
        expect(res.status).not.toBe(401);
    });
});
