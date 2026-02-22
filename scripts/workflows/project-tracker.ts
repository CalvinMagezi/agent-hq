#!/usr/bin/env bun
/**
 * Project Tracker Workflow — Weekly project-specific web search.
 *
 * Searches for updates related to each project notebook.
 *
 * Schedule: Friday 9:00 AM UTC (via launchd)
 */

import * as path from "path";
import * as fs from "fs";
import { VaultClient } from "@repo/vault-client";
import { SearchClient } from "@repo/vault-client/search";

const VAULT_PATH = process.env.VAULT_PATH ?? path.resolve(import.meta.dir, "../..", ".vault");
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const BRAVE_API_KEY = process.env.BRAVE_API_KEY;
const MODEL = process.env.PROJECT_MODEL ?? "google/gemini-2.5-flash";

if (!OPENROUTER_API_KEY) {
  console.error("Error: OPENROUTER_API_KEY is required.");
  process.exit(1);
}

const vault = new VaultClient(VAULT_PATH);

async function main(): Promise<void> {
  console.log("[project-tracker] Starting weekly project tracking...");

  const projectsDir = path.join(VAULT_PATH, "Notebooks/Projects");
  if (!fs.existsSync(projectsDir)) {
    console.log("[project-tracker] No projects directory found.");
    return;
  }

  const projects = fs
    .readdirSync(projectsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  if (projects.length === 0) {
    console.log("[project-tracker] No projects found.");
    return;
  }

  for (const project of projects) {
    console.log(`[project-tracker] Tracking: ${project}`);

    // Search for project-related news
    let searchContext = "";
    if (BRAVE_API_KEY) {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(project + " latest news updates")}&count=5`;
      const response = await fetch(url, {
        headers: { "X-Subscription-Token": BRAVE_API_KEY },
      });
      if (response.ok) {
        const data = await response.json() as {
          web?: { results?: Array<{ title: string; url: string; description: string }> };
        };
        const results = data.web?.results ?? [];
        searchContext = results
          .map((r) => `- [${r.title}](${r.url}): ${r.description}`)
          .join("\n");
      }
    }

    if (!searchContext) {
      console.log(`[project-tracker] No search results for ${project}. Skipping.`);
      continue;
    }

    // Generate update note
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
            content: `Summarize the latest developments for the project "${project}". Focus on actionable insights, breaking changes, and new opportunities.`,
          },
          { role: "user", content: searchContext },
        ],
      }),
    });

    if (!response.ok) continue;

    const result = await response.json() as {
      choices: Array<{ message: { content: string } }>;
    };
    const update = result.choices[0]?.message?.content;

    if (update) {
      // Seed initial wikilinks from keyword search
      const search = new SearchClient(VAULT_PATH);
      const today = new Date().toISOString().split("T")[0];
      const noteTitle = `Tech Update ${today}`;
      const related = search.keywordSearch(project, 5)
        .filter((r) => !r.notePath.includes(noteTitle));
      search.close();

      let body = update;
      if (related.length > 0) {
        const links = related.map((r) => `- [[${r.title}]]`).join("\n");
        body += `\n\n<!-- agent-hq-graph-links -->\n## Related Notes\n\n${links}\n`;
      }

      await vault.createNote(
        `Projects/${project}`,
        noteTitle,
        body,
        {
          noteType: "report",
          tags: ["project-tracker", "auto-generated", project.toLowerCase()],
          source: "project-tracker",
        },
      );
      console.log(`[project-tracker] Update saved for ${project}`);
    }
  }
}

main().catch((err) => {
  console.error("[project-tracker] Fatal error:", err);
  process.exit(1);
});
