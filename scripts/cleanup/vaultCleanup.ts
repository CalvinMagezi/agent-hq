/**
 * One-time Vault Cleanup — removes accumulated damage from old cron system.
 *
 * Usage:
 *   bun scripts/cleanup/vaultCleanup.ts --dry-run    # preview what will happen
 *   bun scripts/cleanup/vaultCleanup.ts --execute     # actually do it
 *
 * What it cleans:
 *   1. Auto-generated insight files in Notebooks/Insights/
 *   2. Injected "## Related Notes" sections (<!-- agent-hq-graph-links -->)
 *   3. Sync-conflict duplicate files
 *   4. Auto-generated MOC files in _moc/
 *   5. Stale graph_links + link_state DB tables
 *   6. Creates Notebooks/Daily Synthesis/ for the new touchpoint
 */

import * as fs from "fs";
import * as path from "path";

const args = process.argv.slice(2);
const DRY_RUN = !args.includes("--execute");
const VAULT_PATH = process.env.VAULT_PATH ?? path.join(import.meta.dir, "../../.vault");

if (!fs.existsSync(VAULT_PATH)) {
    console.error(`Vault not found at: ${VAULT_PATH}`);
    process.exit(1);
}

console.log(`\n${DRY_RUN ? "🔍 DRY RUN" : "🔥 EXECUTING"} — Vault cleanup at ${VAULT_PATH}\n`);

let totalDeleted = 0;
let totalModified = 0;

// ── Helper ────────────────────────────────────────────────────────────

function walkDir(dir: string, cb: (fullPath: string, relPath: string) => void): void {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(VAULT_PATH, full);
        if (entry.isDirectory()) {
            walkDir(full, cb);
        } else {
            cb(full, rel);
        }
    }
}

// ── Step 1: Delete auto-generated insight files ──────────────────────

console.log("Step 1: Checking Notebooks/Insights/ for auto-generated files...");
const insightsDir = path.join(VAULT_PATH, "Notebooks", "Insights");

if (fs.existsSync(insightsDir)) {
    const matter = require("gray-matter");
    const workerTags = new Set(["vault-worker", "orphan-rescue", "gap-analysis", "connections", "enrichment"]);

    walkDir(insightsDir, (fullPath, relPath) => {
        if (!fullPath.endsWith(".md")) return;
        try {
            const raw = fs.readFileSync(fullPath, "utf-8");
            const { data } = matter(raw);
            const isWorkerSource = data.source === "vault-worker";
            const hasWorkerTag = Array.isArray(data.tags) && data.tags.some((t: string) => workerTags.has(t));
            const isSyncConflict = fullPath.includes(".sync-conflict-");

            if (isWorkerSource || hasWorkerTag || isSyncConflict) {
                console.log(`  ${DRY_RUN ? "WOULD DELETE" : "DELETING"}: ${relPath}`);
                if (!DRY_RUN) fs.unlinkSync(fullPath);
                totalDeleted++;
            }
        } catch {
            // Skip unparseable files
        }
    });
}
console.log(`  → ${totalDeleted} insight files ${DRY_RUN ? "would be" : ""} deleted\n`);

// ── Step 2: Strip agent-hq-graph-links sections ─────────────────────

console.log("Step 2: Stripping <!-- agent-hq-graph-links --> sections...");
const GRAPH_LINK_MARKER = "<!-- agent-hq-graph-links -->";
let strippedCount = 0;

walkDir(path.join(VAULT_PATH, "Notebooks"), (fullPath, relPath) => {
    if (!fullPath.endsWith(".md")) return;
    try {
        const raw = fs.readFileSync(fullPath, "utf-8");
        if (!raw.includes(GRAPH_LINK_MARKER)) return;

        const matter = require("gray-matter");
        const { data, content } = matter(raw);

        // Strip everything from marker to EOF
        const markerIdx = content.indexOf(GRAPH_LINK_MARKER);
        if (markerIdx === -1) return;
        const newContent = content.substring(0, markerIdx).trimEnd();

        // Remove relatedNotes from frontmatter
        delete data.relatedNotes;

        console.log(`  ${DRY_RUN ? "WOULD STRIP" : "STRIPPING"}: ${relPath}`);
        if (!DRY_RUN) {
            fs.writeFileSync(fullPath, matter.stringify(newContent, data), "utf-8");
        }
        strippedCount++;
        totalModified++;
    } catch {
        // Skip
    }
});
console.log(`  → ${strippedCount} notes ${DRY_RUN ? "would be" : ""} stripped\n`);

