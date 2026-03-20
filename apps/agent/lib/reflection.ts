/**
 * Post-task reflection engine — the agent reviews its own performance
 * after each job and stores lessons for continuous improvement.
 *
 * Reflections are stored in .vault/_system/Reflections/ as markdown files.
 * Aggregated lessons are maintained in .vault/_system/LESSONS.md (rolling top-100).
 */

import * as fs from "fs";
import * as path from "path";
import { resolveProvider } from "@repo/agent-core";
import type { ModelProvider } from "@repo/agent-core";
import { buildModelConfig } from "./modelConfig.js";
import { logger } from "./logger.js";

// ── Types ───────────────────────────────────────────────────────────

export interface TaskReflection {
  jobId: string;
  instruction: string;
  outcome: "success" | "partial" | "failed";
  tokenEfficiency: number;
  toolCallCount: number;
  durationMs: number;
  lessons: string[];
  timestamp: string;
}

export interface ReflectionConfig {
  vaultPath: string;
  geminiApiKey?: string;
  anthropicApiKey?: string;
  openrouterApiKey?: string;
  ollamaBaseUrl?: string;
}

// ── Constants ───────────────────────────────────────────────────────

const REFLECTIONS_DIR = "_system/Reflections";
const LESSONS_FILE = "_system/LESSONS.md";
const MAX_LESSONS = 100;

// Use cheapest available model for reflections
const REFLECTION_MODELS = [
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "claude-haiku-4-5",
  "moonshotai/kimi-k2.5",
];

// ── Generate Reflection ─────────────────────────────────────────────

/**
 * Generate a post-task reflection using a cheap LLM call.
 * Extracts 2-3 lessons from the job outcome.
 */
export async function generateReflection(
  config: ReflectionConfig,
  jobId: string,
  instruction: string,
  result: string | null,
  stats: { tokens?: { total: number }; toolCalls?: number; cost?: number } | null,
  status: "done" | "failed",
  durationMs: number,
): Promise<TaskReflection> {
  const outcome = status === "done" ? "success" : "failed";
  const tokenTotal = stats?.tokens?.total ?? 0;
  const toolCalls = stats?.toolCalls ?? 0;

  // Build a concise summary for the LLM
  const resultSnippet = result
    ? result.slice(0, 2000)
    : "(no result captured)";

  const prompt = `You are reviewing an AI agent's task execution. Extract 2-3 concise lessons.

TASK: ${instruction.slice(0, 500)}
OUTCOME: ${outcome}
TOKENS USED: ${tokenTotal}
TOOL CALLS: ${toolCalls}
DURATION: ${Math.round(durationMs / 1000)}s
RESULT SNIPPET: ${resultSnippet}

Respond with ONLY a JSON array of lesson strings. Each lesson should be:
- Actionable (what to do differently next time)
- Specific (not generic platitudes)
- Short (one sentence each)

Example: ["Use vault search before writing new content to avoid duplicates", "For coding tasks, run tests before marking complete"]
If the task succeeded efficiently, note what worked well.`;

  let lessons: string[] = [];

  try {
    const provider = resolveReflectionProvider(config);
    if (provider) {
      const resp = await provider.chat({
        messages: [{ role: "user", content: prompt }],
        model: resolveReflectionModel(config),
        maxTokens: 500,
        temperature: 0.3,
      });

      // Parse JSON array from response
      const match = resp.content.match(/\[[\s\S]*?\]/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        if (Array.isArray(parsed)) {
          lessons = parsed.filter((l: unknown) => typeof l === "string").slice(0, 3);
        }
      }
    }
  } catch (err) {
    logger.warn("Reflection LLM call failed, using fallback", { error: String(err) });
  }

  // Fallback lessons if LLM fails
  if (lessons.length === 0) {
    if (outcome === "failed") {
      lessons = ["Task failed — review error logs and consider breaking into smaller subtasks"];
    } else if (tokenTotal > 100000) {
      lessons = ["High token usage — consider more targeted tool use next time"];
    } else {
      lessons = ["Task completed successfully"];
    }
  }

  return {
    jobId,
    instruction: instruction.slice(0, 200),
    outcome,
    tokenEfficiency: tokenTotal > 0 ? 1 / (tokenTotal / 1000) : 0,
    toolCallCount: toolCalls,
    durationMs,
    lessons,
    timestamp: new Date().toISOString(),
  };
}

// ── Store Reflection ────────────────────────────────────────────────

/**
 * Store a reflection as a markdown file and update LESSONS.md.
 */
