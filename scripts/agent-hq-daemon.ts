#!/usr/bin/env bun
/**
 * agent-hq-daemon — Local replacement for Convex cron jobs.
 *
 * A single long-running process that handles all interval-based tasks:
 * - 1 min: Expire stale approvals
 * - 2 min: Process heartbeat note
 * - 5 min: Health checks (stuck jobs, offline workers, relay health)
 * - 10 min: Process pending embeddings
 * - 1 hr: Clean up stale jobs (>7 days old)
 * - 2 hr: Note linking (semantic similarity + wikilinks)
 * - 12 hr: Topic MOC generation (auto-growing Maps of Content)
 *
 * Usage: bun run scripts/agent-hq-daemon.ts
 */

import * as path from "path";
import * as fs from "fs";
import { VaultClient } from "@repo/vault-client";
import { SearchClient } from "@repo/vault-client/search";
import { calculateCost } from "@repo/vault-client/pricing";

// ─── Configuration ───────────────────────────────────────────────────

const VAULT_PATH =
  process.env.VAULT_PATH ??
  path.resolve(import.meta.dir, "..", ".vault");

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "openai/text-embedding-3-small";
const STALE_JOB_DAYS = 7;
const STUCK_JOB_HOURS = 2;
const OFFLINE_WORKER_SECONDS = 30;
const RELAY_STALE_SECONDS = 60;

// ─── Initialization ──────────────────────────────────────────────────

const vault = new VaultClient(VAULT_PATH);
let search: SearchClient;

try {
  search = new SearchClient(VAULT_PATH);
} catch (err) {
  console.error("[daemon] Failed to initialize search client:", err);
  process.exit(1);
}

console.log(`[daemon] Started. Vault: ${VAULT_PATH}`);
console.log(`[daemon] Press Ctrl+C to stop.`);

// ─── Task: Expire Stale Approvals (every 1 min) ─────────────────────

async function expireApprovals(): Promise<void> {
  const pendingDir = path.join(VAULT_PATH, "_approvals/pending");
  if (!fs.existsSync(pendingDir)) return;

  const files = fs
    .readdirSync(pendingDir)
    .filter((f) => f.endsWith(".md"));
  const now = Date.now();
  let expired = 0;

  for (const file of files) {
    try {
      const filePath = path.join(pendingDir, file);
      const raw = fs.readFileSync(filePath, "utf-8");
      const matter = await import("gray-matter").then((m) => m.default);
      const { data } = matter(raw);

      if (data.expiresAt && new Date(data.expiresAt).getTime() < now) {
        await vault.resolveApproval(data.approvalId, "rejected", "system", "Expired");
        expired++;
      }
    } catch {
      // Skip malformed files
    }
  }

  if (expired > 0) {
    console.log(`[approvals] Expired ${expired} stale approval(s)`);
  }
}

// ─── Task: Process Heartbeat (every 2 min) ───────────────────────────

async function processHeartbeat(): Promise<void> {
  const heartbeatPath = path.join(VAULT_PATH, "_system/HEARTBEAT.md");
  if (!fs.existsSync(heartbeatPath)) return;

  try {
    const matter = await import("gray-matter").then((m) => m.default);
    const raw = fs.readFileSync(heartbeatPath, "utf-8");
    const { data, content } = matter(raw);

    // Look for pending actions section
    const actionsMatch = content.match(
      /## Pending Actions\s*\n([\s\S]*?)(?=\n##|$)/,
    );
    if (!actionsMatch) return;

    const actionsText = actionsMatch[1].trim();
    if (actionsText === "_No pending actions._" || !actionsText) return;

    // Extract individual tasks (lines starting with - or *)
    const tasks = actionsText
      .split("\n")
      .filter((line) => /^[-*]\s+/.test(line))
      .map((line) => line.replace(/^[-*]\s+/, "").trim())
      .filter(Boolean);

    if (tasks.length === 0) return;

    // Create a background job for each task
    for (const task of tasks) {
      const jobId = await vault.createJob({
        instruction: task,
        type: "background",
        priority: 40,
        securityProfile: "standard",
      });
      console.log(`[heartbeat] Created job ${jobId}: ${task.substring(0, 60)}...`);
    }

    // Clear the pending actions
    const updatedContent = content.replace(
      /## Pending Actions\s*\n[\s\S]*?(?=\n##|$)/,
      "## Pending Actions\n\n_No pending actions._\n",
    );
    data.lastProcessed = new Date().toISOString();
    fs.writeFileSync(heartbeatPath, matter.stringify("\n" + updatedContent + "\n", data), "utf-8");

    console.log(`[heartbeat] Processed ${tasks.length} action(s)`);
  } catch (err) {
    console.error("[heartbeat] Error:", err);
  }
}

