#!/usr/bin/env bun
/**
 * Model Tracker Workflow — AI model catalog monitoring + intelligence.
 *
 * Fetches OpenRouter model catalog, diffs against snapshot,
 * generates analytical intelligence (not just a list), writes both
 * a detailed report and a compact _system/MODEL-INTELLIGENCE.md
 * for consumption by daily synthesis and morning audio brief.
 *
 * Modes:
 *   --mode=daily   Catalog diff only, no Brave search (fast, cheap)
 *   --mode=weekly  Full Brave search + deep LLM analysis (default)
 *
 * Schedule: Daily 8 AM EAT (daily), Monday 9 AM (weekly) — via daemon
 */

import * as path from "path";
import * as fs from "fs";
import matter from "gray-matter";
import { VaultClient } from "@repo/vault-client";
import { recordWorkflowRun } from "./statusHelper.js";

const VAULT_PATH = process.env.VAULT_PATH ?? path.resolve(import.meta.dir, "../..", ".vault");
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const BRAVE_API_KEY = process.env.BRAVE_API_KEY;
const MODEL = process.env.MODEL_TRACKER_MODEL ?? "google/gemini-2.5-flash";

// Parse --mode flag
const modeArg = process.argv.find((a) => a.startsWith("--mode="));
const mode: "daily" | "weekly" = modeArg?.split("=")[1] === "daily" ? "daily" : "weekly";

if (!OPENROUTER_API_KEY) {
  console.error("Error: OPENROUTER_API_KEY is required.");
  recordWorkflowRun(VAULT_PATH, "model-tracker", false, "OPENROUTER_API_KEY missing");
  process.exit(1);
}

const vault = new VaultClient(VAULT_PATH);

// ── Calvin's current model stack (for comparison) ─────────────────────────
const CURRENT_MODELS: Record<string, { role: string; inputCost: string; outputCost: string }> = {
  "google/gemini-3-flash-preview": { role: "primary flash tier", inputCost: "free (OAuth)", outputCost: "free (OAuth)" },
  "google/gemini-2.5-flash": { role: "flash tier fallback", inputCost: "0.15", outputCost: "0.6" },
  "google/gemini-2.5-flash-lite": { role: "worker/judge tier", inputCost: "0.075", outputCost: "0.3" },
  "anthropic/claude-opus-4-6": { role: "thorough tier (complex reasoning)", inputCost: "15", outputCost: "75" },
  "anthropic/claude-sonnet-4-6": { role: "standard tier", inputCost: "3", outputCost: "15" },
  "openai/gpt-5": { role: "thorough fallback", inputCost: "10", outputCost: "30" },
  "openai/gpt-4.1-mini": { role: "flash fallback (1M context)", inputCost: "0.4", outputCost: "1.6" },
};

interface CatalogModel {
  id: string;
  name: string;
  inputCost: string;
  outputCost: string;
}

