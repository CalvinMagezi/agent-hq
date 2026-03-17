/**
 * Daily Synthesis — Touch Point (Periodic)
 *
 * Cross-pollinates today's news, vault changes, and memory insights
 * into one daily insight file. Replaces 5 old file types:
 * Daily Insights, Gap Analysis, Idea Connections, Orphan Suggestions,
 * Enrichment Suggestions.
 *
 * Runs once between 20:30-22:00 EAT (UTC+3) via daemon periodic call.
 * Uses 1 LLM call (Ollama qwen3.5:9b, free).
 */

import * as fs from "fs";
import * as path from "path";
import matter from "gray-matter";
import type { TouchPoint } from "../types.js";

const SYNTHESIS_DIR = "Notebooks/Daily Synthesis";
const NEWS_PULSE_MARKER = "<!-- agent-hq-news-pulse -->";
const EAT_OFFSET_HOURS = 3; // UTC+3

const SYSTEM_PROMPT = `You are a daily synthesis engine for a personal knowledge vault owned by a CTO in Kampala, Uganda.
Find 2-4 unexpected connections between today's news and the user's active projects/ideas.
If AI model intelligence is provided, connect new models to the user's projects — e.g., a cheaper model could reduce Agent-HQ agent costs, a better coding model could improve code generation quality.
Be specific, non-obvious, and actionable. Under 400 words. No boilerplate. No generic advice.
Format each connection as a short paragraph with a bold title.`;

function getEATDate(): { hours: number; minutes: number; dateStr: string } {
    const now = new Date();
    const eatMs = now.getTime() + EAT_OFFSET_HOURS * 60 * 60 * 1000;
    const eat = new Date(eatMs);
    const dateStr = eat.toISOString().split("T")[0]!;
    return { hours: eat.getUTCHours(), minutes: eat.getUTCMinutes(), dateStr };
}

function scanRecentFiles(dir: string, withinMs: number, maxFiles: number): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir)) return results;
    const cutoff = Date.now() - withinMs;

    const walk = (d: string) => {
        const entries = fs.readdirSync(d, { withFileTypes: true });
        for (const entry of entries) {
            if (results.length >= maxFiles) return;
            const full = path.join(d, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.name.endsWith(".md")) {
                try {
                    const stat = fs.statSync(full);
                    if (stat.mtimeMs > cutoff) {
                        results.push(path.basename(entry.name, ".md"));
                    }
                } catch { /* skip */ }
            }
        }
    };

    walk(dir);
    return results;
}

