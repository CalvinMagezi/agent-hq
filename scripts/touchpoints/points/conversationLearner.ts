/**
 * Conversation Learner — Touch Point
 *
 * Extracts learnings from lengthy conversation threads via Ollama (1-2 calls).
 * Feeds extracted items into the vault memory pipeline via MemoryIngester.
 * Also appends discovered user preferences to _system/PREFERENCES.md.
 *
 * Guards:
 *   - Skip if file has < 10 turns or < 500 words
 *   - Tracks processed file versions in .conversation-learner-state.json
 *   - 5-minute debounce to batch rapid writes
 */

import * as fs from "fs";
import * as path from "path";
import type { TouchPoint } from "../types.js";

const DEBOUNCE_MS = 5 * 60_000; // 5 minutes
const MIN_TURNS = 10;
const MIN_WORDS = 500;
const STATE_FILE = ".conversation-learner-state.json";

interface LearnerState {
  [filePath: string]: { processedSize: number; processedAt: string };
}

const EXTRACT_SYSTEM = `You are a learning extraction assistant for a personal AI agent hub.
Read this conversation and extract structured learnings.
Return a JSON object with exactly these fields:
{
  "preferences": ["user preference strings"],
  "decisions": ["important decisions made"],
  "learnings": ["key facts or insights discovered"],
  "patterns": ["recurring patterns or behaviors observed"]
}
Keep each item concise (1-2 sentences). Return empty arrays if nothing relevant found.
Return ONLY valid JSON, no explanation.`;

export const conversationLearner: TouchPoint = {
  name: "conversation-learner",
  description: "Extract learnings from long conversation threads and feed into memory",
  triggers: ["file:modified", "file:created"],
  pathFilter: undefined,  // multi-prefix, handled below
  debounceMs: DEBOUNCE_MS,

  async evaluate(event, ctx) {
    const filePath = event.path;

    // Only watch threads and agent-sessions
    if (!filePath.startsWith("_threads/") && !filePath.startsWith("_agent-sessions/")) {
      return null;
    }
    if (!filePath.endsWith(".md")) return null;

    const fullPath = path.join(ctx.vaultPath, filePath);
    if (!fs.existsSync(fullPath)) return null;

    let raw: string;
    try {
      raw = fs.readFileSync(fullPath, "utf-8");
    } catch {
      return null;
    }

    // Check size thresholds
    const wordCount = raw.split(/\s+/).length;
    const turnCount = (raw.match(/^##?\s+(User|Calvin|Human|Assistant|Agent)/gim) ?? []).length;

    if (wordCount < MIN_WORDS || turnCount < MIN_TURNS) return null;

    // Check if already processed at this file size (avoid reprocessing same content)
    const statePath = path.join(ctx.vaultPath, "_system", STATE_FILE);
    let state: LearnerState = {};
    try {
      if (fs.existsSync(statePath)) {
        state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      }
    } catch { /* start fresh */ }

    const fileSize = Buffer.byteLength(raw, "utf-8");
    const prev = state[filePath];
    if (prev && prev.processedSize >= fileSize) return null;

    // Call Ollama to extract learnings
    const prompt = `Conversation file: ${path.basename(filePath)}\n\nContent (first 6000 chars):\n\n${raw.slice(0, 6000)}`;

    let extracted: {
      preferences: string[];
      decisions: string[];
      learnings: string[];
      patterns: string[];
    } | null = null;

    try {
      const response = await ctx.llm(prompt, EXTRACT_SYSTEM);
      const match = response.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        if (parsed && typeof parsed === "object") {
          extracted = {
            preferences: Array.isArray(parsed.preferences) ? parsed.preferences : [],
            decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
            learnings: Array.isArray(parsed.learnings) ? parsed.learnings : [],
            patterns: Array.isArray(parsed.patterns) ? parsed.patterns : [],
          };
        }
      }
    } catch {
      return null;
    }

    if (!extracted) return null;

    const allItems = [
      ...extracted.preferences.map((p: string) => `[preference] ${p}`),
      ...extracted.decisions.map((d: string) => `[decision] ${d}`),
      ...extracted.learnings.map((l: string) => `[learning] ${l}`),
      ...extracted.patterns.map((p: string) => `[pattern] ${p}`),
    ];

    if (allItems.length === 0) return null;

    if (ctx.dryRun) {
      return {
        observation: `Would ingest ${allItems.length} items from ${path.basename(filePath)}`,
        actions: [],
        meaningful: false,
      };
    }

    // Feed into memory pipeline
    let ingestedCount = 0;
    for (const item of allItems) {
      try {
        const id = await ctx.memoryIngester.ingest({
          text: item,
          source: "conversation",
          harness: filePath.startsWith("_agent-sessions/telegram") ? "telegram" : "conversation",
        });
        if (id !== null) ingestedCount++;
      } catch { /* continue */ }
    }

    // Append preferences to PREFERENCES.md
    if (extracted.preferences.length > 0) {
      const prefsPath = path.join(ctx.vaultPath, "_system", "PREFERENCES.md");
      try {
        if (fs.existsSync(prefsPath)) {
          const prefsContent = fs.readFileSync(prefsPath, "utf-8");
          const newPrefs = extracted.preferences.map((p: string) => `- ${p} _(from conversation)_`).join("\n");
          fs.appendFileSync(prefsPath, `\n\n## Extracted ${new Date().toISOString().slice(0, 10)}\n\n${newPrefs}\n`, "utf-8");
        }
      } catch { /* non-fatal */ }
    }

    // Update state
    state[filePath] = { processedSize: fileSize, processedAt: new Date().toISOString() };
    try {
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
    } catch { /* non-fatal */ }

    return {
      observation: `Extracted ${allItems.length} items from ${path.basename(filePath)}, ingested ${ingestedCount}`,
      actions: [`INGESTED: ${ingestedCount}/${allItems.length} items into memory pipeline`],
      meaningful: ingestedCount > 0,
    };
  },
};