async function main(): Promise<void> {
  console.log(`[model-tracker] Starting ${mode} model tracking...`);

  // ── Fetch current catalog ───────────────────────────────────────────────
  const catalogResponse = await fetch("https://openrouter.ai/api/v1/models", {
    headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}` },
    signal: AbortSignal.timeout(30_000),
  });

  if (!catalogResponse.ok) {
    throw new Error(`OpenRouter catalog error: ${catalogResponse.status}`);
  }

  const catalog = await catalogResponse.json() as {
    data: Array<{ id: string; name: string; pricing: { prompt: string; completion: string } }>;
  };

  const currentModels: CatalogModel[] = catalog.data.map((m) => ({
    id: m.id,
    name: m.name,
    inputCost: m.pricing?.prompt ?? "unknown",
    outputCost: m.pricing?.completion ?? "unknown",
  }));

  // ── Load previous snapshot ──────────────────────────────────────────────
  const snapshotPath = path.join(VAULT_PATH, "_system/MODEL-SNAPSHOT.md");
  let previousIds = new Set<string>();
  if (fs.existsSync(snapshotPath)) {
    const content = fs.readFileSync(snapshotPath, "utf-8");
    const match = content.match(/```json\n([\s\S]*?)\n```/);
    if (match) {
      try {
        const prev = JSON.parse(match[1]) as Array<{ id: string }>;
        previousIds = new Set(prev.map((m) => m.id));
      } catch {
        // Invalid snapshot, rebuild
      }
    }
  }

  // ── Diff ────────────────────────────────────────────────────────────────
  const newModels = currentModels.filter((m) => !previousIds.has(m.id));
  const removedModels = [...previousIds].filter(
    (id) => !currentModels.some((m) => m.id === id),
  );

  console.log(`[model-tracker] ${newModels.length} new, ${removedModels.length} removed (total: ${currentModels.length})`);

  // ── Search for AI lab news (weekly only) ────────────────────────────────
  let newsContext = "";
  if (mode === "weekly" && BRAVE_API_KEY) {
    const queries = [
      "AI model release this week 2026",
      "OpenAI Anthropic Google AI news this week",
    ];
    for (const query of queries) {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`;
      const response = await fetch(url, {
        headers: { "X-Subscription-Token": BRAVE_API_KEY },
        signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) {
        const data = await response.json() as {
          web?: { results?: Array<{ title: string; url: string; description: string }> };
        };
        const results = data.web?.results ?? [];
        newsContext += results
          .map((r) => `- [${r.title}](${r.url}): ${r.description}`)
          .join("\n") + "\n";
      }
    }
  }

  // ── Generate analytical intelligence via LLM ────────────────────────────
  const today = new Date().toISOString().split("T")[0];
  let intelligence = await generateIntelligence(newModels, removedModels, newsContext, currentModels.length);

  // ── Write MODEL-INTELLIGENCE.md (compact, for other consumers) ──────────
  writeModelIntelligence(intelligence, newModels.length, today);

  // ── Write full report to Notebooks ──────────────────────────────────────
  const reportContent = buildReport(currentModels.length, newModels, removedModels, intelligence);
  await vault.createNote("AI Intelligence", `AI Model Report ${today}`, reportContent, {
    noteType: "report",
    tags: ["model-tracker", "auto-generated", "ai-intelligence"],
    source: "model-tracker",
    mode,
  });

  // ── Update snapshot ─────────────────────────────────────────────────────
  const snapshotData = {
    noteType: "system-file",
    fileName: "model-snapshot",
    version: 1,
    lastFetched: new Date().toISOString(),
  };
  const snapshotContent = `# OpenRouter Model Snapshot\n\nTotal: ${currentModels.length} models\nLast updated: ${today}\n\n\`\`\`json\n${JSON.stringify(currentModels.slice(0, 100), null, 2)}\n\`\`\``;
  fs.writeFileSync(snapshotPath, matter.stringify("\n" + snapshotContent + "\n", snapshotData), "utf-8");

  recordWorkflowRun(VAULT_PATH, "model-tracker", true, `${mode}: ${newModels.length} new, ${removedModels.length} removed`);
  console.log(`[model-tracker] Done (${mode}). Report + MODEL-INTELLIGENCE.md updated.`);
}

// ── LLM Analysis ──────────────────────────────────────────────────────────

interface Intelligence {
  worthTrying: string;
  notableReleases: string;
  marketSignals: string;
  labNews: string;
}