// ─── Task: Health Check (every 5 min) ────────────────────────────────

async function healthCheck(): Promise<void> {
  const now = Date.now();

  // Check for stuck jobs (running > STUCK_JOB_HOURS)
  const runningDir = path.join(VAULT_PATH, "_jobs/running");
  if (fs.existsSync(runningDir)) {
    const files = fs
      .readdirSync(runningDir)
      .filter((f) => f.endsWith(".md"));

    for (const file of files) {
      try {
        const filePath = path.join(runningDir, file);
        const matter = await import("gray-matter").then((m) => m.default);
        const { data } = matter(fs.readFileSync(filePath, "utf-8"));

        const updatedAt = data.updatedAt ?? data.createdAt;
        if (updatedAt) {
          const elapsed = now - new Date(updatedAt).getTime();
          if (elapsed > STUCK_JOB_HOURS * 3600 * 1000) {
            await vault.updateJobStatus(data.jobId, "failed", {
              result: `Job stuck for ${Math.round(elapsed / 3600000)}h, marked as failed by health check`,
            });
            console.log(`[health] Failed stuck job: ${data.jobId}`);
          }
        }
      } catch {
        // Skip
      }
    }
  }

  // Check for offline workers
  const sessionsDir = path.join(VAULT_PATH, "_agent-sessions");
  if (fs.existsSync(sessionsDir)) {
    const files = fs
      .readdirSync(sessionsDir)
      .filter((f) => f.endsWith(".md"));

    for (const file of files) {
      try {
        const filePath = path.join(sessionsDir, file);
        const matter = await import("gray-matter").then((m) => m.default);
        const raw = fs.readFileSync(filePath, "utf-8");
        const { data, content } = matter(raw);

        if (data.status === "online" && data.lastHeartbeat) {
          const elapsed = now - new Date(data.lastHeartbeat).getTime();
          if (elapsed > OFFLINE_WORKER_SECONDS * 1000) {
            data.status = "offline";
            fs.writeFileSync(filePath, matter.stringify("\n" + content + "\n", data), "utf-8");
            console.log(`[health] Worker ${data.workerId} marked offline`);
          }
        }
      } catch {
        // Skip
      }
    }
  }
}

// ─── Task: Relay Health Check (every 5 min) ──────────────────────────

async function relayHealthCheck(): Promise<void> {
  const now = Date.now();
  const relays = await vault.getRelayHealthAll();

  for (const relay of relays) {
    if (relay.lastHeartbeat) {
      const elapsed = now - new Date(relay.lastHeartbeat).getTime();

      let newStatus = relay.status;
      if (elapsed > RELAY_STALE_SECONDS * 2 * 1000) {
        newStatus = "offline";
      } else if (elapsed > RELAY_STALE_SECONDS * 1000) {
        newStatus = "degraded";
      }

      if (newStatus !== relay.status) {
        await vault.upsertRelayHealth(relay.relayId, { status: newStatus });
        console.log(
          `[relay-health] ${relay.displayName}: ${relay.status} -> ${newStatus}`,
        );
      }
    }
  }

  // Time out stale claimed tasks
  const claimedDir = path.join(VAULT_PATH, "_delegation/claimed");
  if (fs.existsSync(claimedDir)) {
    const files = fs
      .readdirSync(claimedDir)
      .filter((f) => f.endsWith(".md"));
    const matter = await import("gray-matter").then((m) => m.default);

    for (const file of files) {
      try {
        const filePath = path.join(claimedDir, file);
        const { data } = matter(fs.readFileSync(filePath, "utf-8"));

        if (data.claimedAt && data.deadlineMs) {
          const elapsed = now - new Date(data.claimedAt).getTime();
          if (elapsed > data.deadlineMs) {
            await vault.updateTaskStatus(data.taskId, "timeout");
            console.log(`[relay-health] Task ${data.taskId} timed out`);
          }
        }
      } catch {
        // Skip
      }
    }
  }
}

