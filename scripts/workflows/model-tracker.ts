#!/usr/bin/env bun
/**
 * Model Tracker Workflow — Weekly AI model catalog monitoring.
 *
 * Fetches OpenRouter model catalog, diffs against snapshot,
 * searches for AI lab news, writes report.
 *
 * Schedule: Monday 9:00 AM UTC (via launchd)
 */

import * as path from "path";
import * as fs from "fs";
import { VaultClient } from "@repo/vault-client";
import { recordWorkflowRun } from "./statusHelper.js";

const VAULT_PATH = process.env.VAULT_PATH ?? path.resolve(import.meta.dir, "../..", ".vault");
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const BRAVE_API_KEY = process.env.BRAVE_API_KEY;
const MODEL = process.env.MODEL_TRACKER_MODEL ?? "google/gemini-2.5-flash";

if (!OPENROUTER_API_KEY) {
  console.error("Error: OPENROUTER_API_KEY is required.");
  recordWorkflowRun(VAULT_PATH, "model-tracker", false, "OPENROUTER_API_KEY missing");
  process.exit(1);
}

const vault = new VaultClient(VAULT_PATH);

async function main(): Promise<void> {
  console.log("[model-tracker] Starting weekly model tracking...");

  // Fetch current model catalog from OpenRouter
  const catalogResponse = await fetch("https://openrouter.ai/api/v1/models", {
    headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}` },
  });

  if (!catalogResponse.ok) {
    throw new Error(`OpenRouter catalog error: ${catalogResponse.status}`);
  }

  const catalog = await catalogResponse.json() as {
    data: Array<{ id: string; name: string; pricing: { prompt: string; completion: string } }>;
  };

  const currentModels = catalog.data.map((m) => ({
    id: m.id,
    name: m.name,
    inputCost: m.pricing?.prompt ?? "unknown",
    outputCost: m.pricing?.completion ?? "unknown",
  }));

  // Load previous snapshot
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

  // Find new models
  const newModels = currentModels.filter((m) => !previousIds.has(m.id));
  const removedModels = [...previousIds].filter(
    (id) => !currentModels.some((m) => m.id === id),
  );

  // Search for AI lab news
  let newsContext = "";
  if (BRAVE_API_KEY) {
    const queries = [
      "AI model release this week 2026",
      "OpenAI Anthropic Google AI news this week",
    ];
    for (const query of queries) {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`;
      const response = await fetch(url, {
        headers: { "X-Subscription-Token": BRAVE_API_KEY },
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

  // Generate report
  const reportContent = [];
  reportContent.push(`Total models: ${currentModels.length}`);

  if (newModels.length > 0) {
    reportContent.push("\n## New Models\n");
    for (const m of newModels) {
      reportContent.push(`- **${m.name}** (\`${m.id}\`) — $${m.inputCost}/$${m.outputCost} per token`);
    }
  }

  if (removedModels.length > 0) {
    reportContent.push("\n## Removed Models\n");
    for (const id of removedModels) {
      reportContent.push(`- \`${id}\``);
    }
  }

  if (newsContext) {
    // Use LLM to summarize news
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: "system",
            content: "Summarize the latest AI lab news into key developments. Be concise and focus on model releases, capability improvements, and pricing changes.",
          },
          { role: "user", content: newsContext },
        ],
      }),
    });

    if (response.ok) {
      const result = await response.json() as {
        choices: Array<{ message: { content: string } }>;
      };
      const summary = result.choices[0]?.message?.content;
      if (summary) {
        reportContent.push("\n## AI Lab News\n" + summary);
      }
    }
  }

  // Save report
  const today = new Date().toISOString().split("T")[0];
  await vault.createNote("AI Intelligence", `AI Model Report ${today}`, reportContent.join("\n"), {
    noteType: "report",
    tags: ["model-tracker", "auto-generated", "ai-intelligence"],
    source: "model-tracker",
  });

  // Update snapshot
  const matter = await import("gray-matter").then((m) => m.default);
  const snapshotData = {
    noteType: "system-file",
    fileName: "model-snapshot",
    version: 1,
    lastFetched: new Date().toISOString(),
  };
  const snapshotContent = `# OpenRouter Model Snapshot\n\nTotal: ${currentModels.length} models\nLast updated: ${today}\n\n\`\`\`json\n${JSON.stringify(currentModels.slice(0, 100), null, 2)}\n\`\`\``;
  fs.writeFileSync(snapshotPath, matter.stringify("\n" + snapshotContent + "\n", snapshotData), "utf-8");

  recordWorkflowRun(VAULT_PATH, "model-tracker", true, `${newModels.length} new, ${removedModels.length} removed`);
  console.log(`[model-tracker] Report saved. ${newModels.length} new, ${removedModels.length} removed.`);
}

main().catch((err) => {
  recordWorkflowRun(VAULT_PATH, "model-tracker", false, String(err));
  console.error("[model-tracker] Fatal error:", err);
  process.exit(1);
});
