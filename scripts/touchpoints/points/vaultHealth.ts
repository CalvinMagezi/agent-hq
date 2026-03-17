/**
 * Vault Health — Touch Point (Periodic)
 *
 * Structural health analysis: dead links, orphans, cluster gaps.
 * Replaces the vault-cartographer worker. Keeps SBLU integration alive
 * and archives results for training data.
 *
 * Runs every 6h via daemon periodic call.
 */

import * as fs from "fs";
import * as path from "path";
import type { TouchPoint } from "../types.js";
import { walkVaultFiles, resolveWikilinks } from "@repo/vault-native";
import { SBLUClient, type BaselineFn } from "../../sblu/sbluClient.js";

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

// ── Deterministic Analysis ────────────────────────────────────────────

function extractWikilinks(content: string): string[] {
    const links: string[] = [];
    const re = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
        const target = m[1]!.trim();
        if (target) links.push(target);
    }
    return links;
}

function collectMarkdownFiles(vaultPath: string): string[] {
    return walkVaultFiles(vaultPath, [".git", "node_modules", ".obsidian", "_embeddings"], "md");
}

function analyzeLinks(
    vaultPath: string,
    mdFiles: string[],
): { dead: DeadLink[]; linkMap: Map<string, string[]> } {
    const dead: DeadLink[] = [];
    const linkMap = new Map<string, string[]>();
    const allLinkTargets: { source: string; target: string }[] = [];

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

    const uniqueTargets = Array.from(new Set(allLinkTargets.map(t => t.target)));
    const resolvedPaths = resolveWikilinks(vaultPath, uniqueTargets);
    const resolutionMap = new Map<string, string | null>();
    uniqueTargets.forEach((t, i) => resolutionMap.set(t, resolvedPaths[i] ?? null));

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

function findOrphans(
    vaultPath: string,
    mdFiles: string[],
    allLinks: Map<string, string[]>,
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
        if (outbound.length === 0 && !hasInbound.has(relPath)) {
            const fullPath = path.join(vaultPath, relPath);
            let lastModified: string | null = null;
            try {
                const stat = fs.statSync(fullPath);
                lastModified = stat.mtime.toISOString().split("T")[0]!;
            } catch { /* ignore */ }
            orphans.push({ path: relPath, title: path.basename(relPath, ".md"), lastModified });
        }
    }
    return orphans;
}

// ── SBLU Prompt ───────────────────────────────────────────────────────

const CLUSTER_GAP_SYSTEM_PROMPT = `You are SBLU-1 Vault Cartographer, a precision knowledge graph analyst. You identify structural gaps in a personal knowledge vault by analyzing file paths and note titles. You output only valid JSON matching the requested schema. No prose, no markdown fences.`;

function buildClusterGapPrompt(mdFiles: string[], orphans: OrphanNote[]): string {
    const notebookFiles = mdFiles.filter(f => f.startsWith("Notebooks/")).slice(0, 200);
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

// ── Timestamp Helper ──────────────────────────────────────────────────

function localTs(): string {
    const d = new Date();
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? "+" : "-";
    const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");
    return (
        d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
        "T" + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()) +
        sign + pad(Math.floor(Math.abs(off) / 60)) + ":" + pad(Math.abs(off) % 60)
    );
}

// ── Touch Point ───────────────────────────────────────────────────────

