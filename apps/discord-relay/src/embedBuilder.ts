import { EmbedBuilder, Colors } from "discord.js";
import type { HarnessUsageStats } from "./harnesses/base.js";
import type { MemoryFact, ChannelSettings } from "./types.js";

// ── Info Embeds ───────────────────────────────────────────────────────

export function buildSessionEmbed(
  harnessName: string,
  sessionId: string | null,
  settings: ChannelSettings,
  isGemini: boolean,
  isOpenCode: boolean,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`Session Info`)
    .setColor(Colors.Blue)
    .setFooter({ text: harnessName })
    .setTimestamp();

  if (isGemini) {
    embed.addFields({ name: "Session", value: "_stateless (no persistence)_", inline: true });
  } else {
    embed.addFields({
      name: "Session",
      value: sessionId ? `\`${sessionId.substring(0, 16)}...\`` : "none",
      inline: true,
    });
  }

  if (settings.model) {
    embed.addFields({ name: "Model", value: `\`${settings.model}\``, inline: true });
  }
  if (settings.effort) {
    embed.addFields({ name: "Effort", value: `\`${settings.effort}\``, inline: true });
  }
  if (settings.agent) {
    embed.addFields({ name: "Agent", value: `\`${settings.agent}\``, inline: true });
  }
  if (settings.maxBudget) {
    embed.addFields({ name: "Budget", value: `$${settings.maxBudget}`, inline: true });
  }
  if (settings.systemPrompt) {
    embed.addFields({
      name: "System Prompt",
      value: `\`${settings.systemPrompt.substring(0, 80)}...\``,
    });
  }
  if (settings.addDirs?.length) {
    const label = isOpenCode ? "Working Dir" : isGemini ? "Include Dirs" : "Extra Dirs";
    embed.addFields({
      name: label,
      value: settings.addDirs.map((d) => `\`${d}\``).join("\n"),
    });
  }

  return embed;
}

export function buildUsageEmbed(
  usage: HarnessUsageStats,
  harnessName: string,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle("Session Usage")
    .setColor(Colors.Blue)
    .setFooter({ text: harnessName })
    .setTimestamp();

  if (usage.totalCalls === 0) {
    embed.setDescription("No usage recorded yet this session.");
    return embed;
  }

  embed.addFields(
    { name: "Total Cost", value: `**$${usage.totalCostUsd.toFixed(4)}**`, inline: true },
    { name: "Calls", value: `${usage.totalCalls}`, inline: true },
    { name: "Turns", value: `${usage.totalTurns}`, inline: true },
    { name: "Last Call", value: `$${usage.lastCallCostUsd.toFixed(4)}`, inline: true },
  );

  const models = Object.entries(usage.byModel);
  if (models.length > 0) {
    const modelLines = models
      .map(([model, info]) => `\`${model}\`: ${info.calls} calls, $${info.costUsd.toFixed(4)}`)
      .join("\n");
    embed.addFields({ name: "By Model", value: modelLines });
  }

  return embed;
}

export function buildMemoryEmbed(facts: MemoryFact[]): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle("Stored Memories")
    .setColor(Colors.Gold)
    .setTimestamp();

  if (facts.length === 0) {
    embed.setDescription("No memories stored yet. I'll remember things as we chat.");
    return embed;
  }

  const memFacts = facts.filter((f) => f.type === "fact");
  const memGoals = facts.filter((f) => f.type === "goal");

  if (memFacts.length > 0) {
    const factLines = memFacts.map((f) => `- ${f.content}`).join("\n");
    embed.addFields({
      name: `Facts (${memFacts.length})`,
      value: factLines.substring(0, 1024),
    });
  }

  if (memGoals.length > 0) {
    const goalLines = memGoals
      .map((g) => {
        const dl = g.deadline ? ` (by ${g.deadline})` : "";
        return `- ${g.content}${dl}`;
      })
      .join("\n");
    embed.addFields({
      name: `Goals (${memGoals.length})`,
      value: goalLines.substring(0, 1024),
    });
  }

  embed.setFooter({ text: `${facts.length} total items | Edit _system/MEMORY.md to manage` });

  return embed;
}

// ── Status Embed ──────────────────────────────────────────────────────

import type { SystemStatus as SystemStatusData } from "./vaultApi.js";