// ── Step 3: Delete sync-conflict files ──────────────────────────────

console.log("Step 3: Deleting sync-conflict files...");
let syncConflictCount = 0;

walkDir(VAULT_PATH, (fullPath, relPath) => {
    if (fullPath.includes(".sync-conflict-")) {
        console.log(`  ${DRY_RUN ? "WOULD DELETE" : "DELETING"}: ${relPath}`);
        if (!DRY_RUN) fs.unlinkSync(fullPath);
        syncConflictCount++;
        totalDeleted++;
    }
});
console.log(`  → ${syncConflictCount} sync-conflict files ${DRY_RUN ? "would be" : ""} deleted\n`);

// ── Step 4: Delete auto-generated MOCs ──────────────────────────────

console.log("Step 4: Checking _moc/ for auto-generated MOCs...");
const mocDir = path.join(VAULT_PATH, "_moc");
let mocCount = 0;

if (fs.existsSync(mocDir)) {
    const matter = require("gray-matter");
    walkDir(mocDir, (fullPath, relPath) => {
        if (!fullPath.endsWith(".md")) return;
        if (!path.basename(fullPath).startsWith("Topic - ")) return;
        try {
            const raw = fs.readFileSync(fullPath, "utf-8");
            const { data } = matter(raw);
            if (data.autoGenerated) {
                console.log(`  ${DRY_RUN ? "WOULD DELETE" : "DELETING"}: ${relPath}`);
                if (!DRY_RUN) fs.unlinkSync(fullPath);
                mocCount++;
                totalDeleted++;
            }
        } catch { /* skip */ }
    });
}
console.log(`  → ${mocCount} auto-generated MOCs ${DRY_RUN ? "would be" : ""} deleted\n`);

// ── Step 5: Clear graph_links + link_state tables ───────────────────

console.log("Step 5: Clearing stale graph_links + link_state DB tables...");
const searchDbPath = path.join(VAULT_PATH, "_embeddings", "search.db");

if (fs.existsSync(searchDbPath)) {
    try {
        const { Database } = require("bun:sqlite");
        const db = new Database(searchDbPath);

        // Check if tables exist before clearing
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
        const tableNames = tables.map(t => t.name);

        if (tableNames.includes("graph_links")) {
            const count = (db.prepare("SELECT COUNT(*) as c FROM graph_links").get() as { c: number }).c;
            console.log(`  graph_links: ${count} rows ${DRY_RUN ? "would be" : "being"} cleared`);
            if (!DRY_RUN) db.prepare("DELETE FROM graph_links").run();
        }

        if (tableNames.includes("link_state")) {
            const count = (db.prepare("SELECT COUNT(*) as c FROM link_state").get() as { c: number }).c;
            console.log(`  link_state: ${count} rows ${DRY_RUN ? "would be" : "being"} cleared`);
            if (!DRY_RUN) db.prepare("DELETE FROM link_state").run();
        }

        db.close();
    } catch (err) {
        console.log(`  ⚠ Could not clear DB: ${err}`);
    }
} else {
    console.log("  search.db not found — skipping");
}
console.log("");

// ── Step 6: Create Daily Synthesis directory ────────────────────────

const synthDir = path.join(VAULT_PATH, "Notebooks", "Daily Synthesis");
if (!fs.existsSync(synthDir)) {
    console.log("Step 6: Creating Notebooks/Daily Synthesis/...");
    if (!DRY_RUN) fs.mkdirSync(synthDir, { recursive: true });
    console.log(`  → ${DRY_RUN ? "Would create" : "Created"} ${synthDir}\n`);
} else {
    console.log("Step 6: Notebooks/Daily Synthesis/ already exists\n");
}

// ── Summary ─────────────────────────────────────────────────────────

console.log("━".repeat(60));
console.log(`${DRY_RUN ? "DRY RUN COMPLETE" : "CLEANUP COMPLETE"}`);
console.log(`  Files deleted:  ${totalDeleted}`);
console.log(`  Files modified: ${totalModified}`);
if (DRY_RUN) {
    console.log(`\nRun with --execute to apply these changes.`);
}
console.log("");
