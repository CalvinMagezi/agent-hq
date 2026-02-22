#!/usr/bin/env bun
/**
 * Memory Consolidation Workflow — Daily insight generation.
 *
 * Analyzes recent notes and memories, generates consolidated insights.
 *
 * Schedule: Daily 3:00 AM UTC (via launchd)
 */

import * as path from "path";
import * as fs from "fs";
import { VaultClient } from "@repo/vault-client";
import { SearchClient } from "@repo/vault-client/search";

const VAULT_PATH = process.env.VAULT_PATH ?? path.resolve(import.meta.dir, "../..", ".vault");
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.CONSOLIDATION_MODEL ?? "google/gemini-2.5-flash";

if (!OPENROUTER_API_KEY) {
  console.error("Error: OPENROUTER_API_KEY is required.");
  process.exit(1);
}

const vault = new VaultClient(VAULT_PATH);

async function main(): Promise<void> {
  console.log("[memory-consolidation] Starting daily consolidation...");

  // Gather recent notes (last 24 hours)
  const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const allNotes: Array<{ title: string; content: string; tags: string[]; source: string }> = [];

  for (const folder of ["Memories", "Projects", "Insights"]) {
    const notes = await vault.listNotes(folder);
    for (const note of notes) {
      if (note.updatedAt >= yesterday) {
        allNotes.push({
          title: note.title,
          content: note.content.substring(0, 2000),
          tags: note.tags,
          source: note.source,
        });
      }
    }
  }

  if (allNotes.length === 0) {
    console.log("[memory-consolidation] No recent notes to consolidate.");
    return;
  }

  console.log(`[memory-consolidation] Analyzing ${allNotes.length} recent note(s)...`);

  // Load current memory for context
  const memoryPath = path.join(VAULT_PATH, "_system/MEMORY.md");
  const currentMemory = fs.existsSync(memoryPath)
    ? fs.readFileSync(memoryPath, "utf-8")
    : "";

  const notesContext = allNotes
    .map((n) => `### ${n.title}\nTags: ${n.tags.join(", ")}\n${n.content}`)
    .join("\n\n---\n\n");

  // Generate insights
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
          content: `You are analyzing a personal knowledge base. Extract patterns, connections, and actionable insights from the recent activity. Be concise. Focus on:
1. Emerging themes across notes
2. Connections between different topics
3. Actionable recommendations
4. Knowledge gaps to explore`,
        },
        {
          role: "user",
          content: `Current memory state:\n${currentMemory.substring(0, 2000)}\n\n---\n\nRecent notes (last 24h):\n${notesContext}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenRouter error: ${response.status}`);
  }

  const result = await response.json() as {
    choices: Array<{ message: { content: string } }>;
  };
  const insights = result.choices[0]?.message?.content ?? "No insights generated.";

  // Seed initial wikilinks from keyword search
  const search = new SearchClient(VAULT_PATH);
  const today = new Date().toISOString().split("T")[0];
  const noteTitle = `Daily Insights ${today}`;
  const related = search.keywordSearch("insights consolidation memory", 5)
    .filter((r) => !r.notePath.includes(noteTitle));
  search.close();

  let body = insights;
  if (related.length > 0) {
    const links = related.map((r) => `- [[${r.title}]]`).join("\n");
    body += `\n\n<!-- agent-hq-graph-links -->\n## Related Notes\n\n${links}\n`;
  }

  // Save insights note
  await vault.createNote("Insights", noteTitle, body, {
    noteType: "report",
    tags: ["daily-insights", "auto-generated", "memory-consolidation"],
    source: "memory-consolidation",
  });

  console.log(`[memory-consolidation] Insights saved for ${today}`);
}

main().catch((err) => {
  console.error("[memory-consolidation] Fatal error:", err);
  process.exit(1);
});
