/**
 * UnifiedCommandDispatcher — shared command handling for all platform bots.
 *
 * Handles !reset, !model, !harness, !sessions, !export, !search, !memory,
 * !threads, !voice, !media, !format, !help, !status, !continue, !fork,
 * !config relay commands.
 *
 * Platform-specific commands (e.g. Telegram's !poll, !pin, !diagram)
 * should be checked BEFORE calling dispatchCommand and handled in the bridge.
 *
 * Returns true if command was handled, false if unknown (so the bridge can
 * fall back to its platform-specific handler or show an error).
 */

import type { PlatformBridge } from "./platformBridge.js";
import type { RelayClient } from "@repo/agent-relay-protocol";
import type { CmdResultMessage } from "@repo/agent-relay-protocol";
import type { SessionOrchestrator } from "./sessionOrchestrator.js";
import type { ThreadStore } from "./threadStore.js";
import { loadVaultPlatformConfig, type PlatformConfig } from "./platformConfig.js";
import {
  HARNESS_ALIASES,
  harnessLabel,
  type ActiveHarness,
} from "./harnessRouter.js";

// ─── Context passed to the dispatcher ─────────────────────────────

export interface CommandContext {
  bridge: PlatformBridge;
  relay: RelayClient;
  sessionOrchestrator: SessionOrchestrator;
  threadStore: ThreadStore;
  platformConfig: PlatformConfig;
  vaultRoot: string;
  getActiveHarness(): ActiveHarness;
  setActiveHarness(h: ActiveHarness): void;
  getModelOverride(): string | undefined;
  setModelOverride(m: string | undefined): void;
  getThreadId(): string | null;
  setThreadId(id: string | null): void;
  getVoiceReplyEnabled(): boolean;
  setVoiceReplyEnabled(v: boolean): void;
  getMediaAutoProcess(): boolean;
  setMediaAutoProcess(v: boolean): void;
  getFormatEnabled(): boolean;
  setFormatEnabled(v: boolean): void;
  getActiveJobId(): string | null;
  getActiveJobLabel(): string | null;
  /** Harness has voice synth capability. */
  hasVoiceSynth(): boolean;
  /** Harness has voice transcription. */
  hasVoiceTranscribe(): boolean;
  /** MediaHandler can describe images. */
  hasVision(): boolean;
  /** Save harness state to disk. */
  saveState(): void;
}

// ─── Relay command execution ───────────────────────────────────────

