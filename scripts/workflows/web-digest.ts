#!/usr/bin/env bun
/**
 * Web Digest Workflow — Daily web search digest.
 *
 * Reads topics from _system/DIGEST-TOPICS.md, searches via Brave API,
 * synthesizes with OpenRouter, writes digest to Notebooks/Daily Digest/.
 *
 * Schedule: Daily 7:00 AM UTC (via launchd)
 */

import * as path from "path";
import * as fs from "fs";
import { VaultClient } from "@repo/vault-client";
import { SearchClient } from "@repo/vault-client/search";

const VAULT_PATH = process.env.VAULT_PATH ?? path.resolve(import.meta.dir, "../..", ".vault");
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const BRAVE_API_KEY = process.env.BRAVE_API_KEY;
const DIGEST_MODEL = process.env.DIGEST_MODEL ?? "google/gemini-2.5-flash";

if (!OPENROUTER_API_KEY || !BRAVE_API_KEY) {
  console.error("Error: OPENROUTER_API_KEY and BRAVE_API_KEY are required.");
  process.exit(1);
}

const vault = new VaultClient(VAULT_PATH);

async function braveSearch(query: string, count: number = 5): Promise<Array<{ title: string; url: string; description: string }>> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
  const response = await fetch(url, {
    headers: { "X-Subscription-Token": BRAVE_API_KEY! },
  });

  if (!response.ok) {
    console.error(`Brave search error: ${response.status}`);
    return [];
  }

  const data = await response.json() as {
    web?: { results?: Array<{ title: string; url: string; description: string }> };
  };
  return data.web?.results ?? [];
}

async function generateDigest(topics: string[], searchResults: Map<string, Array<{ title: string; url: string; description: string }>>): Promise<string> {
  const context = Array.from(searchResults.entries())
    .map(([topic, results]) => {
      const items = results.map((r) => `- [${r.title}](${r.url}): ${r.description}`).join("\n");
      return `### ${topic}\n${items}`;
    })
    .join("\n\n");

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: DIGEST_MODEL,
      messages: [
        {
          role: "system",
          content: "You are a research analyst creating a daily briefing. Summarize the key developments, identify trends, and highlight actionable insights. Write in concise bullet points. Include source URLs.",
        },
        {
          role: "user",
          content: `Create a daily digest from these search results:\n\n${context}`,
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
  return result.choices[0]?.message?.content ?? "No digest generated.";
}

async function main(): Promise<void> {
  console.log("[web-digest] Starting daily web digest...");

  // Load topics from DIGEST-TOPICS.md
  const topicsPath = path.join(VAULT_PATH, "_system/DIGEST-TOPICS.md");
  const topicsContent = fs.readFileSync(topicsPath, "utf-8");
  const topics = topicsContent
    .split("\n")
    .filter((line) => /^-\s+/.test(line))
    .map((line) => line.replace(/^-\s+/, "").trim())
    .filter(Boolean);

  if (topics.length === 0) {
    console.log("[web-digest] No topics found. Skipping.");
    return;
  }

  console.log(`[web-digest] Searching ${topics.length} topic(s)...`);

  // Search each topic
  const searchResults = new Map<string, Array<{ title: string; url: string; description: string }>>();
  for (const topic of topics) {
    const results = await braveSearch(topic, 5);
    searchResults.set(topic, results);
    console.log(`[web-digest] ${topic}: ${results.length} results`);
  }

  // Generate digest
  console.log("[web-digest] Generating digest...");
  const digest = await generateDigest(topics, searchResults);

  // Seed initial wikilinks from keyword search
  const search = new SearchClient(VAULT_PATH);
  const today = new Date().toISOString().split("T")[0];
  const noteTitle = `Daily Digest ${today}`;
  const related = search.keywordSearch(topics.join(" "), 5)
    .filter((r) => !r.notePath.includes(noteTitle));
  search.close();

  let body = digest;
  if (related.length > 0) {
    const links = related.map((r) => `- [[${r.title}]]`).join("\n");
    body += `\n\n<!-- agent-hq-graph-links -->\n## Related Notes\n\n${links}\n`;
  }

  // Save to vault
  await vault.createNote("Daily Digest", noteTitle, body, {
    noteType: "digest",
    tags: ["daily-digest", "auto-generated"],
    source: "web-digest",
  });

  console.log(`[web-digest] Digest saved: Daily Digest ${today}`);
}

main().catch((err) => {
  console.error("[web-digest] Fatal error:", err);
  process.exit(1);
});