// ─── Task: Embedding Processor (every 10 min) ───────────────────────

async function processEmbeddings(): Promise<void> {
  if (!OPENROUTER_API_KEY) {
    return; // Skip if no API key
  }

  const pendingNotes = await vault.getNotesForEmbedding("pending", 10);
  if (pendingNotes.length === 0) return;

  console.log(`[embeddings] Processing ${pendingNotes.length} note(s)...`);

  for (const note of pendingNotes) {
    try {
      // Mark as processing
      await vault.updateNote(note._filePath, undefined, {
        embeddingStatus: "processing",
      });

      // Generate embedding via OpenRouter
      const text = `${note.title}\n\n${note.content}`.substring(0, 8000);
      const response = await fetch(
        "https://openrouter.ai/api/v1/embeddings",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: EMBEDDING_MODEL,
            input: text,
          }),
        },
      );

      if (!response.ok) {
        throw new Error(`Embedding API error: ${response.status}`);
      }

      const result = (await response.json()) as {
        data: Array<{ embedding: number[] }>;
      };
      const embedding = result.data[0]?.embedding;

      if (!embedding) {
        throw new Error("No embedding returned");
      }

      // Store embedding in search index
      search.storeEmbedding(note._filePath, embedding, EMBEDDING_MODEL);

      // Also index for FTS
      search.indexNote(note._filePath, note.title, note.content, note.tags);

      // Update frontmatter
      await vault.updateNote(note._filePath, undefined, {
        embeddingStatus: "embedded",
        embeddedAt: new Date().toISOString(),
        embeddingModel: EMBEDDING_MODEL,
      });

      console.log(`[embeddings] Embedded: ${note.title}`);
    } catch (err) {
      await vault.updateNote(note._filePath, undefined, {
        embeddingStatus: "failed",
      });
      console.error(`[embeddings] Failed: ${note.title}:`, err);
    }
  }
}

// ─── Task: Stale Job Cleanup (every 1 hr) ────────────────────────────

async function cleanupStaleJobs(): Promise<void> {
  const now = Date.now();
  const maxAge = STALE_JOB_DAYS * 24 * 3600 * 1000;
  let cleaned = 0;

  for (const dir of ["done", "failed"]) {
    const fullDir = path.join(VAULT_PATH, `_jobs/${dir}`);
    if (!fs.existsSync(fullDir)) continue;

    const files = fs.readdirSync(fullDir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      try {
        const filePath = path.join(fullDir, file);
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > maxAge) {
          fs.unlinkSync(filePath);
          cleaned++;
        }
      } catch {
        // Skip
      }
    }
  }

  // Clean old log files
  const logsDir = path.join(VAULT_PATH, "_logs");
  if (fs.existsSync(logsDir)) {
    const dateDirs = fs.readdirSync(logsDir, { withFileTypes: true });
    for (const d of dateDirs) {
      if (d.isDirectory()) {
        const dirPath = path.join(logsDir, d.name);
        const stat = fs.statSync(dirPath);
        if (now - stat.mtimeMs > maxAge) {
          fs.rmSync(dirPath, { recursive: true });
          cleaned++;
        }
      }
    }
  }

  if (cleaned > 0) {
    console.log(`[cleanup] Removed ${cleaned} stale item(s)`);
  }
}

// ─── Task: Note Linking (every 2 hr) ─────────────────────────────────

const SIMILARITY_THRESHOLD = 0.75;
const MAX_LINKS_PER_NOTE = 5;
const TAG_BONUS_PER_SHARED = 0.05;
const TAG_BONUS_CAP = 0.15;
const GRAPH_LINK_MARKER = "<!-- agent-hq-graph-links -->";

interface EmbeddedNote {
  absPath: string;
  relPath: string;
  title: string;
  tags: string[];
  contentHash: string;
}

interface NoteLink {
  relPath: string;
  title: string;
  score: number;
  type: string;
}