export const vaultHealth: TouchPoint = {
    name: "vault-health",
    description: "Periodic dead link, orphan, and cluster gap analysis",
    triggers: [], // periodic — called via engine.runPeriodic()
    debounceMs: 0,

    async evaluate(_event, ctx) {
        console.log("[vault-health] Starting structural analysis...");

        const mdFiles = collectMarkdownFiles(ctx.vaultPath);
        if (mdFiles.length === 0) return null;

        const { dead: deadLinks, linkMap } = analyzeLinks(ctx.vaultPath, mdFiles);
        const orphans = findOrphans(ctx.vaultPath, mdFiles, linkMap);

        console.log(`[vault-health] Found ${deadLinks.length} dead links, ${orphans.length} orphans`);

        // ── SBLU cluster gap detection ───────────────────────────────
        let clusterGaps: ClusterGap[] = [];
        let sbluSource: "sblu" | "baseline" = "baseline";
        let shadowRun = false;

        try {
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

            clusterGaps = sbluResult.output?.cluster_gaps ?? [];
            sbluSource = sbluResult.source;
            shadowRun = sbluResult.shadowRun;
        } catch (err) {
            console.error("[vault-health] SBLU call failed (non-fatal):", err);
        }

        if (ctx.dryRun) {
            return {
                observation: `Would report: ${deadLinks.length} dead links, ${orphans.length} orphans, ${clusterGaps.length} gaps`,
                actions: [],
                meaningful: false,
            };
        }

        // ── Write LINK-HEALTH.md ─────────────────────────────────────
        const ts = localTs();
        const sbluBadge = shadowRun
            ? "🔬 SBLU shadow run (not used in production)"
            : sbluSource === "sblu"
                ? "🤖 Cluster gaps via SBLU-1 Cartographer"
                : "📐 Cluster gaps via deterministic baseline";

        const deadSection = deadLinks.length === 0
            ? "_No dead links found._"
            : deadLinks.map(d => `- \`${d.source}\` → \`[[${d.target}]]\``).join("\n");

        const orphanSection = orphans.length === 0
            ? "_No orphaned notes found._"
            : orphans
                .map(o => `- **${o.title}** (\`${o.path}\`)${o.lastModified ? ` — last modified ${o.lastModified}` : ""}`)
                .join("\n");

        const gapSection = clusterGaps.length === 0
            ? "_No cluster gaps identified._"
            : clusterGaps
                .map(g => {
                    const notesList = g.notes.map(n => `\`${n}\``).join(", ");
                    return `- **[${g.confidence.toUpperCase()}]** ${g.suggested_link}\n  Notes: ${notesList}`;
                })
                .join("\n");

        const reportContent = `---
noteType: system-file
fileName: link-health
lastUpdated: "${ts}"
brokenCount: ${deadLinks.length}
orphanCount: ${orphans.length}
clusterGapCount: ${clusterGaps.length}
sbluSource: "${sbluSource}"
shadowRun: ${shadowRun}
---
# Link Health Report

**Last Run:** ${ts}
**Source:** ${sbluBadge}

## Summary

| Metric | Count |
|--------|-------|
| Dead Links | ${deadLinks.length} |
| Orphaned Notes | ${orphans.length} |
| Cluster Gaps | ${clusterGaps.length} |

## Dead Links

${deadSection}

## Orphaned Notes

${orphanSection}

## Cluster Gaps

${gapSection}

---
_Generated by vault-health touchpoint on ${ts.split("T")[0]}_
`;

        const reportPath = path.join(ctx.vaultPath, "_system", "LINK-HEALTH.md");
        fs.mkdirSync(path.dirname(reportPath), { recursive: true });
        fs.writeFileSync(reportPath, reportContent, "utf-8");

        // ── Archive for SBLU training data ───────────────────────────
        // extract.ts (line 107) looks for _logs/YYYY-MM-DD/LINK-HEALTH.md
        const dateStr = ts.split("T")[0]!;
        const archiveDir = path.join(ctx.vaultPath, "_logs", dateStr);
        try {
            fs.mkdirSync(archiveDir, { recursive: true });
            fs.writeFileSync(path.join(archiveDir, "LINK-HEALTH.md"), reportContent, "utf-8");
        } catch (err) {
            console.error("[vault-health] Failed to archive LINK-HEALTH.md:", err);
        }

        const gapNote = shadowRun
            ? ` (shadow — gaps not used)`
            : clusterGaps.length > 0
                ? ` — ${clusterGaps.length} cluster gap(s) found`
                : "";

        return {
            observation: `Analyzed ${mdFiles.length} files: ${deadLinks.length} dead link(s), ${orphans.length} orphan(s)${gapNote}`,
            actions: [`HEALTH: dead=${deadLinks.length} orphans=${orphans.length} gaps=${clusterGaps.length}`],
            meaningful: deadLinks.length > 50 || orphans.length > 20,
        };
    },
};
