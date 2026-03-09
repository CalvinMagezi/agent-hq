/**
 * Fix FTS5 schema mismatch — "no such column: insights"
 *
 * The notes_fts virtual table was previously created with an `insights` column
 * that was removed. The FTS5 internal data tables still reference the old schema,
 * causing SQLiteError on any MATCH query. This script drops and rebuilds the
 * FTS5 table, then resets all notes to pending re-embedding.
 *
 * Usage: bun scripts/sblu/fix-fts-index.ts
 */

import { Database } from "bun:sqlite";
import * as path from "path";
import * as fs from "fs";

const VAULT_PATH = process.env.VAULT_PATH ?? ".vault";
const dbPath = path.join(VAULT_PATH, "_embeddings", "search.db");

if (!fs.existsSync(dbPath)) {
    console.error(`search.db not found at ${dbPath}`);
    process.exit(1);
}

const db = new Database(dbPath);

console.log("Step 1: Dropping FTS5 virtual table and all shadow tables...");

// The main virtual table DROP cascades to shadow tables in SQLite FTS5
db.exec("DROP TABLE IF EXISTS notes_fts");
// Explicitly drop shadow tables in case they were left behind
for (const suffix of ["_data", "_idx", "_content", "_docsize", "_config"]) {
    try { db.exec(`DROP TABLE IF EXISTS notes_fts${suffix}`); } catch { /* ok */ }
}

console.log("Step 2: Recreating FTS5 table with correct 4-column schema...");

db.exec(`
    CREATE VIRTUAL TABLE notes_fts USING fts5(
        path, title, content, tags,
        content='',
        tokenize='porter ascii'
    )
`);

db.close();
console.log("  ✓ FTS5 table rebuilt cleanly");

// Step 3: Reset embedded notes so the daemon re-indexes them
console.log("Step 3: Resetting embedded notes to pending (daemon will re-index in batches)...");

let reset = 0;
const notebooksDir = path.join(VAULT_PATH, "Notebooks");

function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith(".md")) continue;
        const content = fs.readFileSync(full, "utf-8");
        if (
            content.includes("embeddingStatus: embedded") ||
            content.includes("embeddingStatus: failed")
        ) {
            const updated = content
                .replace(/embeddingStatus: embedded/g, "embeddingStatus: pending")
                .replace(/embeddingStatus: failed/g, "embeddingStatus: pending");
            fs.writeFileSync(full, updated, "utf-8");
            reset++;
        }
    }
}

if (fs.existsSync(notebooksDir)) {
    walk(notebooksDir);
}

console.log(`  ✓ Reset ${reset} notes to embeddingStatus: pending`);
console.log("\nDone. The daemon embeddings task will re-index them within 30 minutes.");
console.log("topic-mocs will succeed after the first re-indexing batch completes.");