async function processNoteLinking(): Promise<void> {
  const stats = search.getStats();
  if (stats.embeddingCount < 2) return;

  console.log(
    `[linking] Processing note links across ${stats.embeddingCount} embedded notes...`,
  );

  const notebooksDir = path.join(VAULT_PATH, "Notebooks");
  if (!fs.existsSync(notebooksDir)) return;

  const matter = await import("gray-matter").then((m) => m.default);

  // Step 1: Scan all embedded notes
  const embeddedNotes: EmbeddedNote[] = [];

  const scanDir = (dir: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (entry.name.endsWith(".md")) {
        try {
          const raw = fs.readFileSync(fullPath, "utf-8");
          const { data } = matter(raw);
          if (data.embeddingStatus === "embedded") {
            const relPath = path.relative(VAULT_PATH, fullPath);
            // Strip the managed section before hashing so link updates don't trigger re-linking
            const contentForHash = raw.replace(
              new RegExp(`${escapeRegex(GRAPH_LINK_MARKER)}[\\s\\S]*$`),
              "",
            );
            embeddedNotes.push({
              absPath: fullPath,
              relPath,
              title: path.basename(entry.name, ".md"),
              tags: data.tags ?? [],
              contentHash: Bun.hash(contentForHash).toString(36),
            });
          }
        } catch {
          // Skip
        }
      }
    }
  };

  scanDir(notebooksDir);

  // Step 2: Identify dirty notes (changed since last linked or never linked)
  const dirtyNotes = embeddedNotes.filter((note) => {
    const state = search.getLinkState(note.relPath);
    if (!state) return true;
    return state.contentHash !== note.contentHash;
  });

  if (dirtyNotes.length === 0) {
    console.log("[linking] No notes need relinking.");
    return;
  }

  console.log(
    `[linking] ${dirtyNotes.length} of ${embeddedNotes.length} note(s) need relinking...`,
  );

  // Build tag index for bonus scoring
  const tagIndex = new Map<string, string[]>();
  for (const note of embeddedNotes) {
    for (const tag of note.tags) {
      const existing = tagIndex.get(tag) ?? [];
      existing.push(note.relPath);
      tagIndex.set(tag, existing);
    }
  }

  // Step 3: Find similar notes and compute final scores
  const pendingUpdates = new Map<
    string,
    { links: NoteLink[]; tags: string[] }
  >();

  for (const note of dirtyNotes) {
    const similar = search.findSimilarNotes(
      note.relPath,
      MAX_LINKS_PER_NOTE * 2,
      SIMILARITY_THRESHOLD,
    );

    // Apply tag bonus
    const scored: NoteLink[] = similar.map((hit) => {
      const targetNote = embeddedNotes.find((n) => n.relPath === hit.notePath);
      let tagBonus = 0;
      if (targetNote) {
        const sharedTags = note.tags.filter((t) =>
          targetNote.tags.includes(t),
        );
        tagBonus = Math.min(
          sharedTags.length * TAG_BONUS_PER_SHARED,
          TAG_BONUS_CAP,
        );
      }
      return {
        relPath: hit.notePath,
        title: hit.title,
        score: hit.relevance + tagBonus,
        type: tagBonus > 0 ? "semantic+tags" : "semantic",
      };
    });

    scored.sort((a, b) => b.score - a.score);
    const topLinks = scored.slice(0, MAX_LINKS_PER_NOTE);

    if (topLinks.length > 0) {
      pendingUpdates.set(note.relPath, { links: topLinks, tags: note.tags });
    }
  }

  // Step 4: Enforce bidirectionality — for every A→B, also queue B→A
  const bidirectionalUpdates = new Map(pendingUpdates);

  for (const [sourcePath, { links }] of pendingUpdates) {
    for (const link of links) {
      let targetEntry = bidirectionalUpdates.get(link.relPath);
      if (!targetEntry) {
        const targetNote = embeddedNotes.find(
          (n) => n.relPath === link.relPath,
        );
        targetEntry = { links: [], tags: targetNote?.tags ?? [] };
        bidirectionalUpdates.set(link.relPath, targetEntry);
      }
      const alreadyLinked = targetEntry.links.some(
        (l) => l.relPath === sourcePath,
      );
      if (!alreadyLinked) {
        const sourceNote = embeddedNotes.find(
          (n) => n.relPath === sourcePath,
        );
        targetEntry.links.push({
          relPath: sourcePath,
          title: sourceNote?.title ?? path.basename(sourcePath, ".md"),
          score: link.score,
          type: link.type,
        });
      }
    }
  }

  // Step 5: Write wikilinks into note bodies and update frontmatter
  let updated = 0;
  for (const [notePath, { links }] of bidirectionalUpdates) {
    try {
      const absPath = path.join(VAULT_PATH, notePath);
      if (!fs.existsSync(absPath)) continue;

      const raw = fs.readFileSync(absPath, "utf-8");
      const { data, content } = matter(raw);

      // Build the Related Notes section with wikilinks
      const relatedSection = buildRelatedSection(links);

      // Replace or append the managed section
      let newContent: string;
      if (content.includes(GRAPH_LINK_MARKER)) {
        newContent = content.replace(
          new RegExp(`${escapeRegex(GRAPH_LINK_MARKER)}[\\s\\S]*$`),
          relatedSection,
        );
      } else {
        newContent = content.trimEnd() + "\n\n" + relatedSection;
      }

      // Also update frontmatter relatedNotes for non-Obsidian consumers
      data.relatedNotes = links.map((l) => `[[${l.title}]]`);
      data.updatedAt = new Date().toISOString();

      fs.writeFileSync(
        absPath,
        matter.stringify("\n" + newContent + "\n", data),
        "utf-8",
      );

      // Record state so we skip this note next cycle (unless content changes)
      const contentForHash = fs
        .readFileSync(absPath, "utf-8")
        .replace(
          new RegExp(`${escapeRegex(GRAPH_LINK_MARKER)}[\\s\\S]*$`),
          "",
        );
      search.setLinkState(notePath, Bun.hash(contentForHash).toString(36));

      // Store links in SQLite for analysis
      search.removeGraphLinks(notePath);
      for (const link of links) {
        search.addGraphLink(notePath, link.relPath, link.score, link.type);
      }

      updated++;
    } catch (err) {
      console.error(`[linking] Error updating ${notePath}:`, err);
    }
  }

  if (updated > 0) {
    console.log(`[linking] Updated links for ${updated} note(s)`);
  }
}

