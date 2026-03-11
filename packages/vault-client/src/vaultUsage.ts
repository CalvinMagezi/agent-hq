/**
 * VaultClient — Usage tracking and recent activity methods.
 */

import * as fs from "fs";
import * as path from "path";
import matter from "gray-matter";
import { VaultClient } from "./core";
import { calculateCost } from "./pricing";
import type { RecentActivityEntry, UsageRecord, ModelPricing } from "./types";

declare module "./core" {
  interface VaultClient {
    logUsage(
      model: string,
      tokens: { promptTokens: number; completionTokens: number; totalTokens: number },
      cost?: number,
    ): Promise<void>;

    // Recent Activity
    appendRecentActivity(entry: RecentActivityEntry): Promise<void>;
    getRecentActivity(limit?: number): Promise<RecentActivityEntry[]>;
    getRecentActivityContext(limit?: number): Promise<string>;

    // Usage records
    recordUsage(record: UsageRecord): Promise<void>;
    getPricingCache(): Record<string, { inputPer1k: number; outputPer1k: number }>;
  }
}

// ─── Usage Tracking ────────────────────────────────────────────────

VaultClient.prototype.logUsage = async function (model, tokens, cost) {
  const today = new Date().toISOString().split("T")[0];
  const dailyFile = this.resolve("_usage/daily", `${today}.md`);

  const computedCost =
    cost ?? calculateCost(model, tokens.promptTokens, tokens.completionTokens);
  const timestamp = this.nowISO();
  const entry = `| ${timestamp.split("T")[1]?.substring(0, 8)} | ${model} | ${tokens.promptTokens} | ${tokens.completionTokens} | $${computedCost.toFixed(4)} |\n`;

  if (!fs.existsSync(dailyFile)) {
    const header = `---\ndate: "${today}"\ntotalPromptTokens: 0\ntotalCompletionTokens: 0\ntotalCost: 0\nrequestCount: 0\n---\n# Usage: ${today}\n\n| Time | Model | Prompt | Completion | Cost |\n|------|-------|--------|------------|------|\n`;
    fs.writeFileSync(dailyFile, header + entry, "utf-8");
  } else {
    fs.appendFileSync(dailyFile, entry, "utf-8");
  }

  try {
    const { data } = this.readMdFile(dailyFile);
    data.totalPromptTokens = (data.totalPromptTokens ?? 0) + tokens.promptTokens;
    data.totalCompletionTokens =
      (data.totalCompletionTokens ?? 0) + tokens.completionTokens;
    data.totalCost = (data.totalCost ?? 0) + computedCost;
    data.requestCount = (data.requestCount ?? 0) + 1;
    const raw = fs.readFileSync(dailyFile, "utf-8");
    const parsed = matter(raw);
    Object.assign(parsed.data, data);
    fs.writeFileSync(dailyFile, matter.stringify(parsed.content, parsed.data), "utf-8");
  } catch {
    // Non-critical
  }
};

// ─── Recent Activity ─────────────────────────────────────────────────

VaultClient.prototype.appendRecentActivity = async function (entry) {
  const filePath = this.resolve("_system", "RECENT_ACTIVITY.md");
  const MAX_ENTRIES = 30;
  const MAX_CONTENT_LENGTH = 1000;

  let entries: RecentActivityEntry[] = [];

  if (fs.existsSync(filePath)) {
    try {
      const { data } = this.readMdFile(filePath);
      entries = (data.entries as RecentActivityEntry[]) ?? [];
    } catch {
      entries = [];
    }
  }

  const truncatedContent = entry.content.length > MAX_CONTENT_LENGTH
    ? entry.content.substring(0, MAX_CONTENT_LENGTH) + "..."
    : entry.content;

  entries.push({
    ...entry,
    content: truncatedContent.length > 200 ? truncatedContent.substring(0, 200) + "..." : truncatedContent,
  });

  if (entries.length > MAX_ENTRIES) {
    entries = entries.slice(-MAX_ENTRIES);
  }

  const lines = entries.slice().reverse().map(e => {
    const roleLabel = e.role === "user" ? "User" : "Assistant";
    const sourceLabel = e.source === "discord" ? "[Discord]" : e.source === "chat" ? "[Chat]" : "[Job]";
    const channelInfo = e.channel ? ` (#${e.channel.substring(0, 8)})` : "";
    const time = new Date(e.timestamp).toLocaleString();
    return `### ${roleLabel} ${sourceLabel}${channelInfo} — ${time}\n\n${e.content}`;
  });

  const content = `# Recent Activity\n\nA rolling log of the most recent conversations across Discord, Chat, and Jobs.\n\n---\n\n${lines.join("\n\n---\n\n")}`;

  this.writeMdFile(filePath, { entries, updatedAt: this.nowISO() }, content);
};

VaultClient.prototype.getRecentActivity = async function (limit = 15) {
  const filePath = this.resolve("_system", "RECENT_ACTIVITY.md");

  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const { data } = this.readMdFile(filePath);
    const entries = (data.entries as RecentActivityEntry[]) ?? [];
    return entries.slice(-limit);
  } catch {
    return [];
  }
};

VaultClient.prototype.getRecentActivityContext = async function (limit = 15) {
  const entries = await this.getRecentActivity(limit);

  if (entries.length === 0) {
    return "";
  }

  const lines = entries.map(e => {
    const roleLabel = e.role === "user" ? "User" : "Assistant";
    const sourceLabel = e.source === "discord" ? "Discord" : e.source === "chat" ? "Chat" : "Job";
    const time = new Date(e.timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
    return `[${time} ${sourceLabel}] ${roleLabel}: ${e.content}`;
  });

  return `## Recent Conversation History (${entries.length} messages)\n\n` + lines.join("\n\n");
};

// ─── Usage Records ─────────────────────────────────────────────────

VaultClient.prototype.recordUsage = async function (record) {
  const today = new Date().toISOString().slice(0, 10);
  const dailyDir = this.resolve("_usage/daily");
  if (!fs.existsSync(dailyDir)) fs.mkdirSync(dailyDir, { recursive: true });

  const filePath = path.join(dailyDir, `${today}.md`);
  const line = `- ${record.timestamp} | ${record.model} | in:${record.inputTokens} out:${record.outputTokens} | $${record.estimatedCostUsd.toFixed(6)} | task:${record.taskId}\n`;

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `# Usage Log — ${today}\n\n`, "utf-8");
  }
  fs.appendFileSync(filePath, line, "utf-8");
};

VaultClient.prototype.getPricingCache = function () {
  const cachePath = this.resolve("_usage/pricing-cache.md");
  if (!fs.existsSync(cachePath)) return {};

  try {
    const matterLib = require("gray-matter");
    const { data } = matterLib(fs.readFileSync(cachePath, "utf-8"));
    return ((data.models as ModelPricing[] | undefined) ?? []).reduce(
      (acc: Record<string, { inputPer1k: number; outputPer1k: number }>, m: ModelPricing) => {
        acc[m.modelId] = { inputPer1k: m.inputPer1k, outputPer1k: m.outputPer1k };
        return acc;
      },
      {} as Record<string, { inputPer1k: number; outputPer1k: number }>,
    );
  } catch {
    return {};
  }
};
