#!/usr/bin/env bun
/**
 * Knowledge Analysis Workflow — Weekly deep analysis.
 *
 * Analyzes 14 days of notes for emerging themes, contradictions,
 * orphan notes, and knowledge gaps.
 *
 * Schedule: Saturday 6:00 AM UTC (via launchd)
 */

import * as path from "path";
import { VaultClient } from "@repo/vault-client";
import { SearchClient } from "@repo/vault-client/search";
import { recordWorkflowRun } from "./statusHelper.js";

const VAULT_PATH = process.env.VAULT_PATH ?? path.resolve(import.meta.dir, "../..", ".vault");
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.ANALYSIS_MODEL ?? "google/gemini-2.5-flash";

if (!OPENROUTER_API_KEY) {
  console.error("Error: OPENROUTER_API_KEY is required.");
  recordWorkflowRun(VAULT_PATH, "knowledge-analysis", false, "OPENROUTER_API_KEY missing");
  process.exit(1);
}

const vault = new VaultClient(VAULT_PATH);

async function main(): Promise<void> {
  console.log("[knowledge-analysis] Starting weekly analysis...");

  const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
  const allNotes: Array<{ title: string; content: string; tags: string[]; relatedNotes: string[]; embeddingStatus: string }> = [];

  for (const folder of ["Memories", "Projects", "Daily Digest", "Insights", "AI Intelligence"]) {
    const notes = await vault.listNotes(folder);
    for (const note of notes) {
      if (note.createdAt >= twoWeeksAgo) {
        allNotes.push({
          title: note.title,
          content: note.content.substring(0, 1500),
          tags: note.tags,
          relatedNotes: note.relatedNotes,
          embeddingStatus: note.embeddingStatus,
        });
      }
    }
  }

  if (allNotes.length < 3) {
    console.log("[knowledge-analysis] Not enough recent notes for analysis.");
    return;
  }

  console.log(`[knowledge-analysis] Analyzing ${allNotes.length} notes from last 14 days...`);

  // Find orphan notes (embedded but no related notes)
  const orphans = allNotes
    .filter((n) => n.embeddingStatus === "embedded" && n.relatedNotes.length === 0)
    .map((n) => n.title);

  const notesContext = allNotes
    .map((n) => `### ${n.title}\nTags: ${n.tags.join(", ")}\nRelated: ${n.relatedNotes.length}\n${n.content.substring(0, 800)}`)
    .join("\n\n---\n\n");

  // Generate analysis
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
          content: `You are a knowledge graph analyst. Analyze the user's notes from the past 2 weeks and provide:

1. **Emerging Themes**: What topics are growing in importance?
2. **Contradictions**: Any conflicting information between notes?
3. **Knowledge Gaps**: What areas lack depth?
4. **Orphan Notes**: These notes have no connections: ${orphans.join(", ")}. Suggest where they could connect.
5. **Recommendations**: What should the user explore next?

Be specific and reference note titles when possible.`,
        },
        {
          role: "user",
          content: `Notes from the last 14 days:\n\n${notesContext}`,
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
  const analysis = result.choices[0]?.message?.content ?? "No analysis generated.";

  // Seed initial wikilinks from keyword search
  const search = new SearchClient(VAULT_PATH);
  const today = new Date().toISOString().split("T")[0];
  const noteTitle = `Weekly Knowledge Analysis ${today}`;
  const related = search.keywordSearch("knowledge analysis insights", 5)
    .filter((r) => !r.notePath.includes(noteTitle));
  search.close();

  let body = analysis;
  if (related.length > 0) {
    const links = related.map((r) => `- [[${r.title}]]`).join("\n");
    body += `\n\n<!-- agent-hq-graph-links -->\n## Related Notes\n\n${links}\n`;
  }

  // Save analysis note
  await vault.createNote("Insights", noteTitle, body, {
    noteType: "report",
    tags: ["weekly-analysis", "auto-generated", "knowledge-analysis"],
    source: "knowledge-analysis",
  });

  recordWorkflowRun(VAULT_PATH, "knowledge-analysis", true, `${allNotes.length} notes analyzed`);
  console.log(`[knowledge-analysis] Analysis saved for ${today}`);
}

main().catch((err) => {
  recordWorkflowRun(VAULT_PATH, "knowledge-analysis", false, String(err));
  console.error("[knowledge-analysis] Fatal error:", err);
  process.exit(1);
});
