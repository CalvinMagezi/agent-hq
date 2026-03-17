/**
 * Connection Weaver — Touch Point
 *
 * Adds light "See Also" links to changed notes using semantic search.
 * Chains from tag-suggester in the new-note-quality chain.
 *
 * Key differences from old note-linking cron:
 *   - Only fires on the CHANGED note, never bulk re-scans
 *   - Skips insight/system/digest files (breaks the feedback loop)
 *   - No bidirectional enforcement
 *   - No similarity scores shown — just clean wikilinks
 *   - Zero LLM calls — pure semantic search
 */

import * as fs from "fs";
import * as path from "path";
import matter from "gray-matter";
import type { TouchPoint } from "../types.js";

const SEE_ALSO_MARKER = "<!-- hq-see-also -->";
const DEBOUNCE_MS = 60_000; // 1 minute — wait for tag-suggester chain
const MIN_CONTENT_LENGTH = 100;
const SIMILARITY_THRESHOLD = 0.70;
const MAX_LINKS = 5;
const NEAR_DUPE_THRESHOLD = 0.95;
const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

const SKIP_PATH_SEGMENTS = [
    "Insights/",
    "_moc/",
    "Daily Synthesis/",
    "Daily Digest/",
    "Memories/",
    "_system/",
    "_jobs/",
    "_logs/",
    "_threads/",
];

interface WeaverState {
    [relPath: string]: {
        lastWoven: string;
        contentHash: string;
        links: string[];
    };
}

function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function loadState(vaultPath: string): WeaverState {
    const statePath = path.join(vaultPath, "_system", ".connection-weaver-state.json");
    try {
        if (fs.existsSync(statePath)) {
            return JSON.parse(fs.readFileSync(statePath, "utf-8"));
        }
    } catch { /* fresh state */ }
    return {};
}

function saveState(vaultPath: string, state: WeaverState): void {
    const statePath = path.join(vaultPath, "_system", ".connection-weaver-state.json");
    // Prune entries older than 30 days
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    for (const [key, val] of Object.entries(state)) {
        if (new Date(val.lastWoven).getTime() < cutoff) {
            delete state[key];
        }
    }
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
}

export const connectionWeaver: TouchPoint = {
    name: "connection-weaver",
    description: "Add light See Also links to changed notes using semantic search",
    triggers: ["note:created", "note:modified"],
    pathFilter: "Notebooks/",
    debounceMs: DEBOUNCE_MS,

    async evaluate(event, ctx) {
        const relPath = event.path;
        const fullPath = path.join(ctx.vaultPath, relPath);

        // ── Guard: basic checks ──────────────────────────────────────
        if (!relPath.endsWith(".md") || !fs.existsSync(fullPath)) return null;

        // Skip system/insight/digest paths
        for (const skip of SKIP_PATH_SEGMENTS) {
            if (relPath.includes(skip)) return null;
        }

        let raw: string;
        try {
            raw = fs.readFileSync(fullPath, "utf-8");
        } catch {
            return null;
        }

        let parsed: ReturnType<typeof matter>;
        try {
            parsed = matter(raw);
        } catch {
            return null;
        }

        // Strip existing see-also section for content hash
        const contentForHash = parsed.content.replace(
            new RegExp(`${escapeRegex(SEE_ALSO_MARKER)}[\\s\\S]*$`),
            "",
        ).trim();

        if (contentForHash.length < MIN_CONTENT_LENGTH) return null;

        // ── Guard: cooldown check ────────────────────────────────────
        const contentHash = Bun.hash(contentForHash).toString(36);
        const state = loadState(ctx.vaultPath);
        const prev = state[relPath];

        if (prev) {
            const elapsed = Date.now() - new Date(prev.lastWoven).getTime();
            if (elapsed < COOLDOWN_MS && prev.contentHash === contentHash) {
                return null; // Same content, recently woven
            }
        }

        // ── Search for similar notes ─────────────────────────────────
        let similar: Array<{ notePath: string; title: string; relevance: number }>;
        try {
            similar = ctx.search.findSimilarNotes(relPath, 8, SIMILARITY_THRESHOLD);
        } catch {
            return null;
        }

        // Filter out unwanted paths and near-dupes
        const filtered = similar.filter(hit => {
            if (hit.relevance > NEAR_DUPE_THRESHOLD) return false;
            for (const skip of SKIP_PATH_SEGMENTS) {
                if (hit.notePath.includes(skip)) return false;
            }
            return true;
        });

        const topLinks = filtered.slice(0, MAX_LINKS);
        if (topLinks.length === 0) return null;

        if (ctx.dryRun) {
            return {
                observation: `Would link ${relPath} to ${topLinks.length} note(s)`,
                actions: [],
                meaningful: false,
            };
        }

        // ── Write See Also section ───────────────────────────────────
        // Backup before modify
        const backupDir = path.join(ctx.vaultPath, "_system", ".touchpoint-backups");
        try {
            if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
            const backupPath = path.join(backupDir, `${path.basename(fullPath)}.${Date.now()}.bak`);
            fs.writeFileSync(backupPath, raw, "utf-8");
        } catch { /* non-fatal */ }

        const seeAlsoLines = [
            SEE_ALSO_MARKER,
            "## See Also",
            "",
            ...topLinks.map(hit => `- [[${hit.title}]]`),
            "",
        ];
        const seeAlsoSection = seeAlsoLines.join("\n");

        let newContent: string;
        if (parsed.content.includes(SEE_ALSO_MARKER)) {
            newContent = parsed.content.replace(
                new RegExp(`${escapeRegex(SEE_ALSO_MARKER)}[\\s\\S]*$`),
                seeAlsoSection,
            );
        } else {
            newContent = parsed.content.trimEnd() + "\n\n" + seeAlsoSection;
        }

        try {
            fs.writeFileSync(fullPath, matter.stringify(newContent.trim(), parsed.data), "utf-8");
        } catch {
            return null;
        }

        // ── Update state ─────────────────────────────────────────────
        state[relPath] = {
            lastWoven: new Date().toISOString(),
            contentHash,
            links: topLinks.map(h => h.notePath),
        };
        saveState(ctx.vaultPath, state);

        const linkTitles = topLinks.map(h => h.title).join(", ");
        return {
            observation: `Wove ${topLinks.length} connection(s) for ${path.basename(relPath, ".md")}`,
            actions: [`SEE_ALSO: [${linkTitles}]`],
            meaningful: false,
        };
    },
};