export function storeReflection(vaultPath: string, reflection: TaskReflection): void {
  // Write individual reflection file
  const reflDir = path.join(vaultPath, REFLECTIONS_DIR);
  fs.mkdirSync(reflDir, { recursive: true });

  const date = new Date().toISOString().slice(0, 10);
  const shortId = reflection.jobId.slice(0, 8);
  const filename = `${date}-${shortId}.md`;
  const filePath = path.join(reflDir, filename);

  const content = `---
jobId: ${reflection.jobId}
outcome: ${reflection.outcome}
tokens: ${Math.round(1 / reflection.tokenEfficiency * 1000) || 0}
toolCalls: ${reflection.toolCallCount}
duration: ${Math.round(reflection.durationMs / 1000)}s
timestamp: "${reflection.timestamp}"
---

## Task
${reflection.instruction}

## Outcome
${reflection.outcome === "success" ? "Completed successfully" : "Failed"}

## Lessons
${reflection.lessons.map(l => `- ${l}`).join("\n")}
`;

  fs.writeFileSync(filePath, content);

  // Update rolling LESSONS.md
  updateLessonsFile(vaultPath, reflection);
}

/**
 * Append new lessons to LESSONS.md, keeping the most recent entries
 * up to MAX_LESSONS. Deduplicates similar lessons.
 */
function updateLessonsFile(vaultPath: string, reflection: TaskReflection): void {
  const lessonsPath = path.join(vaultPath, LESSONS_FILE);
  const systemDir = path.join(vaultPath, "_system");
  fs.mkdirSync(systemDir, { recursive: true });

  let existingLessons: string[] = [];
  try {
    const content = fs.readFileSync(lessonsPath, "utf-8");
    // Parse existing lessons (each line starting with "- ")
    existingLessons = content
      .split("\n")
      .filter(l => l.startsWith("- "))
      .map(l => l.slice(2).trim());
  } catch {
    // File doesn't exist yet
  }

  // Add new lessons (deduplicate by checking substring similarity)
  for (const lesson of reflection.lessons) {
    const isDuplicate = existingLessons.some(existing =>
      existing.toLowerCase().includes(lesson.toLowerCase().slice(0, 30)) ||
      lesson.toLowerCase().includes(existing.toLowerCase().slice(0, 30))
    );
    if (!isDuplicate) {
      existingLessons.unshift(lesson);
    }
  }

  // Cap at MAX_LESSONS
  existingLessons = existingLessons.slice(0, MAX_LESSONS);

  // Write updated file
  const header = `# Agent Lessons\n\n_Auto-maintained by reflection engine. Most recent first. Max ${MAX_LESSONS} entries._\n\n`;
  const body = existingLessons.map(l => `- ${l}`).join("\n");
  fs.writeFileSync(lessonsPath, header + body + "\n");
}

// ── Load Lessons ────────────────────────────────────────────────────

/**
 * Load lessons for injection into prompts.
 * Returns the most recent N lessons as a formatted string.
 */
export function loadLessons(vaultPath: string, maxCount: number = 20): string {
  const lessonsPath = path.join(vaultPath, LESSONS_FILE);
  try {
    const content = fs.readFileSync(lessonsPath, "utf-8");
    const lessons = content
      .split("\n")
      .filter(l => l.startsWith("- "))
      .slice(0, maxCount);
    return lessons.join("\n");
  } catch {
    return "";
  }
}

// ── Provider Resolution (cheap model) ───────────────────────────────

function resolveReflectionModel(config: ReflectionConfig): string {
  if (config.geminiApiKey) return REFLECTION_MODELS[0];
  if (config.anthropicApiKey) return REFLECTION_MODELS[2];
  if (config.openrouterApiKey) return REFLECTION_MODELS[3];
  return REFLECTION_MODELS[0]; // fallback
}

function resolveReflectionProvider(config: ReflectionConfig): ModelProvider | null {
  const modelId = resolveReflectionModel(config);
  try {
    const modelConfig = buildModelConfig({
      modelId,
      geminiApiKey: config.geminiApiKey,
      anthropicApiKey: config.anthropicApiKey,
      openrouterApiKey: config.openrouterApiKey,
      ollamaBaseUrl: config.ollamaBaseUrl,
    });
    return resolveProvider(modelConfig, {
      geminiApiKey: config.geminiApiKey,
      anthropicApiKey: config.anthropicApiKey,
      openrouterApiKey: config.openrouterApiKey,
      ollamaBaseUrl: config.ollamaBaseUrl,
    });
  } catch {
    return null;
  }
}
