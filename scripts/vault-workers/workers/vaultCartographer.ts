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
import { SBLUClient, type BaselineFn } from "../../sblu/sbluClient.js";
import { walkVaultFiles, resolveWikilinks } from "@repo/vault-native";

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

/** Walk the vault and collect all .md file paths (relative to vault root) */
function collectMarkdownFiles(vaultPath: string, _maxFiles = 2000): string[] {
    const skipDirs = [".git", "node_modules", ".obsidian", "_embeddings"];
    return walkVaultFiles(vaultPath, skipDirs, "md");
}

/** Find all dead links and build a link map in one pass (optimized) */
function analyzeLinks(
    vaultPath: string,
    mdFiles: string[],
): { dead: DeadLink[], linkMap: Map<string, string[]> } {
    const dead: DeadLink[] = [];
    const linkMap = new Map<string, string[]>();
    const allLinkTargets: { source: string; target: string }[] = [];

    // 1. Collect all raw links
    for (const relPath of mdFiles) {
        if (relPath.startsWith("_jobs") || relPath.startsWith("_logs") || relPath.startsWith("_system")) continue;
        const fullPath = path.join(vaultPath, relPath);
        let content: string;
        try {
            content = fs.readFileSync(fullPath, "utf-8");
        } catch {
            continue;
        }
        const rawLinks = extractWikilinks(content);
        for (const target of rawLinks) {
            allLinkTargets.push({ source: relPath, target });
        }
    }

    // 2. Resolve all unique targets in one native batch
    const uniqueTargets = Array.from(new Set(allLinkTargets.map(t => t.target)));
    const resolvedPaths = resolveWikilinks(vaultPath, uniqueTargets);
    const resolutionMap = new Map<string, string | null>();
    uniqueTargets.forEach((t, i) => resolutionMap.set(t, resolvedPaths[i] ?? null));

    // 3. Map back and detect dead links
    for (const { source, target } of allLinkTargets) {
        const resolved = resolutionMap.get(target);
        if (resolved) {
            const current = linkMap.get(source) ?? [];
            current.push(resolved);
            linkMap.set(source, current);
        } else {
            dead.push({ source, target });
        }
    }

    return { dead, linkMap };
}

/** Find all orphan notes (no inbound AND no outbound links) */
function findOrphans(
    vaultPath: string,
    mdFiles: string[],
    allLinks: Map<string, string[]>, // source → [targets]
): OrphanNote[] {
    const hasInbound = new Set<string>();
    for (const targets of allLinks.values()) {
        for (const t of targets) {
            hasInbound.add(t);
        }
    }

    const orphans: OrphanNote[] = [];
    for (const relPath of mdFiles) {
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
_Generated by SBLU-1 Vault Cartographer on ${localTs().split("T")[0]}_
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

        const mdFiles = collectMarkdownFiles(ctx.vaultPath, this.batchSize);
        result.processed = mdFiles.length;

        if (mdFiles.length === 0) {
            result.summary = "No markdown files found";
            return result;
        }

        const { dead: deadLinks, linkMap } = analyzeLinks(ctx.vaultPath, mdFiles);
        const orphans = findOrphans(ctx.vaultPath, mdFiles, linkMap);

        console.log(`[vault-cartographer] Found ${deadLinks.length} dead links, ${orphans.length} orphans`);

        if (ctx.abortSignal.aborted) return { ...result, summary: "aborted" };

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
            result.tokensUsed.output += Math.ceil(JSON.stringify(sbluResult.output).length / 4);
        }

        const clusterGaps = sbluResult.output?.cluster_gaps ?? [];

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

        ctx.audit.append({
            worker: this.name,
            action: "skipped", // Using skipped for analysis entries to stay within AuditEntry types
            targetPath: "_system/LINK-HEALTH.md",
            details: `analyzed: dead=${deadLinks.length} orphans=${orphans.length} gaps=${clusterGaps.length}`,
        });

        const gapNote = sbluResult.shadowRun
            ? ` (shadow — gaps not used)`
            : clusterGaps.length > 0
                ? ` — ${clusterGaps.length} cluster gap(s) found`
                : "";

        result.summary = `Analyzed ${mdFiles.length} files: ${deadLinks.length} dead link(s), ${orphans.length} orphan(s)${gapNote}`;

        return result;
    },
};

export type { DeadLink, OrphanNote, ClusterGap };
