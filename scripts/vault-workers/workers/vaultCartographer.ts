/**
 * Vault Cartographer (SBLU-1)
 *
 * Structural health analysis for the vault:
 *   - Dead links:      [[wikilinks]] that point to non-existent files
 *   - Orphans:         Notes with zero inbound AND zero outbound links
 *   - Cluster gaps:    Notes that are semantically related but not connected
 *                      (detected by SBLU-1 model via Ollama)
 *
 * Runs every 4 hours. Writes report to _system/LINK-HEALTH.md.
 *
 * Trust levels (controlled by _system/SBLU-REGISTRY.md):
 *   0 — baseline only (deterministic dead-links + orphans, no SBLU)
 *   1 — shadow (SBLU cluster-gap detection runs but output only logged)
 *   2 — canary (5% of runs use SBLU cluster gaps in report)
 *   3 — majority (70% use SBLU)
 *   4 — primary (SBLU handles all cluster gap detection)
 */

import * as fs from "fs";
import * as path from "path";
import type { VaultWorker, WorkerContext, WorkerResult } from "../types.js";
import { SBLUClient } from "../../sblu/sbluClient.js";

// ── Types ─────────────────────────────────────────────────────────────

interface DeadLink {
    source: string;
    target: string;
}

interface OrphanNote {
    path: string;
    title: string;
    lastModified: string | null;
}

interface ClusterGap {
    notes: string[];
    suggested_link: string;
    confidence: "high" | "medium" | "low";
}

export interface CartographerOutput {
    dead_links: DeadLink[];
    orphans: OrphanNote[];
    cluster_gaps: ClusterGap[];
}

// ── Deterministic Analysis ────────────────────────────────────────────

/** Extract all [[wikilinks]] from markdown content */
function extractWikilinks(content: string): string[] {
    const links: string[] = [];
    // Matches [[target]] and [[target|alias]]
    const re = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
        const target = m[1]!.trim();
        if (target) links.push(target);
    }
    return links;
}

/** Resolve a wikilink target to a vault-relative path */
function resolveWikilink(target: string, vaultPath: string): string | null {
    // Try with and without .md extension
    const candidates = [
        path.join(vaultPath, target),
        path.join(vaultPath, target + ".md"),
    ];

    // Also try a recursive search in Notebooks/ for short names
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }

    // Try to find the file anywhere in the vault (Obsidian resolves by filename)
    try {
        const found = findFileByName(vaultPath, target + ".md");
        if (found) return found;
    } catch {
        // ignore
    }

    return null;
}

/** Recursively find a file by exact name in the vault */
function findFileByName(dir: string, name: string, maxDepth = 4, depth = 0): string | null {
    if (depth > maxDepth) return null;
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return null;
    }

    for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const found = findFileByName(full, name, maxDepth, depth + 1);
            if (found) return found;
        } else if (entry.name === name) {
            return full;
        }
    }
    return null;
}

/** Walk the vault and collect all .md file paths (relative to vault root) */
function collectMarkdownFiles(vaultPath: string, maxFiles = 2000): string[] {
    const files: string[] = [];
    const skipDirs = new Set(["_embeddings", ".git", "node_modules", ".obsidian"]);

    function walk(dir: string): void {
        if (files.length >= maxFiles) return;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            if (entry.name.startsWith(".")) continue;
            const full = path.join(dir, entry.name);
            const rel = path.relative(vaultPath, full);

            if (entry.isDirectory()) {
                if (skipDirs.has(entry.name)) continue;
                walk(full);
            } else if (entry.name.endsWith(".md")) {
                files.push(rel);
            }
        }
    }

    walk(vaultPath);
    return files;
}

/** Find all dead links in the vault */
async function findDeadLinks(
    vaultPath: string,
    mdFiles: string[],
): Promise<DeadLink[]> {
    const dead: DeadLink[] = [];

    for (const relPath of mdFiles) {
        // Skip system/job/log files — they contain docs/examples with non-real wikilinks
        if (relPath.startsWith("_")) continue;

        const fullPath = path.join(vaultPath, relPath);
        let content: string;
        try {
            content = fs.readFileSync(fullPath, "utf-8");
        } catch {
            continue;
        }

        const links = extractWikilinks(content);
        for (const target of links) {
            const resolved = resolveWikilink(target, vaultPath);
            if (!resolved) {
                dead.push({ source: relPath, target });
            }
        }
    }

    return dead;
}

/** Find all orphan notes (no inbound AND no outbound links) */
function findOrphans(
    vaultPath: string,
    mdFiles: string[],
    allLinks: Map<string, string[]>, // source → [targets]
): OrphanNote[] {
    // Build set of all targets that have at least one inbound link
    const hasInbound = new Set<string>();
    for (const targets of allLinks.values()) {
        for (const t of targets) {
            hasInbound.add(t);
        }
    }

    const orphans: OrphanNote[] = [];

    for (const relPath of mdFiles) {
        // Only check Notebooks (not system/job files)
        if (!relPath.startsWith("Notebooks/")) continue;

        const outbound = allLinks.get(relPath) ?? [];
        const isOrphan = outbound.length === 0 && !hasInbound.has(relPath);

        if (isOrphan) {
            const fullPath = path.join(vaultPath, relPath);
            let lastModified: string | null = null;
            try {
                const stat = fs.statSync(fullPath);
                lastModified = stat.mtime.toISOString().split("T")[0]!;
            } catch {
                // ignore
            }
            const title = path.basename(relPath, ".md");
            orphans.push({ path: relPath, title, lastModified });
        }
    }

    return orphans;
}