function formatTimeAgo(isoString: string | null): string {
  if (!isoString) return "never";
  const ms = Date.now() - new Date(isoString).getTime();
  if (ms < 0) return "just now";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

export function buildStatusEmbed(status: SystemStatusData): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle("System Status")
    .setColor(Colors.Green)
    .setTimestamp();

  // Daemon
  if (status.daemon) {
    const uptime = status.daemon.startedAt
      ? formatTimeAgo(status.daemon.startedAt).replace(" ago", "")
      : "unknown";
    const keys = status.daemon.apiKeys;
    const pidStr = status.daemon.pid ? `PID ${status.daemon.pid}, ` : "";
    embed.addFields({
      name: "Daemon",
      value: `Running (${pidStr}uptime ${uptime})\nAPI Keys: OpenRouter=${keys["openrouter"] ? "set" : "**MISSING**"}, Brave=${keys["brave"] ? "set" : "no"}, Gemini=${keys["gemini"] ? "set" : "no"}`,
    });
  } else {
    embed.addFields({ name: "Daemon", value: "Not running" });
    embed.setColor(Colors.Red);
  }

  // Heartbeat
  embed.addFields({
    name: "Heartbeat",
    value: `Last processed ${formatTimeAgo(status.heartbeat.lastProcessed)}`,
    inline: true,
  });

  // Workers
  if (status.workers.length > 0) {
    const workerLines = status.workers
      .map((w) => `\`${w.workerId}\`: ${w.status} (${formatTimeAgo(w.lastHeartbeat)})`)
      .join("\n");
    embed.addFields({ name: "Workers", value: workerLines });
  }

  // Relays
  if (status.relays.length > 0) {
    const relayLines = status.relays
      .map((r) => `${r.displayName}: ${r.status} (${formatTimeAgo(r.lastHeartbeat)}) | ${r.tasksCompleted} done, ${r.tasksFailed} failed`)
      .join("\n");
    embed.addFields({ name: "Relay Bots", value: relayLines });
  }

  // Workflows
  if (status.workflows) {
    const wfLines = Object.entries(status.workflows)
      .map(([name, wf]) => `${wf.success ? "OK" : "FAIL"} ${name} (${formatTimeAgo(wf.lastRun ?? null)})`)
      .join("\n");
    if (wfLines) embed.addFields({ name: "Scheduled Workflows", value: wfLines });
  }

  return embed;
}

// ── Help Embeds ───────────────────────────────────────────────────────

export function buildHelpEmbed(harnessName: string): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`Discord Relay Commands`)
    .setColor(Colors.Blue)
    .setFooter({ text: `${harnessName} | Use / or ! prefix` })
    .setTimestamp();

  if (harnessName === "OpenCode") {
    embed.addFields(
      { name: "Session", value: "`/reset` `/kill` `/session` `!continue`" },
      { name: "Models", value: "`/model <name>` `!opus` `!sonnet` `!haiku`" },
      { name: "Tuning", value: "`/effort` `!agent <name>` `/adddir <path>` `!rmdir`" },
      { name: "Info", value: "`/usage` `/memory` `/status` `/help`" },
      { name: "Settings", value: "`/clear` — Reset all to defaults" },
    );
  } else if (harnessName === "Gemini CLI") {
    embed.addFields(
      { name: "Session", value: "`/reset` `/kill` `/session`" },
      { name: "Models", value: "`/model <name>` `!pro` `!flash`" },
      { name: "Context", value: "`/adddir <path>` `!rmdir`" },
      { name: "Plugins", value: "`!plugins` `!plugin add/remove/clear`" },
      { name: "Info", value: "`/usage` `/memory` `/status` `/help` `!workspace`" },
    );
    embed.setDescription("Google Workspace specialist — Docs, Sheets, Drive, Gmail, Calendar");
  } else {
    embed.addFields(
      { name: "Session", value: "`/reset` `/kill` `/session` `!continue`" },
      { name: "Models", value: "`/model <name>` `!opus` `!sonnet` `!haiku`" },
      { name: "Tuning", value: "`/effort` `/budget <$>` `!sp <prompt>` `/adddir`" },
      { name: "Info", value: "`/usage` `/memory` `/status` `/help`" },
      { name: "Settings", value: "`/clear` — Reset all to defaults" },
      { name: "Limits", value: "15 turns, $2.00 budget, 5 min timeout per call" },
    );
  }

  return embed;
}

// ── Error Embed ───────────────────────────────────────────────────────

export function buildErrorEmbed(title: string, message: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(message)
    .setColor(Colors.Red)
    .setTimestamp();
}
