#!/usr/bin/env bun
/**
 * Vault scaffolding script — creates the .vault/ directory tree
 * and seeds system files for a fresh agent-hq installation.
 *
 * Safe to re-run: existing files and directories are never overwritten.
 *
 * Usage: bun run setup
 */

import * as fs from "fs";
import * as path from "path";

const vaultPath =
  process.env.VAULT_PATH || path.resolve(process.cwd(), ".vault");

console.log(`\nSetting up vault at: ${vaultPath}\n`);

// ── 1. Create directories ───────────────────────────────────────────

const dirs = [
  "_system",
  "_system/orchestrators",
  "_jobs/pending",
  "_jobs/running",
  "_jobs/done",
  "_jobs/failed",
  "_delegation/pending",
  "_delegation/claimed",
  "_delegation/completed",
  "_delegation/relay-health",
  "_delegation/coo_inbox",
  "_delegation/coo_outbox",
  "_threads/active",
  "_threads/archived",
  "_approvals/pending",
  "_approvals/resolved",
  "_logs",
  "_usage/daily",
  "_embeddings",
  "_agent-sessions",
  "_moc",
  "_templates",
  "Notebooks/Memories",
  "Notebooks/Projects",
  "Notebooks/Daily Digest",
  "Notebooks/AI Intelligence",
  "Notebooks/Insights",
  "Notebooks/Discord Memory",
];

let createdDirs = 0;
for (const dir of dirs) {
  const full = path.join(vaultPath, dir);
  if (!fs.existsSync(full)) {
    fs.mkdirSync(full, { recursive: true });
    console.log(`  Created: ${dir}/`);
    createdDirs++;
  }
}

if (createdDirs === 0) {
  console.log("  All directories already exist.");
}

// ── 1.5. Initialize fbmq queues ──────────────────────────────────────

import { spawnSync } from "child_process";

const fbmqQueues = [
  { dir: "_fbmq/jobs", priority: true },
  { dir: "_fbmq/delegation", priority: true },
  { dir: "_fbmq/staged", priority: false },
];

for (const q of fbmqQueues) {
  const full = path.join(vaultPath, q.dir);
  if (!fs.existsSync(full)) {
    fs.mkdirSync(full, { recursive: true });
  }
  const args = ["init", full];
  if (q.priority) args.push("--priority");

  const res = spawnSync("fbmq", args);
  if (res.status === 0) {
    console.log(`  Initialized fbmq: ${q.dir}/`);
  } else {
    // Only warn if it's not simply an "already initialized" error, though fbmq init is idempotent
    console.log(`  fbmq init ${q.dir} returned ${res.status}`);
  }
}


// ── 2. Seed system files (skip if they already exist) ───────────────

const systemFiles: Record<string, string> = {
  "_system/SOUL.md": `---
noteType: system-file
fileName: soul
version: 1
pinned: true
---
# SOUL - Agent Identity

You are a personal AI assistant and knowledge management agent. You operate locally on the user's machine, managing a structured Obsidian vault as your knowledge base.

## Core Principles

1. **Knowledge-first**: Always check existing notes before creating new ones. Build connections between ideas.
2. **Structured thinking**: Use frontmatter metadata consistently. Tag everything meaningfully.
3. **Proactive synthesis**: Don't just store information — connect it, analyze it, surface insights.
4. **Security-aware**: Respect security profiles. Never execute dangerous operations without approval.
5. **Local-first**: All data stays on the local machine. No cloud dependencies for core operations.

## Communication Style

- Be concise and direct
- Use markdown formatting for clarity
- Reference existing notes with \`[[wikilinks]]\` when relevant
- Proactively suggest connections between topics
`,

  "_system/MEMORY.md": `---
noteType: system-file
fileName: memory
version: 1
pinned: true
---
# Agent Memory

## Key Facts

_No facts stored yet._

## Active Goals

_No active goals._

## Recent Work Summary

_No recent work._
`,

  "_system/PREFERENCES.md": `---
noteType: system-file
fileName: preferences
version: 1
pinned: true
---
# User Preferences

_No preferences configured yet. The agent will learn your preferences over time._
`,

  "_system/HEARTBEAT.md": `---
noteType: system-file
fileName: heartbeat
version: 1
lastProcessed: null
---
# Heartbeat

Write actionable tasks here. The daemon processes this file every 2 minutes and dispatches any new content as background jobs.

## Pending Actions

_No pending actions._
`,

  "_system/CONFIG.md": `---
noteType: system-file
fileName: config
version: 1
pinned: false
---
# Configuration

| Key | Value |
|-----|-------|
| DEFAULT_MODEL | gemini-2.5-flash |
| orchestration_mode | internal |
| active_coo         |          |
`,

  "_system/DIGEST-TOPICS.md": `---
noteType: system-file
fileName: digest-topics
version: 1
pinned: false
---
# Digest Topics

Topics of interest for daily web digests. Add URLs or topic descriptions below.

## Topics

_No topics configured yet._
`,
};

console.log("");
let seededFiles = 0;
for (const [relPath, content] of Object.entries(systemFiles)) {
  const full = path.join(vaultPath, relPath);
  if (!fs.existsSync(full)) {
    fs.writeFileSync(full, content, "utf-8");
    console.log(`  Seeded: ${relPath}`);
    seededFiles++;
  } else {
    console.log(`  Exists: ${relPath} (skipped)`);
  }
}

// ── 3. Create .gitkeep files for empty dirs git should track ────────

const gitkeepDirs = [
  "_jobs/pending",
  "_jobs/running",
  "_jobs/done",
  "_jobs/failed",
  "_delegation/pending",
  "_delegation/claimed",
  "_delegation/completed",
  "_delegation/relay-health",
  "_delegation/coo_inbox",
  "_delegation/coo_outbox",
  "_threads/active",
  "_threads/archived",
  "_logs",
];

for (const dir of gitkeepDirs) {
  const gitkeep = path.join(vaultPath, dir, ".gitkeep");
  if (!fs.existsSync(gitkeep)) {
    fs.writeFileSync(gitkeep, "", "utf-8");
  }
}

console.log(`
Setup complete.
  Directories: ${createdDirs} created, ${dirs.length - createdDirs} already existed
  System files: ${seededFiles} seeded, ${Object.keys(systemFiles).length - seededFiles} already existed

Next steps:
  1. Copy apps/discord-relay/.env.local.example to apps/discord-relay/.env.local
  2. Fill in your Discord bot token and user ID
  3. Run: bun run relay
`);