function buildRelatedSection(links: NoteLink[]): string {
  const lines = [GRAPH_LINK_MARKER, "## Related Notes", ""];

  for (const link of links) {
    const scoreLabel = (link.score * 100).toFixed(0);
    const typeIndicator = link.type.includes("tags") ? " #" : "";
    lines.push(
      `- [[${link.title}]]${typeIndicator} _(${scoreLabel}% similar)_`,
    );
  }

  lines.push(""); // trailing newline
  return lines.join("\n");
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Task: Topic MOC Generation (every 12 hr) ───────────────────────

const MOC_LINK_MARKER = "<!-- agent-hq-moc-links -->";
const MIN_NOTES_FOR_MOC = 3;
const SKIP_TAGS = new Set([
  "auto-generated",
  "daily-digest",
  "weekly-analysis",
  "moc",
]);

async function processTopicMOCs(): Promise<void> {
  const matter = await import("gray-matter").then((m) => m.default);
  const mocDir = path.join(VAULT_PATH, "_moc");
  if (!fs.existsSync(mocDir)) {
    fs.mkdirSync(mocDir, { recursive: true });
  }

  const tagCounts = search.getAllTags();
  let created = 0;
  let updated = 0;

  for (const [tag, count] of tagCounts) {
    if (count < MIN_NOTES_FOR_MOC || SKIP_TAGS.has(tag)) continue;

    const notePaths = search.getTaggedNotePaths(tag);
    if (notePaths.length < MIN_NOTES_FOR_MOC) continue;

    const safeName = tag.replace(/[/\\:*?"<>|]/g, "-");
    const titleCase =
      tag.charAt(0).toUpperCase() + tag.slice(1).replace(/-/g, " ");
    const mocPath = path.join(mocDir, `Topic - ${safeName}.md`);

    // Build wikilinks section
    const wikilinks = notePaths
      .map((p) => {
        const title = path.basename(p, ".md");
        return `- [[${title}]]`;
      })
      .join("\n");

    const managedSection = `${MOC_LINK_MARKER}\n### Linked Notes\n\n${wikilinks}\n`;

    if (!fs.existsSync(mocPath)) {
      // Create new MOC
      const frontmatter = {
        tags: ["moc", tag],
        autoGenerated: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const content = [
        `# ${titleCase}`,
        "",
        "```dataview",
        `TABLE noteType, tags, updatedAt`,
        `FROM "Notebooks"`,
        `WHERE contains(tags, "${tag}")`,
        `SORT updatedAt DESC`,
        "```",
        "",
        managedSection,
      ].join("\n");

      fs.writeFileSync(
        mocPath,
        matter.stringify("\n" + content + "\n", frontmatter),
        "utf-8",
      );
      created++;
    } else {
      // Update existing MOC's managed section
      const raw = fs.readFileSync(mocPath, "utf-8");
      const { data, content } = matter(raw);

      let newContent: string;
      if (content.includes(MOC_LINK_MARKER)) {
        newContent = content.replace(
          new RegExp(`${escapeRegex(MOC_LINK_MARKER)}[\\s\\S]*$`),
          managedSection,
        );
      } else {
        newContent = content.trimEnd() + "\n\n" + managedSection;
      }

      data.updatedAt = new Date().toISOString();
      fs.writeFileSync(
        mocPath,
        matter.stringify("\n" + newContent + "\n", data),
        "utf-8",
      );
      updated++;
    }
  }

  if (created + updated > 0) {
    console.log(`[moc] Created ${created}, updated ${updated} topic MOC(s)`);
  }
}

// ─── Scheduler ───────────────────────────────────────────────────────

interface ScheduledTask {
  name: string;
  intervalMs: number;
  fn: () => Promise<void>;
  lastRun: number;
}

const tasks: ScheduledTask[] = [
  {
    name: "expire-approvals",
    intervalMs: 60 * 1000,
    fn: expireApprovals,
    lastRun: 0,
  },
  {
    name: "heartbeat",
    intervalMs: 2 * 60 * 1000,
    fn: processHeartbeat,
    lastRun: 0,
  },
  {
    name: "health-check",
    intervalMs: 5 * 60 * 1000,
    fn: healthCheck,
    lastRun: 0,
  },
  {
    name: "relay-health",
    intervalMs: 5 * 60 * 1000,
    fn: relayHealthCheck,
    lastRun: 0,
  },
  {
    name: "embeddings",
    intervalMs: 10 * 60 * 1000,
    fn: processEmbeddings,
    lastRun: 0,
  },
  {
    name: "stale-cleanup",
    intervalMs: 60 * 60 * 1000,
    fn: cleanupStaleJobs,
    lastRun: 0,
  },
  {
    name: "note-linking",
    intervalMs: 2 * 60 * 60 * 1000,
    fn: processNoteLinking,
    lastRun: 0,
  },
  {
    name: "topic-mocs",
    intervalMs: 12 * 60 * 60 * 1000,
    fn: processTopicMOCs,
    lastRun: 0,
  },
];

async function runScheduler(): Promise<void> {
  // Run all tasks immediately on startup
  for (const task of tasks) {
    try {
      await task.fn();
      task.lastRun = Date.now();
    } catch (err) {
      console.error(`[${task.name}] Error on startup:`, err);
    }
  }

  // Main loop — check every 30 seconds
  setInterval(async () => {
    const now = Date.now();
    for (const task of tasks) {
      if (now - task.lastRun >= task.intervalMs) {
        try {
          await task.fn();
        } catch (err) {
          console.error(`[${task.name}] Error:`, err);
        }
        task.lastRun = now;
      }
    }
  }, 30_000);
}

// ─── Graceful Shutdown ───────────────────────────────────────────────

process.on("SIGINT", () => {
  console.log("\n[daemon] Shutting down...");
  search.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("[daemon] Received SIGTERM, shutting down...");
  search.close();
  process.exit(0);
});

// ─── Start ───────────────────────────────────────────────────────────

runScheduler().catch((err) => {
  console.error("[daemon] Fatal error:", err);
  process.exit(1);
});