export const dailySynthesis: TouchPoint = {
    name: "daily-synthesis",
    description: "Cross-pollinate today's news, vault changes, and memories into one daily insight",
    triggers: [], // periodic only — called via engine.runPeriodic()
    debounceMs: 0,

    async evaluate(_event, ctx) {
        // ── Time gate: only run 20:30-22:00 EAT ─────────────────────
        const { hours, minutes, dateStr } = getEATDate();
        const timeMinutes = hours * 60 + minutes;
        if (timeMinutes < 20 * 60 + 30 || timeMinutes >= 22 * 60) return null;

        // ── Dedup: skip if today's file exists ──────────────────────
        const synthDir = path.join(ctx.vaultPath, SYNTHESIS_DIR);
        if (!fs.existsSync(synthDir)) {
            fs.mkdirSync(synthDir, { recursive: true });
        }

        const todayFile = path.join(synthDir, `${dateStr}.md`);
        if (fs.existsSync(todayFile)) return null;

        // ── Gather signals (all read-only) ──────────────────────────
        const signals: string[] = [];
        const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

        // 1. News pulse
        const heartbeatPath = path.join(ctx.vaultPath, "_system", "HEARTBEAT.md");
        if (fs.existsSync(heartbeatPath)) {
            try {
                const hb = fs.readFileSync(heartbeatPath, "utf-8");
                const pulseStart = hb.indexOf(NEWS_PULSE_MARKER);
                if (pulseStart !== -1) {
                    const pulseContent = hb.substring(pulseStart + NEWS_PULSE_MARKER.length);
                    // Take first 500 chars of news
                    const newsSnippet = pulseContent.trim().substring(0, 500);
                    if (newsSnippet) {
                        signals.push(`## Today's News Headlines\n${newsSnippet}`);
                    }
                }
            } catch { /* skip */ }
        }

        // 2. Recently modified vault notes
        const notebooksDir = path.join(ctx.vaultPath, "Notebooks");
        const recentNotes = scanRecentFiles(notebooksDir, TWENTY_FOUR_HOURS, 20);
        if (recentNotes.length > 0) {
            signals.push(`## Recently Active Notes (last 24h)\n${recentNotes.map(n => `- ${n}`).join("\n")}`);
        }

        // 3. Link health stats
        const linkHealthPath = path.join(ctx.vaultPath, "_system", "LINK-HEALTH.md");
        if (fs.existsSync(linkHealthPath)) {
            try {
                const lh = matter(fs.readFileSync(linkHealthPath, "utf-8"));
                const orphans = lh.data.orphanCount ?? 0;
                const broken = lh.data.brokenCount ?? 0;
                signals.push(`## Vault Health\n- ${orphans} orphaned notes, ${broken} broken links`);
            } catch { /* skip */ }
        }

        // 4. Recent memory insights
        const memoriesDir = path.join(ctx.vaultPath, "Notebooks", "Memories");
        const recentMemories = scanRecentFiles(memoriesDir, TWENTY_FOUR_HOURS, 10);
        if (recentMemories.length > 0) {
            signals.push(`## Recent Memory Insights\n${recentMemories.map(m => `- ${m}`).join("\n")}`);
        }

        // 5. Recent conversation learnings
        const learningsDir = path.join(ctx.vaultPath, "Notebooks", "Learnings");
        const recentLearnings = scanRecentFiles(learningsDir, TWENTY_FOUR_HOURS, 5);
        if (recentLearnings.length > 0) {
            signals.push(`## Recent Learnings\n${recentLearnings.map(l => `- ${l}`).join("\n")}`);
        }

        // 6. AI model intelligence
        let modelIntelIncluded = false;
        const modelIntelPath = path.join(ctx.vaultPath, "_system", "MODEL-INTELLIGENCE.md");
        if (fs.existsSync(modelIntelPath)) {
            try {
                const mi = matter(fs.readFileSync(modelIntelPath, "utf-8"));
                const lastUpdated = mi.data.lastUpdated ? new Date(mi.data.lastUpdated) : null;
                // Only include if updated within last 48 hours
                if (lastUpdated && Date.now() - lastUpdated.getTime() < 48 * 60 * 60 * 1000) {
                    const worthTrying = mi.content.match(/## Worth Trying\n([\s\S]*?)(?=\n## |$)/)?.[1]?.trim();
                    const notable = mi.content.match(/## Notable Releases\n([\s\S]*?)(?=\n## |$)/)?.[1]?.trim();
                    if (worthTrying || notable) {
                        const parts: string[] = [];
                        if (worthTrying && worthTrying !== "None this cycle.") parts.push(`Worth trying:\n${worthTrying}`);
                        if (notable && notable !== "No notable releases.") parts.push(`Notable:\n${notable}`);
                        if (parts.length > 0) {
                            signals.push(`## AI Model Intelligence\n${parts.join("\n")}`);
                            modelIntelIncluded = true;
                        }
                    }
                }
            } catch { /* skip */ }
        }

        if (signals.length === 0) {
            return null; // Nothing to synthesize
        }

        // ── Synthesize via 1 LLM call ───────────────────────────────
        const prompt = signals.join("\n\n");
        let synthesis: string;
        try {
            synthesis = await ctx.llm(prompt, SYSTEM_PROMPT);
        } catch (err) {
            console.error("[daily-synthesis] LLM call failed:", err);
            return null;
        }

        if (!synthesis || synthesis.trim().length < 50) return null;

        if (ctx.dryRun) {
            return {
                observation: `Would create daily synthesis for ${dateStr}`,
                actions: [],
                meaningful: false,
            };
        }

        // ── Write synthesis file ────────────────────────────────────
        const decayDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]!;

        const frontmatterData = {
            noteType: "daily-synthesis",
            tags: ["daily-synthesis", "automated"],
            decayAfter: decayDate,
            createdAt: new Date().toISOString(),
            source: "touchpoint",
        };

        const content = [
            `# Daily Synthesis — ${dateStr}`,
            "",
            "## Unexpected Connections",
            "",
            synthesis.trim(),
            "",
            "## Vault Pulse",
            "",
            `- ${recentNotes.length} notes changed today`,
            signals.find(s => s.includes("orphaned")) ?? "- Vault health data not available",
            "",
            "## Sources",
            "",
            `- News pulse: ${signals.some(s => s.includes("News")) ? "yes" : "no"}`,
            `- Recent notes: ${recentNotes.length}`,
            `- Memory insights: ${recentMemories.length}`,
            `- Learnings: ${recentLearnings.length}`,
            `- Model intelligence: ${modelIntelIncluded ? "yes" : "no"}`,
            "",
        ].join("\n");

        fs.writeFileSync(todayFile, matter.stringify(content, frontmatterData), "utf-8");

        // ── Decay old synthesis files ────────────────────────────────
        try {
            const entries = fs.readdirSync(synthDir);
            for (const entry of entries) {
                if (!entry.endsWith(".md") || entry === `${dateStr}.md`) continue;
                const fp = path.join(synthDir, entry);
                try {
                    const raw = fs.readFileSync(fp, "utf-8");
                    const { data, content: c } = matter(raw);
                    if (data.decayAfter && new Date(data.decayAfter) < new Date()) {
                        data.importance = 0.01;
                        fs.writeFileSync(fp, matter.stringify(c, data), "utf-8");
                    }
                } catch { /* skip */ }
            }
        } catch { /* non-fatal */ }

        return {
            observation: `Daily synthesis created for ${dateStr}`,
            actions: [`SYNTHESIZED: ${dateStr}`],
            meaningful: true,
        };
    },
};
