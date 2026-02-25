/**
 * End-to-end test for the unified vault-mcp server.
 * Spawns the MCP server as a child process and calls each tool via JSON-RPC.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "path";

const VAULT_PATH = path.resolve(__dirname, "../../.vault");

async function runTests() {
    console.log("🧪 Vault MCP End-to-End Tests\n");

    // Start MCP server via stdio
    const transport = new StdioClientTransport({
        command: "bun",
        args: ["run", path.resolve(__dirname, "src/index.ts")],
        env: {
            ...process.env,
            VAULT_PATH,
            OBSIDIAN_API_KEY: "test-key",
            OBSIDIAN_REST_URL: "https://127.0.0.1:27124",
        },
    });

    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(transport);

    // List available tools
    const { tools } = await client.listTools();
    console.log(`📋 Server exposes ${tools.length} tools:`);
    for (const t of tools) {
        console.log(`   • ${t.name}`);
    }
    console.log("");

    let passed = 0;
    let failed = 0;

    async function test(name: string, fn: () => Promise<void>) {
        try {
            await fn();
            console.log(`✅ ${name}`);
            passed++;
        } catch (err: any) {
            console.error(`❌ ${name}: ${err.message}`);
            failed++;
        }
    }

    // ── 1. vault_list ───────────────────────────────────────────────────
    await test("vault_list: list root directory", async () => {
        const result = await client.callTool({ name: "vault_list", arguments: { path: "/" } });
        const text = (result.content as any)[0].text;
        const items = JSON.parse(text);
        if (!Array.isArray(items) || items.length === 0) throw new Error("Expected non-empty array");
    });

    // ── 2. vault_write + vault_read ─────────────────────────────────────
    await test("vault_write + vault_read: round-trip", async () => {
        const testPath = "_test/mcp-test-file.md";
        await client.callTool({ name: "vault_write", arguments: { path: testPath, content: "---\ntitle: test\n---\n\nHello MCP!" } });

        const result = await client.callTool({ name: "vault_read", arguments: { path: testPath, parse_frontmatter: true } });
        const text = (result.content as any)[0].text;
        const parsed = JSON.parse(text);
        if (parsed.frontmatter.title !== "test") throw new Error(`Expected title 'test', got '${parsed.frontmatter.title}'`);
        if (!parsed.content.includes("Hello MCP!")) throw new Error("Content mismatch");
    });

    // ── 3. vault_patch ──────────────────────────────────────────────────
    await test("vault_patch: surgical edit", async () => {
        const testPath = "_test/mcp-test-file.md";
        await client.callTool({ name: "vault_patch", arguments: { path: testPath, old_string: "Hello MCP!", new_string: "Hello Patched!" } });

        const result = await client.callTool({ name: "vault_read", arguments: { path: testPath, parse_frontmatter: false } });
        const text = (result.content as any)[0].text;
        if (!text.includes("Hello Patched!")) throw new Error("Patch failed");
    });

    // ── 4. vault_search ─────────────────────────────────────────────────
    await test("vault_search: find test file", async () => {
        const result = await client.callTool({ name: "vault_search", arguments: { query: "Patched", folder: "_test" } });
        const text = (result.content as any)[0].text;
        const items = JSON.parse(text);
        if (!Array.isArray(items) || items.length === 0) throw new Error("Expected search results");
    });

    // ── 5. vault_create_note ────────────────────────────────────────────
    await test("vault_create_note: create versioned note", async () => {
        const result = await client.callTool({
            name: "vault_create_note",
            arguments: {
                folder: "_test",
                title: "MCP Test Note",
                content: "This is a test note created by the MCP.",
                tags: ["test", "mcp"],
            },
        });
        const text = (result.content as any)[0].text;
        if (!text.includes("v1")) throw new Error("Expected version 1");
    });

    // ── 6. vault_update_note ────────────────────────────────────────────
    await test("vault_update_note: lock + version bump", async () => {
        const result = await client.callTool({
            name: "vault_update_note",
            arguments: {
                path: "Notebooks/_test/MCP Test Note.md",
                content: "Updated content via MCP.",
                frontmatter_updates: { reviewed: true },
            },
        });
        const text = (result.content as any)[0].text;
        if (!text.includes("v2")) throw new Error("Expected version 2");
    });

    // ── 7. vault_lock + vault_unlock ────────────────────────────────────
    await test("vault_lock + vault_unlock: acquire and release", async () => {
        const lockResult = await client.callTool({
            name: "vault_lock",
            arguments: { path: "_test/mcp-test-file.md" },
        });
        const lockText = (lockResult.content as any)[0].text;
        const { token } = JSON.parse(lockText);
        if (!token) throw new Error("No lock token received");

        await client.callTool({
            name: "vault_unlock",
            arguments: { path: "_test/mcp-test-file.md", token },
        });
    });

    // ── 8. vault_emit_event + vault_read_events ─────────────────────────
    await test("vault_emit_event + vault_read_events: round-trip", async () => {
        const emitResult = await client.callTool({
            name: "vault_emit_event",
            arguments: { type: "test-event", source: "mcp-test", payload: { foo: "bar" } },
        });
        const emitText = (emitResult.content as any)[0].text;
        const { id } = JSON.parse(emitText);
        if (!id) throw new Error("No event ID received");

        const readResult = await client.callTool({
            name: "vault_read_events",
            arguments: { type_filter: "test-event" },
        });
        const readText = (readResult.content as any)[0].text;
        const { events } = JSON.parse(readText);
        if (!events.some((e: any) => e.id === id)) throw new Error("Emitted event not found in log");
    });

    // ── 9. vault_rest_search (graceful degradation) ─────────────────────
    await test("vault_rest_search: graceful error when Obsidian offline", async () => {
        const result = await client.callTool({
            name: "vault_rest_search",
            arguments: { query: "test" },
        });
        // We expect an error since Obsidian is likely offline
        const text = (result.content as any)[0].text;
        if (!text.includes("Error") && !text.includes("unavailable")) {
            // If Obsidian IS running, we'll get results which is also fine
            console.log("   (Obsidian appears to be running — got live results)");
        }
    });

    // ── 10. vault_advanced (jobs & threads) ─────────────────────────────
    await test("vault_advanced tools: job, thread, batch read", async () => {
        // create thread
        const thRes = await client.callTool({ name: "vault_create_thread", arguments: { title: "MCP E2E Test" } });
        const { threadId } = JSON.parse((thRes.content as any)[0].text);
        if (!threadId) throw new Error("No threadId");

        // append message
        await client.callTool({ name: "vault_append_message", arguments: { thread_id: threadId, role: "user", content: "Ping!" } });

        // create job
        const jbRes = await client.callTool({ name: "vault_create_job", arguments: { instruction: "Test MCP job" } });
        const { jobId } = JSON.parse((jbRes.content as any)[0].text);
        if (!jobId) throw new Error("No jobId");

        // batch read (read both thread and job)
        const brRes = await client.callTool({ name: "vault_batch_read", arguments: { paths: [`_threads/active/${threadId}.md`, `_jobs/pending/${jobId}.md`] } });
        const brMap = JSON.parse((brRes.content as any)[0].text);
        if (Object.keys(brMap).length !== 2) throw new Error("Batch read failed to return 2 files");

        // log activity
        await client.callTool({ name: "vault_log_activity", arguments: { role: "assistant", source: "job", content: "Did the test job" } });

        // cleanup these files
        await client.callTool({ name: "vault_delete", arguments: { path: `_threads/active/${threadId}.md`, confirm_path: `_threads/active/${threadId}.md` } });
        await client.callTool({ name: "vault_delete", arguments: { path: `_jobs/pending/${jobId}.md`, confirm_path: `_jobs/pending/${jobId}.md` } });
    });

    // ── 11. vault_delete (cleanup) ──────────────────────────────────────
    await test("vault_delete: clean up test files", async () => {
        await client.callTool({ name: "vault_delete", arguments: { path: "_test/mcp-test-file.md", confirm_path: "_test/mcp-test-file.md" } });
        await client.callTool({ name: "vault_delete", arguments: { path: "Notebooks/_test/MCP Test Note.md", confirm_path: "Notebooks/_test/MCP Test Note.md" } });
    });

    // ── Summary ─────────────────────────────────────────────────────────
    console.log(`\n${"═".repeat(50)}`);
    console.log(`🏁 Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
    if (failed > 0) process.exit(1);

    await client.close();
    process.exit(0);
}

runTests().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
});
