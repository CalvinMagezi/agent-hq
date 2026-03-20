/**
 * Vault inbox scanner — finds pending work across the vault.
 *
 * Scans multiple sources:
 * - .vault/Notebooks/Inbox/ — unprocessed notes
 * - .vault/_jobs/pending/ — pending jobs
 * - .vault/_jobs/failed/ — failed jobs that may need retry
 * - .vault/_tasks/ — stale or pending tasks
 */

import * as fs from "fs";
import * as path from "path";
import matter from "gray-matter";

// ── Types ───────────────────────────────────────────────────────────

export interface InboxItem {
  source: "inbox" | "pending-job" | "failed-job" | "stale-task";
  title: string;
  urgency: "now" | "today" | "this-week" | "someday";
  suggestedAction: string;
  filePath: string;
  createdAt?: string;
}

// ── Scanner ─────────────────────────────────────────────────────────

/**
 * Scan the vault for pending work items, sorted by urgency.
 */
export function scanInbox(vaultPath: string): InboxItem[] {
  const items: InboxItem[] = [];

  // 1. Scan Notebooks/Inbox/ for unprocessed notes
  scanInboxNotes(vaultPath, items);

  // 2. Scan pending jobs
  scanJobs(vaultPath, "pending", items);

  // 3. Scan failed jobs (might need retry)
  scanJobs(vaultPath, "failed", items);

  // 4. Scan stale tasks
  scanStaleTasks(vaultPath, items);

  // Sort by urgency
  const urgencyOrder: Record<string, number> = { now: 0, today: 1, "this-week": 2, someday: 3 };
  items.sort((a, b) => (urgencyOrder[a.urgency] ?? 3) - (urgencyOrder[b.urgency] ?? 3));

  return items;
}

/**
 * Format inbox items as a readable summary.
 */
export function formatInbox(items: InboxItem[]): string {
  if (items.length === 0) {
    return "Inbox is clear — no pending work items found.";
  }

  const grouped: Record<string, InboxItem[]> = {};
  for (const item of items) {
    (grouped[item.urgency] ??= []).push(item);
  }

  const sections: string[] = [];
  const labels: Record<string, string> = {
    now: "Urgent (now)",
    today: "Today",
    "this-week": "This week",
    someday: "Someday",
  };

  for (const [urgency, label] of Object.entries(labels)) {
    const group = grouped[urgency];
    if (!group?.length) continue;
    sections.push(`### ${label}`);
    for (const item of group) {
      sections.push(`- **${item.title}** (${item.source}) — ${item.suggestedAction}`);
    }
  }

  return `## Inbox: ${items.length} item${items.length > 1 ? "s" : ""}\n\n${sections.join("\n")}`;
}

// ── Internal Scanners ───────────────────────────────────────────────

function scanInboxNotes(vaultPath: string, items: InboxItem[]): void {
  const inboxDir = path.join(vaultPath, "Notebooks", "Inbox");
  try {
    if (!fs.existsSync(inboxDir)) return;
    const files = fs.readdirSync(inboxDir).filter(f => f.endsWith(".md"));

    for (const file of files.slice(0, 20)) {
      try {
        const fullPath = path.join(inboxDir, file);
        const content = fs.readFileSync(fullPath, "utf-8");
        const { data } = matter(content);
        const title = data.title || file.replace(".md", "");
        const stat = fs.statSync(fullPath);

        // Urgency based on age
        const ageHours = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60);
        let urgency: InboxItem["urgency"] = "someday";
        if (ageHours < 4) urgency = "now";
        else if (ageHours < 24) urgency = "today";
        else if (ageHours < 168) urgency = "this-week";

        items.push({
          source: "inbox",
          title,
          urgency,
          suggestedAction: "Review and process",
          filePath: fullPath,
          createdAt: stat.birthtimeMs ? new Date(stat.birthtimeMs).toISOString() : undefined,
        });
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Inbox dir doesn't exist
  }
}

function scanJobs(vaultPath: string, status: "pending" | "failed", items: InboxItem[]): void {
  const jobDir = path.join(vaultPath, "_jobs", status);
  try {
    if (!fs.existsSync(jobDir)) return;
    const files = fs.readdirSync(jobDir).filter(f => f.endsWith(".md")).slice(0, 10);

    for (const file of files) {
      try {
        const fullPath = path.join(jobDir, file);
        const content = fs.readFileSync(fullPath, "utf-8");
        const { data } = matter(content);
        const instruction = data.instruction || data.title || file.replace(".md", "");

        const urgency: InboxItem["urgency"] = status === "pending" ? "now" : "today";
        const suggestedAction = status === "pending" ? "Execute" : "Retry or investigate failure";

        items.push({
          source: status === "pending" ? "pending-job" : "failed-job",
          title: typeof instruction === "string" ? instruction.slice(0, 100) : file,
          urgency,
          suggestedAction,
          filePath: fullPath,
          createdAt: data.createdAt,
        });
      } catch {
        // Skip
      }
    }
  } catch {
    // Job dir doesn't exist
  }
}

function scanStaleTasks(vaultPath: string, items: InboxItem[]): void {
  const tasksDir = path.join(vaultPath, "_tasks");
  try {
    if (!fs.existsSync(tasksDir)) return;
    const files = fs.readdirSync(tasksDir).filter(f => f.endsWith(".md")).slice(0, 10);

    for (const file of files) {
      try {
        const fullPath = path.join(tasksDir, file);
        const content = fs.readFileSync(fullPath, "utf-8");
        const { data } = matter(content);

        // Only pick up pending/in-progress tasks
        if (data.status !== "pending" && data.status !== "in-progress") continue;

        const stat = fs.statSync(fullPath);
        const ageHours = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60);

        // Tasks stale for >24h
        if (ageHours < 24) continue;

        items.push({
          source: "stale-task",
          title: data.title || data.description || file.replace(".md", ""),
          urgency: ageHours > 168 ? "this-week" : "today",
          suggestedAction: `Stale for ${Math.round(ageHours / 24)}d — review or close`,
          filePath: fullPath,
          createdAt: data.createdAt,
        });
      } catch {
        // Skip
      }
    }
  } catch {
    // Tasks dir doesn't exist
  }
}