async function generateIntelligence(
  newModels: CatalogModel[],
  removedModels: string[],
  newsContext: string,
  totalCount: number,
): Promise<Intelligence> {
  const result: Intelligence = {
    worthTrying: "",
    notableReleases: "",
    marketSignals: "",
    labNews: "",
  };

  // Skip LLM call if nothing interesting happened
  if (newModels.length === 0 && !newsContext) {
    result.marketSignals = "- No new models or significant news detected this cycle.";
    return result;
  }

  const currentModelsList = Object.entries(CURRENT_MODELS)
    .map(([id, info]) => `- \`${id}\` — ${info.role} ($${info.inputCost}/$${info.outputCost} per M tokens)`)
    .join("\n");

  const newModelsList = newModels.length > 0
    ? newModels.slice(0, 30).map((m) => `- \`${m.id}\` (${m.name}) — $${m.inputCost}/$${m.outputCost} per token`).join("\n")
    : "No new models this cycle.";

  const systemPrompt = `You are an AI model analyst for a CTO running Agent-HQ, a local-first AI agent orchestration system in Kampala, Uganda.

Your job: analyze new models on OpenRouter and determine which are worth testing for this specific system.

Agent-HQ needs models that excel at:
1. Tool use / function calling (agentic loops with 10+ tool calls per session)
2. Large context windows (200K+ preferred, 1M ideal)
3. Code generation (TypeScript, Bun runtime)
4. JSON extraction from unstructured text
5. Cost efficiency for background tasks (cheap worker tier)

Output EXACTLY these three sections (use these exact headings):

## Worth Trying
List 0-3 models worth benchmarking. For each: the model ID, what it's good at, which current model it could complement or replace, and the cost comparison. If none are worth trying, say "None this cycle."

## Notable Releases
List 0-5 significant model releases or changes, even if not directly useful for Agent-HQ. One line each with why it matters.

## Market Signals
2-3 bullet points on trends: pricing movements, capability shifts, provider strategies. What should the CTO watch?`;

  const userPrompt = `## Calvin's Current Model Stack
${currentModelsList}

## New Models on OpenRouter (${newModels.length} new, ${totalCount} total)
${newModelsList}

${removedModels.length > 0 ? `## Removed Models\n${removedModels.slice(0, 10).map((id) => `- \`${id}\``).join("\n")}` : ""}

${newsContext ? `## AI Lab News This Week\n${newsContext}` : ""}

Analyze and produce your three sections.`;

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/CalvinMagezi/agent-hq",
        "X-Title": "Agent-HQ Model Tracker",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      console.warn(`[model-tracker] LLM analysis failed: ${response.status}`);
      return result;
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
    };
    const content = data.choices[0]?.message?.content ?? "";

    // Parse sections from LLM output
    result.worthTrying = extractSection(content, "Worth Trying");
    result.notableReleases = extractSection(content, "Notable Releases");
    result.marketSignals = extractSection(content, "Market Signals");
    if (newsContext) result.labNews = extractSection(content, "AI Lab News") || newsContext.slice(0, 500);
  } catch (err) {
    console.warn("[model-tracker] LLM analysis error:", err);
  }

  return result;
}

function extractSection(content: string, heading: string): string {
  const regex = new RegExp(`## ${heading}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`, "i");
  const match = content.match(regex);
  return match?.[1]?.trim() ?? "";
}

// ── MODEL-INTELLIGENCE.md Writer ──────────────────────────────────────────

function writeModelIntelligence(intel: Intelligence, newModelCount: number, dateStr: string): void {
  const intelPath = path.join(VAULT_PATH, "_system/MODEL-INTELLIGENCE.md");

  // Count "worth trying" entries (lines starting with -)
  const worthTryingCount = (intel.worthTrying.match(/^- /gm) ?? []).length;

  const frontmatterData = {
    noteType: "system-file",
    fileName: "model-intelligence",
    lastUpdated: new Date().toISOString(),
    newModelCount,
    worthTryingCount,
    mode,
  };

  const content = [
    `# Model Intelligence — ${dateStr}`,
    "",
    "## Worth Trying",
    "",
    intel.worthTrying || "None this cycle.",
    "",
    "## Notable Releases",
    "",
    intel.notableReleases || "No notable releases.",
    "",
    "## Market Signals",
    "",
    intel.marketSignals || "No significant signals.",
    "",
  ].join("\n");

  fs.mkdirSync(path.join(VAULT_PATH, "_system"), { recursive: true });
  fs.writeFileSync(intelPath, matter.stringify(content, frontmatterData), "utf-8");
  console.log(`[model-tracker] MODEL-INTELLIGENCE.md updated (${worthTryingCount} worth trying)`);
}

// ── Report Builder ────────────────────────────────────────────────────────

function buildReport(
  totalCount: number,
  newModels: CatalogModel[],
  removedModels: string[],
  intel: Intelligence,
): string {
  const parts: string[] = [];
  parts.push(`Total models on OpenRouter: ${totalCount}`);

  if (intel.worthTrying) {
    parts.push("\n## Worth Trying\n\n" + intel.worthTrying);
  }

  if (newModels.length > 0) {
    parts.push("\n## New Models\n");
    for (const m of newModels) {
      parts.push(`- **${m.name}** (\`${m.id}\`) — $${m.inputCost}/$${m.outputCost} per token`);
    }
  }

  if (removedModels.length > 0) {
    parts.push("\n## Removed Models\n");
    for (const id of removedModels) {
      parts.push(`- \`${id}\``);
    }
  }

  if (intel.notableReleases) {
    parts.push("\n## Notable Releases\n\n" + intel.notableReleases);
  }

  if (intel.marketSignals) {
    parts.push("\n## Market Signals\n\n" + intel.marketSignals);
  }

  if (intel.labNews) {
    parts.push("\n## AI Lab News\n\n" + intel.labNews);
  }

  return parts.join("\n");
}

main().catch((err) => {
  recordWorkflowRun(VAULT_PATH, "model-tracker", false, String(err));
  console.error("[model-tracker] Fatal error:", err);
  process.exit(1);
});
