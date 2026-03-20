/**
 * Morning brief generator — synthesizes calendar, inbox, metrics,
 * and lessons into a daily brief written to the vault.
 *
 * Intended to run as a daemon task at 7:00 AM daily.
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { scanInbox, formatInbox } from "./inbox.js";
import { computeMetrics, formatMetrics } from "./evaluator.js";
import { loadLessons } from "./reflection.js";
import { resolveProvider } from "@repo/agent-core";
import type { ModelProvider } from "@repo/agent-core";
import { buildModelConfig } from "./modelConfig.js";
import { logger } from "./logger.js";

// ── Types ───────────────────────────────────────────────────────────

export interface MorningBriefConfig {
  vaultPath: string;
  geminiApiKey?: string;
  anthropicApiKey?: string;
  openrouterApiKey?: string;
  ollamaBaseUrl?: string;
}

// ── Generate Brief ──────────────────────────────────────────────────

/**
 * Generate a morning brief and write it to .vault/Notebooks/Briefs/{date}.md
 */
export async function generateMorningBrief(config: MorningBriefConfig): Promise<string> {
  const { vaultPath } = config;
  const today = new Date().toISOString().slice(0, 10);

  // Gather inputs in parallel
  const [inbox, metrics, calendar] = await Promise.all([
    Promise.resolve(scanInbox(vaultPath)),
    Promise.resolve(computeMetrics(vaultPath, 7)),
    getCalendarAgenda().catch(() => null),
  ]);

  const lessons = loadLessons(vaultPath, 10);

  // Format each section
  const sections: string[] = [];

  sections.push(`---
title: "Morning Brief — ${today}"
type: brief
date: "${today}"
---

# Morning Brief — ${today}\n`);

  // Calendar
  if (calendar) {
    sections.push(`## Today's Schedule\n\n${calendar}`);
  } else {
    sections.push(`## Today's Schedule\n\n_Calendar not available (gws not configured)._`);
  }

  // Inbox
  const inboxFormatted = formatInbox(inbox);
  sections.push(inboxFormatted);

  // Performance
  const metricsFormatted = formatMetrics(metrics);
  sections.push(`## Agent Performance (7-day)\n\n${metricsFormatted}`);

  // Recent lessons
  if (lessons) {
    sections.push(`## Recent Lessons\n\n${lessons}`);
  }

  // Synthesize with LLM (if available)
  const synthesis = await synthesizeBrief(config, {
    calendar: calendar ?? "No calendar data",
    inbox: inboxFormatted,
    metrics: metricsFormatted,
    lessons,
  });

  if (synthesis) {
    sections.push(`## Recommended Focus\n\n${synthesis}`);
  }

  const briefContent = sections.join("\n\n");

  // Write to vault
  const briefDir = path.join(vaultPath, "Notebooks", "Briefs");
  fs.mkdirSync(briefDir, { recursive: true });
  const briefPath = path.join(briefDir, `${today}.md`);
  fs.writeFileSync(briefPath, briefContent);

  logger.info("Morning brief generated", { path: briefPath, inboxItems: inbox.length });
  return briefPath;
}

// ── Calendar Integration ────────────────────────────────────────────

async function getCalendarAgenda(): Promise<string | null> {
  try {
    // Use gws CLI if available
    const result = execSync("gws calendar +agenda 2>/dev/null", {
      encoding: "utf-8",
      timeout: 15000,
    });
    return result.trim() || null;
  } catch {
    return null;
  }
}

// ── LLM Synthesis ───────────────────────────────────────────────────

async function synthesizeBrief(
  config: MorningBriefConfig,
  data: { calendar: string; inbox: string; metrics: string; lessons: string },
): Promise<string | null> {
  try {
    const provider = resolveReflectionProvider(config);
    if (!provider) return null;

    const prompt = `Based on the following morning brief data, write 2-3 bullet points of recommended focus for today. Be specific and actionable.

CALENDAR:
${data.calendar.slice(0, 1000)}

INBOX:
${data.inbox.slice(0, 1500)}

METRICS:
${data.metrics.slice(0, 500)}

RECENT LESSONS:
${data.lessons.slice(0, 500)}

Respond with ONLY the bullet points (no preamble):`;

    const resp = await provider.chat({
      messages: [{ role: "user", content: prompt }],
      model: resolveModelId(config),
      maxTokens: 400,
      temperature: 0.4,
    });

    return resp.content.trim() || null;
  } catch (err) {
    logger.warn("Brief synthesis failed", { error: String(err) });
    return null;
  }
}

function resolveModelId(config: MorningBriefConfig): string {
  if (config.geminiApiKey) return "gemini-2.5-flash-lite";
  if (config.anthropicApiKey) return "claude-haiku-4-5";
  if (config.openrouterApiKey) return "moonshotai/kimi-k2.5";
  return "gemini-2.5-flash-lite";
}

function resolveReflectionProvider(config: MorningBriefConfig): ModelProvider | null {
  const modelId = resolveModelId(config);
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