async function execRelayCommand(
  bridge: PlatformBridge,
  relay: RelayClient,
  command: string,
  args: Record<string, unknown>,
  sendChunked: (text: string) => Promise<void>,
): Promise<void> {
  try {
    const result = await new Promise<string>((resolve, reject) => {
      const requestId = `cmd-${Date.now()}`;
      const unsub = relay.on<CmdResultMessage>("cmd:result", (msg) => {
        if (msg.requestId === requestId) {
          unsub();
          if (msg.success) resolve(msg.output ?? "Done.");
          else reject(new Error(msg.error ?? "Command failed"));
        }
      });
      relay.send({ type: "cmd:execute", command, args, requestId });
      setTimeout(() => { unsub(); reject(new Error("Command timeout")); }, 10_000);
    });
    await sendChunked(result);
  } catch (err) {
    await bridge.sendText(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Main dispatcher ───────────────────────────────────────────────

/**
 * Dispatch a bang command (e.g. "!reset", "!harness claude").
 *
 * @param raw        the command string including the leading "!"
 * @param ctx        mutable bot context
 * @param sendChunked  function to send (possibly long) text to the user
 * @returns true if handled, false if unknown command
 */
export async function dispatchCommand(
  raw: string,
  ctx: CommandContext,
  sendChunked: (text: string) => Promise<void>,
): Promise<boolean> {
  const parts = raw.slice(1).split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const argStr = parts.slice(1).join(" ").trim();

  switch (cmd) {
    // ── Session reset ──────────────────────────────────────────
    case "reset":
    case "new": {
      ctx.setThreadId(null);
      ctx.setModelOverride(undefined);
      const h = ctx.getActiveHarness();
      if (h !== "auto") {
        ctx.sessionOrchestrator.getActiveSessions(); // no-op but validates orchestrator
      }
      await bridge_send(ctx.bridge, `Session reset.\n\n_Active harness: ${harnessLabel(h)}_`);
      return true;
    }

    // ── Model override ─────────────────────────────────────────
    case "model":
      if (argStr) {
        ctx.setModelOverride(argStr);
        await bridge_send(ctx.bridge, `Model set to: \`${argStr}\``);
        return true;
      }
      await execRelayCommand(ctx.bridge, ctx.relay, "model", {}, sendChunked);
      return true;

    case "opus":
      ctx.setModelOverride("claude-opus-4-6");
      await bridge_send(ctx.bridge, "Model set to: `claude-opus-4-6`");
      return true;

    case "sonnet":
      ctx.setModelOverride("claude-sonnet-4-6");
      await bridge_send(ctx.bridge, "Model set to: `claude-sonnet-4-6`");
      return true;

    case "haiku":
      ctx.setModelOverride("claude-haiku-4-5-20251001");
      await bridge_send(ctx.bridge, "Model set to: `claude-haiku-4-5-20251001`");
      return true;

    case "gemini":
      ctx.setModelOverride("google/gemini-2.5-flash-preview-05-20");
      await bridge_send(
        ctx.bridge,
        "Switched to Gemini 2.5 Flash (via OpenRouter).\n\n" +
        "_Note: For Google Workspace tasks (Docs, Drive, Gmail, Calendar), " +
        "use the Gemini bot on Discord for full authenticated access._",
      );
      return true;

    // ── Sessions ───────────────────────────────────────────────
    case "sessions": {
      const active = ctx.sessionOrchestrator.getActiveSessions();
      if (active.length === 0) {
        await bridge_send(ctx.bridge, "_No active orchestrated sessions._");
      } else {
        const lines = active.map((s) => {
          const elapsedMin = Math.round((Date.now() - s.startedAt) / 60_000);
          return `• **${s.harness}** [${s.state}] — ${elapsedMin}m — \`${s.id.slice(-8)}\``;
        });
        await bridge_send(ctx.bridge, `**Active sessions:**\n${lines.join("\n")}`);
      }
      return true;
    }

    // ── Export vault file ──────────────────────────────────────
    case "export": {
      if (!argStr) {
        await bridge_send(
          ctx.bridge,
          "Usage: `!export <relative-vault-path>`\n" +
          "Example: `!export Notebooks/Projects/report.md`",
        );
        return true;
      }
      // Delegate to bridge (bridge knows how to send a file)
      // We emit a special marker that the bridge can intercept
      await ctx.bridge.sendFile(Buffer.alloc(0), `__export__:${argStr}`);
      return true;
    }

    // ── Relay commands (delegated to relay server) ─────────────
    case "hq":
    case "status":
    case "diagram": {
      const jobId = ctx.getActiveJobId();
      if (jobId) {
        await bridge_send(
          ctx.bridge,
          `**Active task:** ${ctx.getActiveJobLabel() ?? "task"}\n` +
          `Job ID: \`${jobId.slice(-8)}\`\n` +
          `Status: running — waiting for result`,
        );
        return true;
      }
      await execRelayCommand(ctx.bridge, ctx.relay, "status", {}, sendChunked);
      return true;
    }

    case "memory":
      await execRelayCommand(ctx.bridge, ctx.relay, "memory", {}, sendChunked);
      return true;

    case "threads":
      await execRelayCommand(ctx.bridge, ctx.relay, "threads", {}, sendChunked);
      return true;

    case "search":
      await execRelayCommand(ctx.bridge, ctx.relay, "search", { query: argStr }, sendChunked);
      return true;

    // ── Harness switcher ───────────────────────────────────────
    case "harness":
    case "switch": {
      if (!argStr) {
        // Return false so bridge can show a platform-native picker (e.g. Telegram inline keyboard)
        return false;
      }
      const target = HARNESS_ALIASES[argStr.toLowerCase()];
      if (!target && argStr.toLowerCase() !== "auto") {
        await bridge_send(
          ctx.bridge,
          `Unknown harness: "${argStr}"\n\nAvailable: claude, opencode, gemini, auto`,
        );
        return true;
      }
      const newHarness: ActiveHarness = argStr.toLowerCase() === "auto" ? "auto" : target!;
      ctx.setActiveHarness(newHarness);
      ctx.saveState();
      const desc = newHarness === "auto"
        ? "Intent-based routing restored — workspace tasks → Gemini, coding tasks → Claude Code."
        : `All messages will now route to **${harnessLabel(newHarness)}** until you change it with \`!harness auto\`.`;
      await bridge_send(ctx.bridge, `Switched to **${harnessLabel(newHarness)}**\n\n${desc}`);
      return true;
    }

    // ── Voice settings ─────────────────────────────────────────
    case "voice": {
      if (argStr === "on") {
        if (!ctx.hasVoiceSynth()) {
          await bridge_send(ctx.bridge, "Voice reply not available — set OPENAI_API_KEY in .env.local to enable TTS.");
        } else {
          ctx.setVoiceReplyEnabled(true);
          await bridge_send(ctx.bridge, "Voice reply enabled. I'll respond with voice notes.");
        }
      } else if (argStr === "off") {
        ctx.setVoiceReplyEnabled(false);
        await bridge_send(ctx.bridge, "Voice reply disabled. Back to text mode.");
      } else {
        const status = ctx.getVoiceReplyEnabled() ? "on" : "off";
        const avail = ctx.hasVoiceTranscribe() ? "available" : "not configured (set GROQ_API_KEY)";
        await bridge_send(
          ctx.bridge,
          `**Voice settings**\n\nTranscription: ${avail}\nReply mode: ${status}\n\n` +
          "`!voice on` — respond with voice notes\n`!voice off` — respond with text",
        );
      }
      return true;
    }

    // ── Media settings ─────────────────────────────────────────
    case "media": {
      if (argStr === "on") {
        ctx.setMediaAutoProcess(true);
        await bridge_send(ctx.bridge, "Media auto-processing enabled. Images will be described by AI.");
      } else if (argStr === "off") {
        ctx.setMediaAutoProcess(false);
        await bridge_send(ctx.bridge, "Media auto-processing disabled.");
      } else {
        const status = ctx.getMediaAutoProcess() ? "on" : "off";
        const vision = ctx.hasVision() ? "available" : "not configured";
        await bridge_send(
          ctx.bridge,
          `**Media settings**\n\nAuto-process: ${status}\nAI vision: ${vision}\n\n` +
          "`!media on` — enable AI processing\n`!media off` — disable",
        );
      }
      return true;
    }

    // ── Format settings ────────────────────────────────────────
    case "format": {
      if (argStr === "on") {
        ctx.setFormatEnabled(true);
        await bridge_send(ctx.bridge, "Formatting enabled.");
      } else if (argStr === "off") {
        ctx.setFormatEnabled(false);
        await bridge_send(ctx.bridge, "Formatting disabled. Raw text mode.");
      } else {
        await bridge_send(
          ctx.bridge,
          `**Format settings**\n\nFormatting: ${ctx.getFormatEnabled() ? "on" : "off"}\n\n` +
          "`!format on` — convert markdown\n`!format off` — send raw text",
        );
      }
      return true;
    }

    // ── Cross-platform continuity ──────────────────────────────
    case "continue": {
      if (!argStr) {
        await bridge_send(
          ctx.bridge,
          "Usage: `!continue <threadId>`\n" +
          "Pick up a conversation started on another platform.\n\n" +
          "Use `!threads` to list recent threads with their IDs.",
        );
        return true;
      }
      try {
        const thread = await ctx.threadStore.getThread(argStr);
        if (!thread) {
          await bridge_send(ctx.bridge, `Thread not found: \`${argStr}\``);
          return true;
        }
        ctx.setThreadId(thread.id);
        const harness = thread.activeHarness as ActiveHarness;
        ctx.setActiveHarness(harness);
        ctx.saveState();
        const msgCount = thread.messages.length;
        const origin = thread.originPlatform;
        const context = await ctx.threadStore.getThreadContext(thread.id, 2000);
        const preview = context.length > 300 ? context.slice(-300) + "..." : context;
        await bridge_send(
          ctx.bridge,
          `**Continuing thread** \`${thread.id}\`\n\n` +
          `Origin: ${origin} | Messages: ${msgCount} | Harness: ${harnessLabel(harness)}\n` +
          (thread.title ? `Title: ${thread.title}\n` : "") +
          `\n**Recent context:**\n${preview || "(empty thread)"}`,
        );
      } catch (err) {
        await bridge_send(
          ctx.bridge,
          `Failed to load thread: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return true;
    }

    case "fork": {
      const currentThreadId = ctx.getThreadId();
      if (!currentThreadId) {
        await bridge_send(ctx.bridge, "No active thread to fork. Start a conversation first.");
        return true;
      }
      try {
        const newId = await ctx.threadStore.forkThread(
          currentThreadId,
          ctx.bridge.platformId,
        );
        ctx.setThreadId(newId);
        await bridge_send(
          ctx.bridge,
          `**Thread forked**\n\n` +
          `New thread: \`${newId}\`\n` +
          `Copied from: \`${currentThreadId}\`\n\n` +
          `Use \`!continue ${newId}\` on any other platform to pick up this conversation.`,
        );
      } catch (err) {
        await bridge_send(
          ctx.bridge,
          `Fork failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return true;
    }

    // ── Platform config ─────────────────────────────────────────
    case "config": {
      if (!argStr) {
        const cfg = ctx.platformConfig;
        const timeoutLines = Object.entries(cfg.harnessTimeouts)
          .map(([h, t]) => `  ${h}: ${Math.round(t / 60_000)}m`)
          .join("\n");
        const notif = cfg.notifications;
        await bridge_send(
          ctx.bridge,
          `**Platform Config — ${cfg.platformId}**\n\n` +
          `**Timeouts**\n${timeoutLines}\n  default: ${Math.round(cfg.defaultTimeout / 60_000)}m\n\n` +
          `**Notifications**\n` +
          `  progress interval: ${notif.progressInterval ? `${Math.round(notif.progressInterval / 60_000)}m` : "disabled"}\n` +
          `  typing: ${notif.showTyping ? "on" : "off"} (keepalive: ${notif.typingKeepAliveMs}ms)\n` +
          `  acknowledge receipt: ${notif.acknowledgeReceipt ? "yes" : "no"}\n\n` +
          "Edit `.vault/_system/PLATFORM-CONFIG.md` to customize.\n" +
          "`!config reload` — reload from vault",
        );
        return true;
      }
      if (argStr === "reload") {
        const loaded = loadVaultPlatformConfig(ctx.vaultRoot, ctx.bridge.platformId);
        if (loaded) {
          // Apply loaded overrides to the live config
          Object.assign(ctx.platformConfig.harnessTimeouts, loaded.harnessTimeouts);
          if (loaded.defaultTimeout) ctx.platformConfig.defaultTimeout = loaded.defaultTimeout;
          Object.assign(ctx.platformConfig.notifications, loaded.notifications);
          await bridge_send(ctx.bridge, "Platform config reloaded from vault.");
        } else {
          await bridge_send(ctx.bridge, "No custom config found in vault. Using defaults.");
        }
        return true;
      }
      await bridge_send(ctx.bridge, "Usage: `!config` — show config\n`!config reload` — reload from vault");
      return true;
    }

    // ── Help ───────────────────────────────────────────────────
    case "help":
    case "commands":
      await bridge_send(
        ctx.bridge,
        "**HQ Commands**\n\n" +
        "**Harness**\n" +
        "`!harness` — Show harness picker\n" +
        "`!harness claude` — Pin to Claude Code\n" +
        "`!harness opencode` — Pin to OpenCode\n" +
        "`!harness gemini` — Pin to Gemini CLI\n" +
        "`!harness auto` — Auto-route by intent\n\n" +
        "**Chat**\n" +
        "`!reset` — Start new conversation\n" +
        "`!model <name>` — Set model by ID\n" +
        "`!opus` / `!sonnet` / `!haiku` — Quick Claude switch\n\n" +
        "**Cross-Platform**\n" +
        "`!continue <threadId>` — Pick up a thread from another platform\n" +
        "`!fork` — Fork current conversation for use elsewhere\n" +
        "`!threads` — List conversation threads\n\n" +
        "**HQ**\n" +
        "`!status` — Agent / active task status\n" +
        "`!memory` — Show memory\n" +
        "`!search <query>` — Search vault\n" +
        "`!export <vault-path>` — Send vault file as document\n\n" +
        "**Media**\n" +
        "`!media [on|off]` — Toggle AI media processing\n\n" +
        "**Settings**\n" +
        "`!voice [on|off]` — Toggle voice note replies\n" +
        "`!format [on|off]` — Toggle formatting\n" +
        "`!config` — View/reload platform config\n" +
        "`!sessions` — List active harness sessions\n" +
        "`!help` — This message",
      );
      return true;

    // ── Unknown ────────────────────────────────────────────────
    default:
      return false;
  }
}

/** Small helper to avoid platform HTML/markdown concerns in this module. */
function bridge_send(bridge: PlatformBridge, text: string): Promise<string | null> {
  return bridge.sendText(text);
}
