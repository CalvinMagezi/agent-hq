import { VaultClient } from "./src/index";
import { VaultEventBus } from "./src/events";
import * as path from "path";
import * as fs from "fs";

// Use relative path for testing inside packages/vault-client
const VAULT_PATH = path.resolve(__dirname, "../../.vault");
const client = new VaultClient(VAULT_PATH);
const events = new VaultEventBus(VAULT_PATH);

async function runTests() {
    console.log("🧪 Starting Vault Connectivity Tests...\n");

    // 1. Test Event Bus
    console.log("1️⃣ Testing VaultEventBus...");
    const eventId = events.emit("test-event", "test-runner", { mockData: 123 });
    console.log(`✅ Emitted event: ${eventId}`);

    const today = new Date().toISOString().split("T")[0];
    const logs = events.readEvents(today);
    const found = logs.find(e => e.id === eventId);
    if (found && found.payload.mockData === 123) {
        console.log(`✅ Successfully read back emitted event from ${today}.log\n`);
    } else {
        console.error("❌ Failed to read event back from log file\n");
        process.exit(1);
    }

    // 2. Test Locking Mechanism
    console.log("2️⃣ Testing Atomic Locking...");
    const testFilePath = "_system/TEST_LOCK.md";
    const absPath = path.join(VAULT_PATH, testFilePath);

    // Clean up previous failure if exists
    try { if (fs.existsSync(absPath)) fs.unlinkSync(absPath); } catch { }

    const token1 = await client.acquireLock(absPath);
    console.log(`✅ Acquired lock 1 with token: ${token1}`);

    try {
        await client.acquireLock(absPath, 1000); // Should fail because it's locked and lock age < 1000ms
        console.error("❌ Expected acquireLock to fail, but it succeeded.");
        process.exit(1);
    } catch (err: any) {
        if (err.message.includes("File is locked")) {
            console.log("✅ Correctly rejected second lock attempt (concurrency protected)");
        } else {
            console.error("❌ Unexpected error during second lock attempt:", err);
            process.exit(1);
        }
    }

    await client.releaseLock(absPath, token1);
    console.log("✅ Released lock 1\n");

    // 3. Test Optimistic Versioning
    console.log("3️⃣ Testing Optimistic Versioning...");
    const targetFolder = "_system";
    const noteTitle = "TEST_VERSION_TRACKER";

    const createdPath = await client.createNote(targetFolder, noteTitle, "Initial content", {
        noteType: "system-file"
    });
    console.log(`✅ Created test note at ${createdPath}`);

    let note = await client.readNote(createdPath);
    let v1 = note.content;

    console.log(`✅ Version tracking check...`);
    await client.updateNote(createdPath, "Updated content", { testUpdate: true });
    console.log(`✅ Successfully updated note with lock acquisition inside updateNote()`);

    // Verify the frontmatter directly via fs, since the readNote parser strips most of it in types.ts
    const rawContent = fs.readFileSync(createdPath, "utf-8");
    if (rawContent.includes("version: 2") && rawContent.includes("lastModifiedBy: hq-agent")) {
        console.log("✅ Note version correctly incremented to 2 and lastModifiedBy set to hq-agent");
    } else {
        console.error("❌ Frontmatter versioning failed.\nRaw Document:\n", rawContent);
        process.exit(1);
    }

    // Cleanup
    fs.unlinkSync(createdPath);
    console.log("\n🎉 All VaultClient internal tests passed!");
}

runTests().catch(err => {
    console.error("Unhandled top-level error:", err);
    process.exit(1);
});