// ── SBLU Prompt ───────────────────────────────────────────────────────

function buildClusterGapPrompt(
    mdFiles: string[],
    orphans: OrphanNote[],
): string {
    // Build a compact file-tree summary (only Notebooks, max 200 files)
    const notebookFiles = mdFiles
        .filter(f => f.startsWith("Notebooks/"))
        .slice(0, 200);

    const fileTree = notebookFiles.join("\n");
    const orphanList = orphans.map(o => `- ${o.path}`).join("\n") || "(none)";

    return `You are analyzing a personal knowledge vault. Here are the note file paths:

## Notes (${notebookFiles.length} shown)
${fileTree}

## Currently Orphaned Notes
${orphanList}

Identify 3-8 pairs or small groups of notes that are likely semantically related but are NOT yet linked to each other. Focus on notes that share a topic, project, or concept based on their file paths/titles.

Return ONLY valid JSON with this exact schema:
{
  "cluster_gaps": [
    {
      "notes": ["path/to/note-a.md", "path/to/note-b.md"],
      "suggested_link": "Brief description of why these should be connected",
      "confidence": "high" | "medium" | "low"
    }
  ]
}

Rules:
- Only suggest notes that actually appear in the file list above
- "confidence" = high if the connection is obvious, medium if likely, low if speculative
- Maximum 8 cluster gaps
- No markdown, only JSON`;
}

const CLUSTER_GAP_SYSTEM_PROMPT = `You are SBLU-1 Vault Cartographer, a precision knowledge graph analyst. You identify structural gaps in a personal knowledge vault by analyzing file paths and note titles. You output only valid JSON matching the requested schema. No prose, no markdown fences.`;

// ── Health Report Writer ──────────────────────────────────────────────

function localDate(): string {
    return new Date().toISOString().split("T")[0]!;
}

function localTs(): string {
    const d = new Date();
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? "+" : "-";
    const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");
    return (
        d.getFullYear() +
        "-" + pad(d.getMonth() + 1) +
        "-" + pad(d.getDate()) +
        "T" + pad(d.getHours()) +
        ":" + pad(d.getMinutes()) +
        ":" + pad(d.getSeconds()) +
        sign + pad(Math.floor(Math.abs(off) / 60)) +
        ":" + pad(Math.abs(off) % 60)
    );
}

async function writeLinkHealthReport(
    vaultPath: string,
    output: CartographerOutput,
    sbluSource: "sblu" | "baseline",
    shadowRun: boolean,
): Promise<void> {
    const ts = localTs();
    const date = localDate();

    const deadSection = output.dead_links.length === 0
        ? "_No dead links found._"
        : output.dead_links.map(d => `- \`${d.source}\` → \`[[${d.target}]]\``).join("\n");

    const orphanSection = output.orphans.length === 0
        ? "_No orphaned notes found._"
        : output.orphans
            .map(o => `- **${o.title}** (\`${o.path}\`)${o.lastModified ? ` — last modified ${o.lastModified}` : ""}`)
            .join("\n");

    const gapSection = output.cluster_gaps.length === 0
        ? "_No cluster gaps identified._"
        : output.cluster_gaps
            .map(g => {
                const notesList = g.notes.map(n => `\`${n}\``).join(", ");
                return `- **[${g.confidence.toUpperCase()}]** ${g.suggested_link}\n  Notes: ${notesList}`;
            })
            .join("\n");

    const sbluBadge = shadowRun
        ? "🔬 SBLU shadow run (not used in production)"
        : sbluSource === "sblu"
            ? "🤖 Cluster gaps via SBLU-1 Cartographer"
            : "📐 Cluster gaps via deterministic baseline";

    const content = `---
noteType: system-file
fileName: link-health
lastUpdated: "${ts}"
brokenCount: ${output.dead_links.length}
orphanCount: ${output.orphans.length}
clusterGapCount: ${output.cluster_gaps.length}
sbluSource: "${sbluSource}"
shadowRun: ${shadowRun}
---
# Link Health Report

**Last Run:** ${ts}
**Source:** ${sbluBadge}

## Summary

| Metric | Count |
|--------|-------|
| Dead Links | ${output.dead_links.length} |
| Orphaned Notes | ${output.orphans.length} |
| Cluster Gaps | ${output.cluster_gaps.length} |

## Dead Links

${deadSection}

## Orphaned Notes

${orphanSection}

## Cluster Gaps

${gapSection}

---
_Generated by SBLU-1 Vault Cartographer on ${date}_
`;

    const outPath = path.join(vaultPath, "_system", "LINK-HEALTH.md");
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, content, "utf-8");
}

