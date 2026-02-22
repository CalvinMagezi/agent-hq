#!/usr/bin/env bun
/**
 * Preference Tracker Workflow — Weekly user preference extraction.
 *
 * Analyzes recent notes and conversations to update user preferences.
 *
 * Schedule: Sunday 8:00 AM UTC (via launchd)
 */

import * as path from "path";
import * as fs from "fs";
import { VaultClient } from "@repo/vault-client";

const VAULT_PATH = process.env.VAULT_PATH ?? path.resolve(import.meta.dir, "../..", ".vault");
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.PREFERENCE_MODEL ?? "google/gemini-2.5-flash";

if (!OPENROUTER_API_KEY) {
  console.error("Error: OPENROUTER_API_KEY is required.");
  process.exit(1);
}

const vault = new VaultClient(VAULT_PATH);

async function main(): Promise<void> {
  console.log("[preference-tracker] Starting weekly preference extraction...");

  // Gather recent activity
  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const recentNotes: string[] = [];

  for (const folder of ["Memories", "Projects"]) {
    const notes = await vault.listNotes(folder);
    for (const note of notes) {
      if (note.updatedAt >= oneWeekAgo) {
        recentNotes.push(`${note.title}: ${note.content.substring(0, 500)}`);
      }
    }
  }

  // Gather recent threads
  const threads = await vault.listThreads();
  const recentThreads: string[] = [];
  for (const thread of threads.slice(0, 5)) {
    try {
      const note = await vault.readNote(`_threads/active/${thread.threadId}.md`);
      recentThreads.push(note.content.substring(0, 1000));
    } catch {
      // Skip
    }
  }

  // Load current preferences
  const prefsPath = path.join(VAULT_PATH, "_system/PREFERENCES.md");
  const currentPrefs = fs.existsSync(prefsPath)
    ? fs.readFileSync(prefsPath, "utf-8")
    : "";

  const context = [
    "## Recent Notes\n" + recentNotes.join("\n\n"),
    "## Recent Conversations\n" + recentThreads.join("\n\n---\n\n"),
  ].join("\n\n");

  // Extract preferences
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
          content: `Extract user preferences from their recent activity. Organize into categories:
- Communication: How they prefer information presented
- Technical: Tools, languages, frameworks they favor
- Workflow: How they work, scheduling, priorities

Current preferences (update or extend, don't remove without evidence):\n${currentPrefs}`,
        },
        { role: "user", content: context },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenRouter error: ${response.status}`);
  }

  const result = await response.json() as {
    choices: Array<{ message: { content: string } }>;
  };
  const updatedPrefs = result.choices[0]?.message?.content ?? currentPrefs;

  // Update PREFERENCES.md
  const matter = await import("gray-matter").then((m) => m.default);
  const { data } = matter(fs.readFileSync(prefsPath, "utf-8"));
  data.lastUpdated = new Date().toISOString();
  fs.writeFileSync(prefsPath, matter.stringify("\n" + updatedPrefs + "\n", data), "utf-8");

  console.log("[preference-tracker] Preferences updated.");
}

main().catch((err) => {
  console.error("[preference-tracker] Fatal error:", err);
  process.exit(1);
});
