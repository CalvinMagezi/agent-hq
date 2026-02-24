import type { BaseHarness } from "./harnesses/base.js";
import type { GeminiHarness } from "./harnesses/gemini.js";
import type { ConvexAPI } from "./vaultApi.js";
import type { ChannelSettings, RelayConfig } from "./types.js";

function formatTimeAgo(isoString: string | null): string {
  if (!isoString) return "never";
  const ms = Date.now() - new Date(isoString).getTime();
  if (ms < 0) return "just now";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

/** Model aliases for Claude Code (resolves short names internally) */
const CLAUDE_MODEL_ALIASES: Record<string, string> = {
  opus: "opus",
  sonnet: "sonnet",
  haiku: "haiku",
  "opus-4": "claude-opus-4-6",
  "sonnet-4": "claude-sonnet-4-6",
  "haiku-4": "claude-haiku-4-5-20251001",
};

/** Model aliases for OpenCode (requires provider/model format) */
const OPENCODE_MODEL_ALIASES: Record<string, string> = {
  opus: "anthropic/claude-opus-4-6",
  sonnet: "anthropic/claude-sonnet-4-6",
  haiku: "anthropic/claude-haiku-4-5-20251001",
  "opus-4": "anthropic/claude-opus-4-6",
  "sonnet-4": "anthropic/claude-sonnet-4-6",
  "haiku-4": "anthropic/claude-haiku-4-5-20251001",
  gemini: "google/gemini-2.5-pro",
  "gemini-pro": "google/gemini-2.5-pro",
  "gemini-flash": "google/gemini-2.5-flash",
  gpt4: "openai/gpt-4.1",
  "gpt-4": "openai/gpt-4.1",
};

/** Model aliases for Gemini CLI (native Google model IDs) */
const GEMINI_MODEL_ALIASES: Record<string, string> = {
  pro: "gemini-2.5-pro",
  flash: "gemini-2.5-flash",
  "2.5-pro": "gemini-2.5-pro",
  "2.5-flash": "gemini-2.5-flash",
  "2.0-flash": "gemini-2.0-flash",
  "flash-lite": "gemini-2.5-flash-lite-preview-06-17",
};

function getModelAliases(harnessName: string): Record<string, string> {
  if (harnessName === "OpenCode") return OPENCODE_MODEL_ALIASES;
  if (harnessName === "Gemini CLI") return GEMINI_MODEL_ALIASES;
  return CLAUDE_MODEL_ALIASES;
}

export interface CommandResult {
  handled: boolean;
  response?: string;
  file?: { name: string; buffer: Buffer };
}

/**
 * Parse and handle commands from Discord messages.
 * Commands use ! prefix (e.g., !reset, !model opus) to avoid
 * conflict with Discord's native slash commands.
 *
 * Returns { handled: true, response } if the message was a command,
 * or { handled: false } if it should be passed to the harness.
 */
export async function handleCommand(
  content: string,
  channelId: string,
  harness: BaseHarness,
  config: RelayConfig,
  convex?: ConvexAPI,
): Promise<CommandResult> {
  const trimmed = content.trim();

  // Commands start with !
  if (!trimmed.startsWith("!")) {
    return { handled: false };
  }

  const parts = trimmed.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg = parts.slice(1).join(" ").trim();
  const isOpenCode = harness.harnessName === "OpenCode";
  const isGemini = harness.harnessName === "Gemini CLI";
  const isClaude = !isOpenCode && !isGemini;

  switch (cmd) {
    // ── Session Commands ──────────────────────────────────────────

    case "!reset":
    case "!new": {
      harness.kill(channelId); // Kill any running process first
      await harness.resetSession(channelId);
      await harness.clearChannelSettings(channelId);
      return {
        handled: true,
        response: "Session and settings reset. Fresh start.",
      };
    }

    case "!kill":
    case "!abort":
    case "!cancel": {
      const killed = harness.kill(channelId);
      return {
        handled: true,
        response: killed
          ? "Killed the running process. You can send a new message."
          : "No active process to kill in this channel.",
      };
    }

    case "!session": {
      const session = harness.getSession(channelId);
      const settings = harness.getChannelSettings(channelId);
      const lines = [`**Session Info** (${harness.harnessName})`];
      if (isGemini) {
        lines.push("Session: _stateless (no session persistence)_");
      } else {
        lines.push(
          session.sessionId
            ? `Session: \`${session.sessionId}\``
            : "Session: none",
        );
      }
      if (settings.model) lines.push(`Model: \`${settings.model}\``);
      if (settings.effort) lines.push(`Effort: \`${settings.effort}\``);
      if (settings.agent) lines.push(`Agent: \`${settings.agent}\``);
      if (settings.systemPrompt)
        lines.push(
          `System prompt: \`${settings.systemPrompt.substring(0, 80)}...\``,
        );
      if (settings.maxBudget) lines.push(`Budget: $${settings.maxBudget}`);
      if (settings.addDirs?.length)
        lines.push(
          isOpenCode
            ? `Working dir: ${settings.addDirs[0]}`
            : isGemini
              ? `Include dirs: ${settings.addDirs.join(", ")}`
              : `Extra dirs: ${settings.addDirs.join(", ")}`,
        );
      return { handled: true, response: lines.join("\n") };
    }

    case "!continue":
    case "!c": {
      if (isGemini) {
        return {
          handled: true,
          response: "Gemini CLI is stateless — there are no sessions to continue. Just send a new message.",
        };
      }
      // Special case — pass through with continue flag
      return { handled: false };
    }

    // ── Model Commands ────────────────────────────────────────────

    case "!model": {
      const aliases = getModelAliases(harness.harnessName);
      if (!arg) {
        const current = harness.getChannelSettings(channelId).model;
        const aliasNames = Object.keys(aliases).join(", ");
        return {
          handled: true,
          response: current
            ? `Current model: \`${current}\`\nSwitch with: \`!model <name>\`\nAliases: ${aliasNames}`
            : `Using default model.\nSwitch with: \`!model <name>\`\nAliases: ${aliasNames}`,
        };
      }
      const model = aliases[arg.toLowerCase()] || arg;
      await harness.setChannelSettings(channelId, { model });
      return {
        handled: true,
        response: `Model set to \`${model}\`. All messages in this channel will use it.`,
      };
    }

    case "!opus": {
      const aliases = getModelAliases(harness.harnessName);
      const model = aliases["opus"] || "opus";
      await harness.setChannelSettings(channelId, { model });
      return {
        handled: true,
        response: `Switched to **Opus** (most capable). Model: \`${model}\``,
      };
    }

    case "!sonnet": {
      const aliases = getModelAliases(harness.harnessName);
      const model = aliases["sonnet"] || "sonnet";
      await harness.setChannelSettings(channelId, { model });
      return {
        handled: true,
        response: `Switched to **Sonnet** (balanced). Model: \`${model}\``,
      };
    }

    case "!haiku": {
      const aliases = getModelAliases(harness.harnessName);
      const model = aliases["haiku"] || "haiku";
      await harness.setChannelSettings(channelId, { model });
      return {
        handled: true,
        response: `Switched to **Haiku** (fastest). Model: \`${model}\``,
      };
    }

    case "!pro": {
      if (!isGemini) {
        return {
          handled: true,
          response: "The `!pro` shortcut is for Gemini CLI. Use `!opus` for most capable, or `!model gemini-pro` on OpenCode.",
        };
      }
      const model = GEMINI_MODEL_ALIASES["pro"];
      await harness.setChannelSettings(channelId, { model });
      return {
        handled: true,
        response: `Switched to **Gemini Pro** (most capable). Model: \`${model}\``,
      };
    }

    case "!flash": {
      if (!isGemini) {
        return {
          handled: true,
          response: "The `!flash` shortcut is for Gemini CLI. Use `!haiku` for fastest, or `!model gemini-flash` on OpenCode.",
        };
      }
      const model = GEMINI_MODEL_ALIASES["flash"];
      await harness.setChannelSettings(channelId, { model });
      return {
        handled: true,
        response: `Switched to **Gemini Flash** (fastest). Model: \`${model}\``,
      };
    }

    // ── Effort Commands ───────────────────────────────────────────

    case "!effort": {
      if (isGemini) {
        return {
          handled: true,
          response: "Effort/variant control is not supported by Gemini CLI. This command works with Claude Code and OpenCode.",
        };
      }
      const level = arg.toLowerCase();
      if (level === "low" || level === "medium" || level === "high") {
        await harness.setChannelSettings(channelId, { effort: level });
        const flagNote = isOpenCode ? " (--variant)" : " (--effort)";
        return { handled: true, response: `Effort set to **${level}**${flagNote}.` };
      }
      const current = harness.getChannelSettings(channelId).effort;
      return {
        handled: true,
        response: `Current effort: ${current || "default"}\nUsage: \`!effort low|medium|high\``,
      };
    }

    // ── Budget Commands ───────────────────────────────────────────

    case "!budget": {
      if (!isClaude) {
        return {
          handled: true,
          response: `Budget limits are not supported by ${harness.harnessName}. This command is Claude Code only.`,
        };
      }

      const amount = parseFloat(arg);
      if (!isNaN(amount) && amount > 0) {
        await harness.setChannelSettings(channelId, { maxBudget: amount });
        return {
          handled: true,
          response: `Max budget set to **$${amount}** per call.`,
        };
      }
      if (arg === "off" || arg === "none" || arg === "clear") {
        await harness.setChannelSettings(channelId, {
          maxBudget: undefined,
        });
        return { handled: true, response: "Budget limit removed." };
      }
      return {
        handled: true,
        response:
          "Usage: `!budget <amount>` (e.g., `!budget 0.50`) or `!budget off`",
      };
    }

    // ── Directory Access ──────────────────────────────────────────

    case "!adddir":
    case "!dir": {
      if (!arg) {
        const dirs = harness.getChannelSettings(channelId).addDirs;
        if (isOpenCode) {
          return {
            handled: true,
            response: dirs?.length
              ? `Working directory: \`${dirs[0]}\``
              : "No custom working directory. Usage: `!dir /path/to/dir`",
          };
        }
        const label = isGemini ? "Include directories" : "Extra directories";
        const cmd = isGemini ? "!adddir" : "!adddir";
        return {
          handled: true,
          response: dirs?.length
            ? `${label}:\n${dirs.map((d) => `- \`${d}\``).join("\n")}`
            : `No extra directories. Usage: \`${cmd} /path/to/dir\``,
        };
      }

      if (isOpenCode) {
        // OpenCode --dir replaces working directory (single value)
        await harness.setChannelSettings(channelId, { addDirs: [arg] });
        return {
          handled: true,
          response: `Working directory set to: \`${arg}\``,
        };
      }

      // Claude Code --add-dir and Gemini --include-directories both append
      const current = harness.getChannelSettings(channelId).addDirs || [];
      await harness.setChannelSettings(channelId, {
        addDirs: [...current, arg],
      });
      return {
        handled: true,
        response: `Added directory: \`${arg}\`${isGemini ? " (--include-directories)" : ""}`,
      };
    }

    case "!rmdir": {
      const dirs = harness.getChannelSettings(channelId).addDirs || [];
      if (!arg) {
        if (dirs.length === 0) {
          return { handled: true, response: "No directories to remove." };
        }
        return {
          handled: true,
          response: `Which directory to remove? Usage: \`!rmdir <path>\` or \`!rmdir all\`\nCurrent:\n${dirs.map((d, i) => `${i + 1}. \`${d}\``).join("\n")}`,
        };
      }

      if (arg === "all" || arg === "clear") {
        await harness.setChannelSettings(channelId, { addDirs: [] });
        return {
          handled: true,
          response: `Removed all ${dirs.length} director${dirs.length === 1 ? "y" : "ies"}.`,
        };
      }

      // Match by exact path or by index number
      let removed: string | undefined;
      const idx = parseInt(arg, 10);
      if (!isNaN(idx) && idx >= 1 && idx <= dirs.length) {
        removed = dirs[idx - 1];
        dirs.splice(idx - 1, 1);
      } else {
        const i = dirs.findIndex((d) => d === arg || d.endsWith(arg));
        if (i !== -1) {
          removed = dirs[i];
          dirs.splice(i, 1);
        }
      }

      if (!removed) {
        return {
          handled: true,
          response: `Directory not found: \`${arg}\`\nCurrent:\n${dirs.map((d, i) => `${i + 1}. \`${d}\``).join("\n")}`,
        };
      }

      await harness.setChannelSettings(channelId, { addDirs: dirs });
      const remaining = dirs.length > 0
        ? `\nRemaining:\n${dirs.map((d, i) => `${i + 1}. \`${d}\``).join("\n")}`
        : "";
      return {
        handled: true,
        response: `Removed: \`${removed}\`${remaining}`,
      };
    }

    // ── System Prompt ─────────────────────────────────────────────

    case "!systemprompt":
    case "!sp": {
      if (!isClaude) {
        return {
          handled: true,
          response: `Custom system prompts are not supported by ${harness.harnessName}. This command is Claude Code only.`,
        };
      }

      if (!arg) {
        const current = harness.getChannelSettings(channelId).systemPrompt;
        return {
          handled: true,
          response: current
            ? `System prompt: \`${current}\``
            : "No custom system prompt. Usage: `!sp <prompt>` or `!sp clear`",
        };
      }
      if (arg === "clear" || arg === "off" || arg === "none") {
        await harness.setChannelSettings(channelId, {
          systemPrompt: undefined,
        });
        return { handled: true, response: "Custom system prompt cleared." };
      }
      await harness.setChannelSettings(channelId, { systemPrompt: arg });
      return {
        handled: true,
        response:
          "System prompt set. Will be appended to all messages in this channel.",
      };
    }

    // ── Agent Selection (OpenCode only) ─────────────────────────

    case "!agent": {
      if (!isOpenCode) {
        return {
          handled: true,
          response: "Agent selection is only available for OpenCode. This command is OpenCode only.",
        };
      }

      if (!arg) {
        const current = harness.getChannelSettings(channelId).agent;
        return {
          handled: true,
          response: current
            ? `Current agent: \`${current}\``
            : "Using default agent. Usage: `!agent <name>` or `!agent clear`",
        };
      }
      if (arg === "clear" || arg === "off" || arg === "none" || arg === "default") {
        await harness.setChannelSettings(channelId, { agent: undefined });
        return { handled: true, response: "Agent reset to default." };
      }
      await harness.setChannelSettings(channelId, { agent: arg });
      return {
        handled: true,
        response: `Agent set to \`${arg}\`.`,
      };
    }

    // ── Gemini CLI Plugin / MCP Server Management ─────────────────

    case "!plugins": {
      if (!isGemini) {
        return { handled: true, response: "Plugin management is only available for Gemini CLI." };
      }
      const geminiHarness = harness as unknown as GeminiHarness;
      const plugins = geminiHarness.getPlugins();
      const names = Object.keys(plugins);
      if (names.length === 0) {
        return {
          handled: true,
          response: "No MCP server plugins configured.\nUse `!plugin add <name> <command> [args...]` to add one.\nExample: `!plugin add obsidian npx -y @mauricio.wolff/mcp-obsidian /path/to/vault`",
        };
      }
      const lines = [`**Configured MCP Server Plugins** (${names.length})`];
      for (const [name, cfg] of Object.entries(plugins)) {
        const desc = cfg.description ? ` — ${cfg.description}` : "";
        const cmd = cfg.command
          ? `\`${cfg.command} ${(cfg.args || []).join(" ")}\``
          : cfg.httpUrl
            ? `HTTP: \`${cfg.httpUrl}\``
            : cfg.url
              ? `SSE: \`${cfg.url}\``
              : "_no command_";
        lines.push(`**${name}**${desc}: ${cmd}${cfg.trust ? " _(trusted)_" : ""}`);
      }
      lines.push("\nUse `!plugin remove <name>` to remove a plugin.");
      return { handled: true, response: lines.join("\n") };
    }

    case "!plugin": {
      if (!isGemini) {
        return { handled: true, response: "Plugin management is only available for Gemini CLI." };
      }
      const geminiHarness = harness as unknown as GeminiHarness;
      const pluginParts = arg.split(/\s+/);
      const subCmd = pluginParts[0]?.toLowerCase();

      if (!subCmd || subCmd === "list") {
        // Delegate to !plugins handler
        const plugins = geminiHarness.getPlugins();
        const names = Object.keys(plugins);
        if (names.length === 0) {
          return {
            handled: true,
            response: "No MCP plugins configured. Usage:\n`!plugin add <name> <command> [args...]`\n`!plugin add <name> --url <sseUrl>`\n`!plugin add <name> --http <httpUrl>`",
          };
        }
        const lines = names.map((n) => {
          const cfg = plugins[n];
          return `- **${n}**: ${cfg.command ? `${cfg.command} ${(cfg.args || []).join(" ")}` : cfg.httpUrl || cfg.url || "?"}`;
        });
        return { handled: true, response: `**MCP Plugins:**\n${lines.join("\n")}` };
      }

      if (subCmd === "add") {
        const name = pluginParts[1];
        if (!name) {
          return {
            handled: true,
            response: "Usage: `!plugin add <name> <command> [args...]`\nExamples:\n- `!plugin add obsidian npx -y @mauricio.wolff/mcp-obsidian /vault/path`\n- `!plugin add workspace --http https://workspace.example.com/mcp`",
          };
        }
        const rest = pluginParts.slice(2);

        let mcpConfig: import("./harnesses/gemini.js").GeminiMcpServer;
        if (rest[0] === "--http" || rest[0] === "--httpUrl") {
          mcpConfig = { httpUrl: rest[1], trust: true };
        } else if (rest[0] === "--url" || rest[0] === "--sse") {
          mcpConfig = { url: rest[1], trust: true };
        } else if (rest.length > 0) {
          mcpConfig = { command: rest[0], args: rest.slice(1), trust: true };
        } else {
          return { handled: true, response: `Usage: \`!plugin add ${name} <command> [args...]\`` };
        }

        await geminiHarness.addPlugin(name, mcpConfig);
        const cmdStr = mcpConfig.command
          ? `\`${mcpConfig.command} ${(mcpConfig.args || []).join(" ")}\``
          : mcpConfig.httpUrl
            ? `HTTP \`${mcpConfig.httpUrl}\``
            : `SSE \`${mcpConfig.url}\``;
        return {
          handled: true,
          response: `Added MCP plugin **${name}**: ${cmdStr}\nGemini CLI will load it on the next call (trusted, auto-approved via --yolo).`,
        };
      }

      if (subCmd === "remove" || subCmd === "rm" || subCmd === "delete") {
        const name = pluginParts[1];
        if (!name) {
          return { handled: true, response: "Usage: `!plugin remove <name>`" };
        }
        const removed = await geminiHarness.removePlugin(name);
        return {
          handled: true,
          response: removed ? `Removed MCP plugin **${name}**.` : `Plugin **${name}** not found.`,
        };
      }

      if (subCmd === "clear" || subCmd === "reset") {
        await geminiHarness.clearPlugins();
        return { handled: true, response: "All MCP plugins cleared." };
      }

      return {
        handled: true,
        response: "Unknown subcommand. Available: `!plugin add`, `!plugin remove`, `!plugin list`, `!plugin clear`",
      };
    }

    // ── HQ Management ─────────────────────────────────────────────

    case "!hq": {
      const sub = arg.toLowerCase();

      if (sub === "status") {
        if (!convex) {
          return { handled: true, response: "Vault connection not available." };
        }
        try {
          const status = await convex.getSystemStatus();
          const lines: string[] = ["**System Status**", ""];

          // Daemon
          if (status.daemon) {
            const uptime = status.daemon.startedAt
              ? formatTimeAgo(status.daemon.startedAt).replace(" ago", "")
              : "unknown";
            lines.push(`**Daemon:** Running (PID ${status.daemon.pid}, uptime ${uptime})`);
            const keys = status.daemon.apiKeys;
            lines.push(`**API Keys:** OpenRouter=${keys.openrouter ? "set" : "MISSING"}, Brave=${keys.brave ? "set" : "no"}, Gemini=${keys.gemini ? "set" : "no"}`);
          } else {
            lines.push("**Daemon:** Not running (no status file)");
          }

          // Heartbeat
          lines.push(`**Heartbeat:** Last processed ${formatTimeAgo(status.heartbeat.lastProcessed)}`);

          // Workers
          if (status.workers.length > 0) {
            lines.push("", "**Workers:**");
            for (const w of status.workers) {
              lines.push(`- \`${w.workerId}\`: ${w.status} (${formatTimeAgo(w.lastHeartbeat)})`);
            }
          }

          // Relays
          if (status.relays.length > 0) {
            lines.push("", "**Relay Bots:**");
            for (const r of status.relays) {
              lines.push(`- ${r.displayName}: ${r.status} (${formatTimeAgo(r.lastHeartbeat)}) — ${r.tasksCompleted} completed, ${r.tasksFailed} failed`);
            }
          }

          // Workflows
          if (status.workflows) {
            lines.push("", "**Scheduled Workflows:**");
            for (const [name, wf] of Object.entries(status.workflows)) {
              const icon = wf.success ? "OK" : "FAILED";
              lines.push(`- ${name}: ${icon} (${formatTimeAgo(wf.lastRun)})`);
            }
          }

          return { handled: true, response: lines.join("\n") };
        } catch (err) {
          return { handled: true, response: `Error reading status: ${err}` };
        }
      }

      return {
        handled: true,
        response: [
          "**HQ Commands** (local vault mode)",
          "`!hq status` — Live system health dashboard",
          "`bun run status` — CLI status checker",
          "`bun run agent` — Start HQ agent (job processing)",
          "`bun run daemon` — Start background workflows",
          "`bun run chat` — Terminal chat interface",
        ].join("\n"),
      };
    }

    // ── Usage ───────────────────────────────────────────────────────

    case "!usage":
    case "!cost": {
      const usage = harness.getUsage();
      if (usage.totalCalls === 0) {
        return {
          handled: true,
          response: "No usage recorded yet this session.",
        };
      }

      const lines = [
        `**Session Usage** (${harness.harnessName})`,
        `Total cost: **$${usage.totalCostUsd.toFixed(4)}**`,
        `Total calls: **${usage.totalCalls}** (${usage.totalTurns} turns)`,
        `Last call: $${usage.lastCallCostUsd.toFixed(4)}`,
      ];

      const models = Object.entries(usage.byModel);
      if (models.length > 0) {
        lines.push("\n**By Model:**");
        for (const [model, info] of models) {
          lines.push(
            `- \`${model}\`: ${info.calls} calls, $${info.costUsd.toFixed(4)}`,
          );
        }
      }

      if (arg === "reset") {
        await harness.resetUsage();
        lines.push("\n_Usage counters reset._");
      }

      return { handled: true, response: lines.join("\n") };
    }

    // ── Memory ──────────────────────────────────────────────────────

    case "!memory": {
      if (!convex) {
        return { handled: true, response: "Memory system not available." };
      }

      if (arg === "clear") {
        // Not implemented at HTTP level yet — inform user
        return {
          handled: true,
          response:
            "To clear memories, edit `_system/MEMORY.md` in your Obsidian vault.",
        };
      }

      // Show current memory
      const facts = await convex.getMemoryFacts();
      if (facts.length === 0) {
        return {
          handled: true,
          response: "No memories stored yet. I'll remember things as we chat.",
        };
      }

      const memFacts = facts.filter((f) => f.type === "fact");
      const memGoals = facts.filter((f) => f.type === "goal");
      const lines: string[] = ["**Stored Memories**"];

      if (memFacts.length > 0) {
        lines.push("\n**Facts:**");
        memFacts.forEach((f) => lines.push(`- ${f.content}`));
      }
      if (memGoals.length > 0) {
        lines.push("\n**Goals:**");
        memGoals.forEach((g) => {
          const dl = g.deadline ? ` (by ${g.deadline})` : "";
          lines.push(`- ${g.content}${dl}`);
        });
      }

      lines.push(
        `\n_${facts.length} total items. Edit \`_system/MEMORY.md\` in Obsidian to manage._`,
      );
      return { handled: true, response: lines.join("\n") };
    }

    // ── Settings ──────────────────────────────────────────────────

    case "!defaults":
    case "!clear": {
      await harness.clearChannelSettings(channelId);
      return {
        handled: true,
        response: "All channel settings cleared. Using defaults.",
      };
    }

    // ── Help ──────────────────────────────────────────────────────

    case "!help":
    case "!commands": {
      if (isOpenCode) {
        return {
          handled: true,
          response: [
            "**Discord Relay Commands** (OpenCode)",
            "",
            "**Session**",
            "`!reset` — New session + clear settings (kills running process)",
            "`!kill` — Force-stop the running process",
            "`!session` — Show current session & settings",
            "`!continue <msg>` — Continue most recent session",
            "",
            "**Models**",
            "`!model <name>` — Set model (opus, sonnet, haiku, gemini, or provider/model ID)",
            "`!opus` `!sonnet` `!haiku` — Quick model switch",
            "",
            "**Tuning**",
            "`!effort low|medium|high` — Set reasoning variant",
            "`!agent <name>` — Select an OpenCode agent",
            "`!dir <path>` — Set working directory",
            "`!rmdir <path|#|all>` — Remove a directory by path, number, or all",
            "`!clear` — Reset all settings to defaults",
            "",
            "**HQ**",
            "`!hq` — Show HQ commands (local vault mode)",
            "`!hq status` — Check HQ status",
            "",
            "**Memory & Usage**",
            "`!memory` — View stored facts and goals",
            "`!usage` — View session cost and turn usage",
            "`!usage reset` — Reset usage counters",
            "",
            "**Limits**",
            "5 min timeout per call. No budget/system prompt controls (use `!agent` instead).",
            "",
            "**Tips**",
            "Any non-command message is sent to OpenCode.",
            "Settings persist per channel until you `!reset` or `!clear`.",
          ].join("\n"),
        };
      }

      if (isGemini) {
        return {
          handled: true,
          response: [
            "**Discord Relay Commands** (Gemini CLI — Google Workspace Specialist)",
            "",
            "**Google Workspace**",
            "`!workspace` / `!ws` — Show Workspace integration info and setup",
            "",
            "**Session**",
            "`!reset` — Clear settings (kills running process)",
            "`!kill` — Force-stop the running process",
            "`!session` — Show current settings",
            "",
            "**Models**",
            "`!model <name>` — Set model (pro, flash, 2.5-pro, 2.5-flash, or full ID)",
            "`!pro` `!flash` — Quick model switch",
            "",
            "**Context**",
            "`!adddir <path>` — Include additional directories (--include-directories)",
            "`!rmdir <path|#|all>` — Remove a directory by path, number, or all",
            "`!clear` — Reset all settings to defaults",
            "",
            "**Plugins (MCP Servers)**",
            "`!plugins` — List configured MCP server plugins",
            "`!plugin add <name> <command> [args...]` — Add stdio MCP server",
            "`!plugin add <name> --http <url>` — Add HTTP MCP server",
            "`!plugin remove <name>` — Remove a plugin",
            "`!plugin clear` — Remove all plugins",
            "",
            "**HQ**",
            "`!hq` — Show HQ commands (local vault mode)",
            "`!hq status` — Check HQ status",
            "",
            "**Memory & Usage**",
            "`!memory` — View stored facts and goals",
            "`!usage` — View session cost and turn usage",
            "`!usage reset` — Reset usage counters",
            "",
            "**Limits**",
            "2 min timeout per call. Runs with `--yolo` (auto-approve tool actions).",
            "",
            "**Note**",
            "Gemini CLI is a **Google Workspace specialist** — it manages Docs, Sheets, Drive, Gmail, Calendar, and Keep.",
            "For coding tasks, use Claude Code or OpenCode instead.",
            "Gemini CLI is stateless — each message is independent. No `!continue`, `!budget`, `!effort`, or `!sp`.",
            "Settings persist per channel until you `!reset` or `!clear`.",
          ].join("\n"),
        };
      }

      return {
        handled: true,
        response: [
          "**Discord Relay Commands** (Claude Code)",
          "",
          "**Session**",
          "`!reset` — New session + clear settings (kills running process)",
          "`!kill` — Force-stop the running process",
          "`!session` — Show current session & settings",
          "`!continue <msg>` — Continue most recent session",
          "",
          "**Models**",
          "`!model <name>` — Set model (opus, sonnet, haiku, or full ID)",
          "`!opus` `!sonnet` `!haiku` — Quick model switch",
          "",
          "**Tuning**",
          "`!effort low|medium|high` — Set reasoning effort",
          "`!budget <$>` — Set max spend per call",
          "`!sp <prompt>` — Append custom system prompt",
          "`!adddir <path>` — Give Claude access to extra dirs",
          "`!rmdir <path|#|all>` — Remove a directory by path, number, or all",
          "`!clear` — Reset all settings to defaults",
          "",
          "**HQ**",
          "`!hq` — Start web UI + Convex backend (clears port 3000)",
          "`!hq status` — Check if HQ is running",
          "`!hq stop` — Stop the web UI",
          "",
          "**Memory & Usage**",
          "`!memory` — View stored facts and goals",
          "`!usage` — View session cost and turn usage",
          "`!usage reset` — Reset usage counters",
          "",
          "**Safety**",
          "Default limits: 15 turns, $2.00 budget, 5 min timeout per call.",
          "Override budget with `!budget <$>`.",
          "",
          "**Tips**",
          "Any non-command message is sent to Claude Code.",
          "Settings persist per channel until you `!reset` or `!clear`.",
        ].join("\n"),
      };
    }

    case "!workspace":
    case "!ws": {
      if (!isGemini) {
        return {
          handled: true,
          response: "The `!workspace` command is only available for the Gemini CLI bot.",
        };
      }
      return {
        handled: true,
        response: [
          "**Google Workspace Integration**",
          "",
          "Gemini CLI has Google Workspace extensions providing access to:",
          "- **Google Docs** — Create, read, edit, summarize documents",
          "- **Google Sheets** — Create spreadsheets, analyze data, formulas",
          "- **Google Drive** — Search, organize, share files",
          "- **Gmail** — Draft emails, search inbox, manage labels",
          "- **Google Calendar** — Create events, check availability",
          "- **Google Keep** — Notes, lists, reminders",
          "- **Google Chat** — Messages and spaces",
          "",
          "**Setup**: Run `bash scripts/setup-gemini-plugins.sh` to authenticate and install extensions.",
          "**Auth**: Run `gemini login` to re-authenticate if needed.",
          "",
          "Ask me anything about your Google Workspace!",
        ].join("\n"),
      };
    }


    default:
      // Unknown !command — don't eat it, pass to harness
      return { handled: false };
  }
}