// ── Worker Definition ─────────────────────────────────────────────────

export const vaultCartographer: VaultWorker = {
    name: "vault-cartographer",
    description: "SBLU-1: Dead links, orphan notes, and cluster gap analysis",
    intervalMs: 4 * 60 * 60 * 1000, // 4 hours
    batchSize: 2000,

    async run(ctx: WorkerContext): Promise<WorkerResult> {
        const result: WorkerResult = {
            processed: 0,
            created: 0,
            summary: "",
            llmCalls: 0,
            tokensUsed: { input: 0, output: 0 },
        };

        if (ctx.abortSignal.aborted) return { ...result, summary: "aborted" };

        console.log("[vault-cartographer] Starting structural analysis...");

        // ── 1. Collect all markdown files ───────────────────────────
        const mdFiles = collectMarkdownFiles(ctx.vaultPath, this.batchSize);
        result.processed = mdFiles.length;

        if (mdFiles.length === 0) {
            result.summary = "No markdown files found";
            return result;
        }

        // ── 2. Build link map: source → [resolved targets] ──────────
        const linkMap = new Map<string, string[]>();
        for (const relPath of mdFiles) {
            if (relPath.startsWith("_jobs") || relPath.startsWith("_logs")) continue;
            const fullPath = path.join(ctx.vaultPath, relPath);
            let content: string;
            try {
                content = fs.readFileSync(fullPath, "utf-8");
            } catch {
                continue;
            }
            const rawLinks = extractWikilinks(content);
            // Store resolved relative paths
            const resolved = rawLinks
                .map(t => resolveWikilink(t, ctx.vaultPath))
                .filter(Boolean)
                .map(abs => path.relative(ctx.vaultPath, abs!));
            linkMap.set(relPath, resolved);
        }

        if (ctx.abortSignal.aborted) return { ...result, summary: "aborted" };

        // ── 3. Deterministic analysis ────────────────────────────────
        const deadLinks = await findDeadLinks(ctx.vaultPath, mdFiles);
        const orphans = findOrphans(ctx.vaultPath, mdFiles, linkMap);

        console.log(
            `[vault-cartographer] Found ${deadLinks.length} dead links, ${orphans.length} orphans`,
        );

        if (ctx.abortSignal.aborted) return { ...result, summary: "aborted" };

        // ── 4. SBLU cluster gap detection ────────────────────────────
        const sbluClient = new SBLUClient(ctx.vaultPath);
        const prompt = buildClusterGapPrompt(mdFiles, orphans);

        type GapResponse = { cluster_gaps: ClusterGap[] };

        const baseline: BaselineFn<GapResponse> = async () => ({ cluster_gaps: [] });

        const sbluResult = await sbluClient.call<GapResponse>(
            "cartographer",
            prompt,
            CLUSTER_GAP_SYSTEM_PROMPT,
            baseline,
            { maxTokens: 1024, timeoutMs: 45_000, parseJson: true },
        );

        if (sbluResult.source === "sblu" || sbluResult.shadowRun) {
            result.llmCalls++;
            result.tokensUsed.input += Math.ceil(prompt.length / 4);
            result.tokensUsed.output += Math.ceil(
                JSON.stringify(sbluResult.output).length / 4,
            );
        }

        const clusterGaps = sbluResult.output?.cluster_gaps ?? [];

        // ── 5. Write health report ───────────────────────────────────
        const cartographerOutput: CartographerOutput = {
            dead_links: deadLinks,
            orphans,
            cluster_gaps: clusterGaps,
        };

        await writeLinkHealthReport(
            ctx.vaultPath,
            cartographerOutput,
            sbluResult.source,
            sbluResult.shadowRun,
        );

        // ── 6. Audit log ─────────────────────────────────────────────
        ctx.audit.append({
            worker: this.name,
            action: "analyzed",
            targetPath: "_system/LINK-HEALTH.md",
            details: `files=${mdFiles.length} dead=${deadLinks.length} orphans=${orphans.length} gaps=${clusterGaps.length} src=${sbluResult.source}`,
        });

        if (sbluResult.shadowRun && sbluResult.similarity !== undefined) {
            ctx.audit.append({
                worker: this.name,
                action: "shadow-comparison",
                details: `similarity=${sbluResult.similarity.toFixed(3)} model=${sbluResult.model}`,
            });
        }

        const gapNote = sbluResult.shadowRun
            ? ` (shadow — gaps not used)`
            : clusterGaps.length > 0
                ? ` — ${clusterGaps.length} cluster gap(s) found`
                : "";

        result.summary = `Analyzed ${mdFiles.length} files: ${deadLinks.length} dead link(s), ${orphans.length} orphan(s)${gapNote}`;

        return result;
    },
};

// Re-export types for external use
export type { DeadLink, OrphanNote, ClusterGap };
