/**
 * UnifiedAdapterBot — the central orchestration class for all platforms.
 *
 * Accepts a PlatformBridge and handles all shared logic:
 *   - Message routing (commands → local harness → delegation → chat)
 *   - Deduplication and message queuing
 *   - Typing indicators with keepalive
 *   - CHANNEL-PRESENCE.md update (Touch Points integration)
 *   - Voice transcription + TTS replies
 *   - Media handling (AI vision, document extraction, vault upload)
 *   - Session flush to _agent-sessions/ for conversation-learner
 *   - Vault event processing (task/job lifecycle)
 *
 * Platform-specific commands (e.g. Telegram's !poll, !pin) should be
 * preprocessed by the bridge and handled before onMessage fires, or
 * the bridge can call handleBridgeCommand() to handle them inline.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { RelayClient } from "@repo/agent-relay-protocol";
import type { RelayClientConfig } from "@repo/agent-relay-protocol";
import type { PlatformBridge, UnifiedMessage, PlatformAction } from "./platformBridge.js";
import type { PlatformConfig } from "./platformConfig.js";
import type { VoiceHandler } from "./voice.js";
import type { MediaHandler } from "./media.js";
import { LocalHarness } from "./localHarness.js";
import { SessionOrchestrator } from "./sessionOrchestrator.js";
import { VaultThreadStore } from "./threadStore.js";
import {
  routeMessage,
  harnessLabel,
  HARNESS_ALIASES,
  type ActiveHarness,
} from "./harnessRouter.js";
import { dispatchCommand, type CommandContext } from "./commands.js";
import { handleChat, type ChatContext } from "./chatHandler.js";
import {
  handleDelegation,
  handleVaultEvent,
  type DelegationContext,
  type DelegationState,
} from "./delegation.js";

// ─── Config ───────────────────────────────────────────────────────

export interface UnifiedAdapterBotConfig {
  bridge: PlatformBridge;
  platformConfig: PlatformConfig;
  relay?: {
    host?: string;
    port?: number;
    apiKey?: string;
    debug?: boolean;
  };
  voiceHandler?: VoiceHandler;
  mediaHandler?: MediaHandler;
  mediaAutoProcess?: boolean;
  stateFile?: string;
  vaultRoot?: string;
}

// ─── Bot ──────────────────────────────────────────────────────────

export class UnifiedAdapterBot {
  private bridge: PlatformBridge;
  private config: PlatformConfig;
  private relay: RelayClient;
  private voiceHandler: VoiceHandler | null;
  private mediaHandler: MediaHandler | null;
  private threadStore: VaultThreadStore;

  // Persisted state
  private activeHarness: ActiveHarness = "auto";
  private threadId: string | null = null;
  private modelOverride: string | undefined;
  private voiceReplyEnabled = false;
  private mediaAutoProcess: boolean;
  private formatEnabled = true;
  private stateFile: string;

  // Processing state — per chatId so threads can run in parallel
  private currentChatId: string | null = null;
  private chatThreads = new Map<string, string>(); // chatId -> threadId
  private processingChats = new Map<string, number>(); // chatId -> startedAt timestamp
  private messageQueueByChat = new Map<string, UnifiedMessage[]>(); // chatId -> queued msgs
  private processedIds = new Set<string>();

  // Session management
  private localHarness: LocalHarness;
  private sessionOrchestrator: SessionOrchestrator;

  // Delegation tracking
  private delegationState: DelegationState = {
    activeJobId: null,
    activeJobLabel: null,
    activeJobResultDelivered: false,
    activeTaskIds: new Set(),
    activeJobSourceMsgId: null,
  };

  // Typing keepalive
  private typingInterval: ReturnType<typeof setInterval> | null = null;

  private vaultRoot: string;
  private readonly label: string;

  constructor(config: UnifiedAdapterBotConfig) {
    this.bridge = config.bridge;
    this.config = config.platformConfig;
    this.voiceHandler = config.voiceHandler ?? null;
    this.mediaHandler = config.mediaHandler ?? null;
    this.mediaAutoProcess = config.mediaAutoProcess ?? true;
    this.vaultRoot = config.vaultRoot ?? ".vault";
    this.stateFile = config.stateFile ?? `.${config.platformConfig.platformId}-state.json`;
    this.label = `unified-${config.platformConfig.platformId}`;

    this.loadState();

    const harnessStateFile = `.${config.platformConfig.platformId}-harness-sessions.json`;
    this.localHarness = new LocalHarness(harnessStateFile);
    this.sessionOrchestrator = new SessionOrchestrator(this.localHarness);
    this.threadStore = new VaultThreadStore(this.vaultRoot);

    const relayConfig: RelayClientConfig = {
      host: config.relay?.host,
      port: config.relay?.port,
      apiKey: config.relay?.apiKey ?? "",
      clientId: `${config.platformConfig.platformId}-relay-adapter`,
      clientType: config.platformConfig.platformId,
      autoReconnect: true,
      debug: config.relay?.debug,
    };
    this.relay = new RelayClient(relayConfig);
  }

  // ─── Lifecycle ────────────────────────────────────────────────

  async start(): Promise<void> {
    // Relay connection is optional — local harness works without it
    try {
      console.log(`[${this.label}] Connecting to relay server...`);
      await this.relay.connect();
      console.log(`[${this.label}] Connected to relay server`);

      // Subscribe to vault events for delegation tracking
      this.relay.send({ type: "system:subscribe", events: ["job:*", "task:*"] });
      this.relay.on("system:event", (eventMsg: any) => {
        this.handleVaultEventInternal(eventMsg.event, eventMsg.data).catch(console.error);
      });
    } catch (err) {
      console.warn(
        `[${this.label}] Relay server not available — local harness mode only. ` +
        `Chat relay and delegation disabled until relay is running. ` +
        `(${err instanceof Error ? err.message : String(err)})`,
      );
    }

    // Wire bridge events
    this.bridge.onMessage((msg) => this.handleMessage(msg));
    this.bridge.onAction((action) => this.handleAction(action));

    await this.bridge.start();
    console.log(`[${this.label}] Bridge started — listening for messages`);
  }

  async stop(): Promise<void> {
    this.relay.disconnect();
    if (this.typingInterval) { clearInterval(this.typingInterval); }
    this.mediaHandler?.destroy?.();
    this.localHarness.dispose();
    await this.bridge.stop();
    console.log(`[${this.label}] Bot stopped`);
  }

  // ─── Message Routing ──────────────────────────────────────────

  private async handleMessage(msg: UnifiedMessage): Promise<void> {
    console.log(
      `[${this.label}] handleMessage: id=${msg.id}, content="${msg.content.substring(0, 60)}", ` +
      `media=${msg.mediaType ?? "none"}, voice=${msg.isVoiceNote ?? false}`,
    );

    this.currentChatId = msg.chatId;

    // Apply per-message harness override (e.g. from PWA harness selector)
    if (msg.harnessOverride) {
      // Map PWA-specific IDs to valid harness names
      const aliasMap: Record<string, ActiveHarness> = { "hq-agent": "auto" };
      const resolved = aliasMap[msg.harnessOverride] ?? msg.harnessOverride;
      const valid: ActiveHarness[] = ["auto", "claude-code", "opencode", "gemini-cli", "codex-cli"];
      if (valid.includes(resolved as ActiveHarness)) {
        this.activeHarness = resolved as ActiveHarness;
      }
    }

    // Resolve thread for this chat
    if (!this.chatThreads.has(msg.chatId)) {
      const threads = await this.threadStore.listThreads({ platform: this.config.platformId });
      const existing = threads.find(t => t.id === msg.chatId || t.title === msg.chatId);
      if (existing) {
        this.chatThreads.set(msg.chatId, existing.id);
        this.threadId = existing.id;
      } else {
        // Create new thread for this chat
        const tid = await this.threadStore.createThread({
          platform: this.config.platformId,
          harness: this.activeHarness,
          title: msg.chatId,
        });
        this.chatThreads.set(msg.chatId, tid);
        this.threadId = tid;
      }
    } else {
      this.threadId = this.chatThreads.get(msg.chatId)!;
    }

    // Sync activeHarness from thread store — but only if no per-message override was applied
    if (this.threadId && !msg.harnessOverride) {
      const threadHarness = await this.threadStore.getActiveHarness(this.threadId);
      this.activeHarness = threadHarness as any;
    }

    // Dedup
    if (this.processedIds.has(msg.id)) return;
    this.processedIds.add(msg.id);
    while (this.processedIds.size >= 200) {
      const first = this.processedIds.values().next().value;
      if (first === undefined) break;
      this.processedIds.delete(first);
    }

    // Update CHANNEL-PRESENCE.md (Touch Points integration)
    if (this.config.notifications.acknowledgeReceipt) {
      this.updateChannelPresence();
      this.bridge.sendReaction(msg.id, "👀", msg.chatId).catch(() => {});
    }

    // Voice notes
    if (msg.isVoiceNote) {
      await this.handleVoice(msg);
      await this.processQueue(msg.chatId);
      return;
    }

    // Media — queue if already processing (same guard as text messages below)
    if (msg.mediaType && msg.mediaType !== "audio") {
      if (this.processingChats.has(msg.chatId)) {
        console.log(`[${this.label}] Chat ${msg.chatId} busy — queuing media: ${msg.mediaType}`);
        const q = this.messageQueueByChat.get(msg.chatId) ?? [];
        q.push(msg);
        this.messageQueueByChat.set(msg.chatId, q);
        return;
      }
      await this.handleMedia(msg);
      await this.processQueue(msg.chatId);
      return;
    }

    // Location
    if (msg.location) {
      const { lat, lng } = msg.location;
      await this.routeText(`[Location shared]: ${lat.toFixed(6)}, ${lng.toFixed(6)}`, msg);
      await this.processQueue(msg.chatId);
      return;
    }

    // Contact
    if (msg.contactName || msg.contactPhone) {
      await this.routeText(
        `[Contact shared]: ${msg.contactName ?? "Unknown"} — ${msg.contactPhone ?? ""}`,
        msg,
      );
      await this.processQueue(msg.chatId);
      return;
    }

    // Poll
    if (msg.pollQuestion) {
      await this.routeText(
        `[Poll received]: ${msg.pollQuestion}\nOptions: ${msg.pollOptions?.join(", ")}`,
        msg,
      );
      await this.processQueue(msg.chatId);
      return;
    }

    const content = msg.content.trim();
    if (!content) return;

    // Queue if this specific chat is already processing — auto-reset after 3 minutes
    const chatBusy = this.processingChats.get(msg.chatId);
    if (chatBusy) {
      const stuckMs = Date.now() - chatBusy;
      if (stuckMs > 180_000) {
        console.warn(`[${this.label}] Chat ${msg.chatId} stuck for ${Math.round(stuckMs / 1000)}s — force-resetting`);
        this.processingChats.delete(msg.chatId);
      } else {
        console.log(`[${this.label}] Chat ${msg.chatId} busy — queuing: "${content.substring(0, 40)}"`);
        const q = this.messageQueueByChat.get(msg.chatId) ?? [];
        q.push(msg);
        this.messageQueueByChat.set(msg.chatId, q);
        return;
      }
    }

    await this.routeText(content, msg);
    await this.processQueue(msg.chatId);
  }

  private async routeText(content: string, msg: UnifiedMessage): Promise<void> {
    // Command handling — "!" prefix
    if (content.startsWith("!")) {
      await this.handleCommand(content, msg);
      return;
    }

    // Harness routing
    const decision = routeMessage(content, this.activeHarness, this.modelOverride);
    const enriched = this.enrichWithReply(content, msg);

    switch (decision.path) {
      case "local":
        await this.handleLocalHarness(enriched, decision.harness as any, msg);
        break;
      case "delegation":
        await this.handleDelegationInternal(enriched, decision.harness!, decision.role, msg);
        break;
      case "chat":
        await this.handleChatInternal(enriched, msg);
        break;
    }
  }

  private enrichWithReply(content: string, msg: UnifiedMessage): string {
    if (msg.replyContent) {
      const preview = msg.replyContent.slice(0, 200);
      return `[Replying to: "${preview}"]\n\n${content}`;
    }
    return content;
  }

  // ─── Command handling ──────────────────────────────────────────

  private async handleCommand(raw: string, msg: UnifiedMessage): Promise<void> {
    console.log(`[${this.label}] Command: ${raw}`);

    const cmdCtx: CommandContext = {
      bridge: this.bridge,
      relay: this.relay,
      sessionOrchestrator: this.sessionOrchestrator,
      threadStore: this.threadStore,
      platformConfig: this.config,
      vaultRoot: this.vaultRoot,
      getActiveHarness: () => this.activeHarness,
      setActiveHarness: (h) => { 
        this.activeHarness = h;
        if (this.threadId) {
          this.threadStore.setActiveHarness(this.threadId, h).catch(console.error);
        }
      },
      getModelOverride: () => this.modelOverride,
      setModelOverride: (m) => { this.modelOverride = m; },
      getThreadId: () => this.threadId,
      setThreadId: (id) => {
        this.threadId = id;
        // Sync chatThreads map so thread survives within the session
        if (id && this.currentChatId) {
          this.chatThreads.set(this.currentChatId, id);
        } else if (!id && this.currentChatId) {
          this.chatThreads.delete(this.currentChatId);
        }
      },
      getVoiceReplyEnabled: () => this.voiceReplyEnabled,
      setVoiceReplyEnabled: (v) => { this.voiceReplyEnabled = v; },
      getMediaAutoProcess: () => this.mediaAutoProcess,
      setMediaAutoProcess: (v) => { this.mediaAutoProcess = v; },
      getFormatEnabled: () => this.formatEnabled,
      setFormatEnabled: (v) => { this.formatEnabled = v; },
      getActiveJobId: () => this.delegationState.activeJobId,
      getActiveJobLabel: () => this.delegationState.activeJobLabel,
      hasVoiceSynth: () => !!(this.voiceHandler?.canSynthesize),
      hasVoiceTranscribe: () => !!this.voiceHandler,
      hasVision: () => !!(this.mediaHandler?.canDescribe),
      saveState: () => this.saveState(),
    };

    // Special case: "!export" is intercepted here to use bridge's file send
    const parts = raw.slice(1).split(/\s+/);
    const cmd = parts[0].toLowerCase();
    if (cmd === "export") {
      const argStr = parts.slice(1).join(" ").trim();
      if (!argStr) {
        await this.bridge.sendText(
          "Usage: `!export <relative-vault-path>`\nExample: `!export Notebooks/Projects/report.md`",
        );
        return;
      }
      const { resolve: resolvePath } = await import("path");
      const exportPath = resolvePath(this.vaultRoot, argStr);
      const resolvedVault = resolvePath(this.vaultRoot);
      if (!exportPath.startsWith(resolvedVault + "/")) {
        await this.bridge.sendText("Export path must be within the vault.");
        return;
      }
      try {
        const { readFileSync: rfs } = await import("fs");
        const buf = rfs(exportPath);
        const { basename } = await import("path");
        await this.bridge.sendFile(buf, basename(exportPath), `📎 ${basename(exportPath)}`);
      } catch (err) {
        await this.bridge.sendText(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // Harness picker with no args — return false so bridge can show native keyboard
    if ((cmd === "harness" || cmd === "switch") && parts.length === 1) {
      // Emit a synthetic action so platform bridge can display its native picker
      await this.onHarnessPickerRequest();
      return;
    }

    const handled = await dispatchCommand(raw, cmdCtx, (text) => this.sendChunked(text));
    if (!handled) {
      // Unknown to shared dispatcher — let bridge attempt to handle it
      await this.onUnknownCommand(cmd, parts.slice(1).join(" "), msg);
    }
  }

  /**
   * Called when !harness is issued with no args.
   * Override in subclass or bridge wrapper to show a platform-native picker.
   * Default: show text list.
   */
  protected async onHarnessPickerRequest(): Promise<void> {
    const current = harnessLabel(this.activeHarness);
    await this.bridge.sendText(
      `**Active harness:** ${current}\n\n` +
      "Use `!harness claude`, `!harness opencode`, `!harness gemini`, or `!harness auto`.",
    );
  }

  /**
   * Called when the shared dispatcher doesn't recognise a command.
   * Override in subclass to handle platform-specific commands.
   */
  protected async onUnknownCommand(
    _cmd: string,
    _argStr: string,
    _msg: UnifiedMessage,
  ): Promise<void> {
    await this.bridge.sendText(`Unknown command: \`!${_cmd}\`. Try \`!help\`.`);
  }

  // ─── Platform actions (e.g. inline keyboard presses) ──────────

  private async handleAction(action: PlatformAction): Promise<void> {
    if (action.type === "button_press" && action.actionId.startsWith("harness:")) {
      const target = action.actionId.replace("harness:", "") as ActiveHarness;
      const valid: ActiveHarness[] = ["auto", "claude-code", "opencode", "gemini-cli", "codex-cli"];
      if (!valid.includes(target)) return;
      this.activeHarness = target;
      if (this.threadId) {
        this.threadStore.setActiveHarness(this.threadId, target).catch(console.error);
      }
      this.saveState();
      await this.bridge.sendText(`Switched to **${harnessLabel(target)}**`);
    }
  }

  // ─── Local harness (direct CLI execution) ─────────────────────

  private async handleLocalHarness(
    content: string,
    harness: "claude-code" | "opencode" | "gemini-cli" | "codex-cli",
    msg: UnifiedMessage,
  ): Promise<void> {
    this.processingChats.set(msg.chatId, Date.now());
    const label = harnessLabel(harness);
    const sessionId = `${this.config.platformId}-${Date.now()}`;
    const streaming = this.bridge.capabilities.supportsStreaming;
    const streamingEdit = this.bridge.capabilities.supportsStreamingEdit && this.bridge.editMessage;

    // Edit-based streaming state for local harness
    let editMsgId: string | null = null;
    let editBuf = "";
    let editTmr: ReturnType<typeof setTimeout> | null = null;
    const EDIT_MS = 1500;
    const doFlush = () => {
      if (editMsgId && editBuf && this.bridge.editMessage) {
        this.bridge.editMessage(editMsgId, editBuf + " ▍").catch(() => {});
      }
    };

    if (msg) this.bridge.sendReaction(msg.id, "⏳", msg.chatId).catch(() => {});

    this.startTyping(msg.chatId);

    // Send placeholder for edit-based streaming
    if (streamingEdit) {
      try {
        const pid = await this.bridge.sendText("Thinking… ▍", { chatId: this.currentChatId || undefined });
        if (pid) editMsgId = pid;
      } catch { /* non-critical */ }
    }

    try {
      await this.sessionOrchestrator.run(sessionId, harness, content, {
        onStatusUpdate: (_session, message) => {
          console.log(`[${this.label}] Session ${sessionId}: ${message}`);
          this.bridge.sendText(message, { chatId: this.currentChatId || undefined }).catch(console.error);
        },
        onResult: (_session, result) => {
          this.stopTyping();
          if (editTmr) { clearTimeout(editTmr); editTmr = null; }
          if (msg) this.bridge.sendReaction(msg.id, "✅", msg.chatId).catch(() => {});
          if (streamingEdit && editMsgId) {
            // Delete the streaming placeholder and send final text as a reply
            // to the original message — this triggers a native notification
            if (this.bridge.deleteMessage) {
              this.bridge.deleteMessage(editMsgId, this.currentChatId || undefined).catch(() => {});
            }
            this.sendChunked(result, msg?.id).catch(console.error);
          } else if (!streaming) {
            // Non-streaming platforms: send full result as one message
            this.sendChunked(result).catch(console.error);
          }
          // Streaming platforms: tokens were already sent per-token via onToken; nothing to resend.
          this.flushSessionToVault(sessionId, harness, content, result);
        },
        // Stream tokens directly to the bridge when the platform supports it (e.g. PWA)
        onToken: streaming ? (_session, token) => {
          this.bridge.sendText(token, { chatId: this.currentChatId || undefined }).catch(console.error);
        } : streamingEdit ? (_session, token) => {
          editBuf += token;
          if (!editTmr) {
            editTmr = setTimeout(() => { editTmr = null; doFlush(); }, EDIT_MS);
          }
        } : undefined,
        onFailed: (_session, error) => {
          this.stopTyping();
          if (editTmr) { clearTimeout(editTmr); editTmr = null; }
          if (msg) this.bridge.sendReaction(msg.id, "❌", msg.chatId).catch(() => {});
          console.error(`[${this.label}] Session ${sessionId} failed: ${error}`);
          // Update placeholder with error if we were streaming
          if (streamingEdit && editMsgId && this.bridge.editMessage) {
            this.bridge.editMessage(editMsgId, `_${label} failed: ${error}_`).catch(() => {});
          } else {
            this.bridge.sendText(`_${label} failed: ${error}_`, { chatId: this.currentChatId || undefined }).catch(console.error);
          }
        },
      });
    } catch (err) {
      this.stopTyping();
      if (msg) this.bridge.sendReaction(msg.id, "❌", msg.chatId).catch(() => {});
      console.error(`[${this.label}] Orchestrator error for session ${sessionId}:`, err);
      await this.bridge.sendText(
        `_${label} error: ${err instanceof Error ? err.message : String(err)}_`,
        { chatId: this.currentChatId || undefined },
      );
    } finally {
      this.stopTyping();
      this.processingChats.delete(msg.chatId);
    }
  }

  // ─── Delegation ────────────────────────────────────────────────

  private async handleDelegationInternal(
    content: string,
    harness: string,
    role: string | undefined,
    msg: UnifiedMessage,
  ): Promise<void> {
    const chatId = msg.chatId;
    const delegCtx: DelegationContext = {
      relay: this.relay,
      bridge: this.bridge,
      state: this.delegationState,
      setProcessing: (b) => { if (b) this.processingChats.set(chatId, Date.now()); else this.processingChats.delete(chatId); },
      sendChunked: (text) => this.sendChunked(text),
      fallbackToChat: (c) => this.handleChatInternal(c),
      platformLabel: this.label,
    };
    await handleDelegation(content, harness, role, delegCtx, msg?.id);
  }

  private async handleVaultEventInternal(event: string, data: any): Promise<void> {
    const delegCtx: DelegationContext = {
      relay: this.relay,
      bridge: this.bridge,
      state: this.delegationState,
      setProcessing: () => { /* vault events are not tied to a specific chat */ },
      sendChunked: (text) => this.sendChunked(text),
      fallbackToChat: (c) => this.handleChatInternal(c),
      platformLabel: this.label,
    };
    await handleVaultEvent(event, data, delegCtx);
  }

  // ─── Chat relay ───────────────────────────────────────────────

  private async handleChatInternal(
    content: string,
    msg?: UnifiedMessage,
    images?: Array<{ url: string; mediaType?: string }>,
  ): Promise<void> {
    // Check relay connection — if down, fall back to local claude-code harness
    if (!this.relay.isConnected) {
      const fallback: "claude-code" | "opencode" | "gemini-cli" | "codex-cli" = "claude-code";
      console.log(`[${this.label}] Relay not connected — falling back to local ${fallback} harness`);
      await this.handleLocalHarness(content, fallback, msg!);
      return;
    }

    if (msg) this.processingChats.set(msg.chatId, Date.now());
    const streaming = this.bridge.capabilities.supportsStreaming;
    const streamingEdit = this.bridge.capabilities.supportsStreamingEdit && this.bridge.editMessage;

    // Edit-based streaming state (for Telegram-style platforms)
    let editPlaceholderMsgId: string | null = null;
    let editBuffer = "";
    let editTimer: ReturnType<typeof setTimeout> | null = null;
    const EDIT_THROTTLE_MS = 1500; // Edit every 1.5s to avoid Telegram rate limits

    const flushEdit = () => {
      if (editPlaceholderMsgId && editBuffer && this.bridge.editMessage) {
        const text = editBuffer + " ▍"; // typing cursor
        this.bridge.editMessage(editPlaceholderMsgId, text).catch(() => {});
      }
    };

    const chatCtx: ChatContext = {
      relay: this.relay,
      bridge: this.bridge,
      getThreadId: () => this.threadId,
      setThreadId: (id) => {
        this.threadId = id;
        // Sync chatThreads map so thread survives within the session
        if (id && this.currentChatId) {
          this.chatThreads.set(this.currentChatId, id);
        }
      },
      getModelOverride: () => this.modelOverride,
      sendResponse: async (text, replyToId) => {
        // Skip resending when we've already streamed all tokens to the bridge
        if (streaming) return;
        // For edit-based streaming, delete the placeholder and send as a reply
        // to the original message — this triggers a native notification
        if (streamingEdit && editPlaceholderMsgId) {
          if (editTimer) { clearTimeout(editTimer); editTimer = null; }
          if (this.bridge.deleteMessage) {
            await this.bridge.deleteMessage(editPlaceholderMsgId, this.currentChatId || undefined).catch(() => {});
          }
          await this.sendChunked(text, replyToId);
          return;
        }
        if (this.voiceReplyEnabled && this.voiceHandler) {
          try {
            await this.bridge.sendTyping();
            const audio = await this.voiceHandler.synthesize(text);
            await this.bridge.sendFile(audio, "voice.ogg");
            return;
          } catch {
            // TTS failed — fall through to text
          }
        }
        await this.sendChunked(text, replyToId);
      },
      // Forward relay deltas to the bridge when it supports streaming (e.g. PWA)
      sendDelta: streaming ? (delta) => {
        this.bridge.sendText(delta, { chatId: this.currentChatId || undefined }).catch(console.error);
      } : streamingEdit ? (delta) => {
        // Accumulate and throttle-edit the placeholder message
        editBuffer += delta;
        if (!editTimer) {
          editTimer = setTimeout(() => { editTimer = null; flushEdit(); }, EDIT_THROTTLE_MS);
        }
      } : undefined,
      sendTypingIfEnabled: async () => {
        if (this.config.notifications.showTyping) await this.bridge.sendTyping();
      },
      clearTyping: () => this.stopTyping(),
      platformLabel: this.label,
    };

    if (msg) this.bridge.sendReaction(msg.id, "⏳", msg.chatId).catch(() => {});
    this.startTyping(msg?.chatId);

    // Send a placeholder message for edit-based streaming
    if (streamingEdit) {
      try {
        const placeholderId = await this.bridge.sendText("Thinking… ▍", { chatId: this.currentChatId || undefined });
        if (placeholderId) editPlaceholderMsgId = placeholderId;
      } catch { /* non-critical — will fall back to non-streaming */ }
    }

    try {
      const result = await handleChat(
        content,
        chatCtx,
        msg?.id,
        this.config.harnessTimeouts["relay"] ?? this.config.defaultTimeout,
        images,
      );
      if (editTimer) { clearTimeout(editTimer); editTimer = null; }
      if (result && msg) this.bridge.sendReaction(msg.id, "✅", msg.chatId).catch(() => {});
      if (!result && msg) this.bridge.sendReaction(msg.id, "❌", msg.chatId).catch(() => {});
    } finally {
      this.stopTyping();
      if (msg) this.processingChats.delete(msg.chatId);
    }
  }

  // ─── Voice handling ────────────────────────────────────────────

  private async handleVoice(msg: UnifiedMessage): Promise<void> {
    if (!this.voiceHandler) {
      await this.bridge.sendText(
        "Voice notes received but transcription is not configured.\n" +
        "Set GROQ_API_KEY in .env.local to enable voice note support.",
      );
      return;
    }
    if (!msg.audioBuffer) {
      await this.bridge.sendText("Received a voice note but failed to download the audio.");
      return;
    }
    try {
      console.log(`[${this.label}] Transcribing voice note...`);
      await this.bridge.sendTyping();
      const transcript = await this.voiceHandler.transcribe(msg.audioBuffer);
      if (!transcript) {
        await this.bridge.sendText("I received your voice note but couldn't make out what was said.");
        return;
      }
      console.log(`[${this.label}] Voice transcribed: "${transcript.substring(0, 80)}"`);
      await this.handleChatInternal(`[Voice note]: ${transcript}`, msg);
    } catch (err) {
      console.error(`[${this.label}] Transcription failed:`, err);
      await this.bridge.sendText(
        `Failed to transcribe voice note: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ─── Media handling ────────────────────────────────────────────

  private async handleMedia(msg: UnifiedMessage): Promise<void> {
    const { mediaType, mediaBuffer, mediaMimeType, mediaFilename, mediaSize } = msg;
    const sizeStr = this.mediaHandler?.formatSize(mediaSize ?? 0) ?? `${mediaSize ?? 0}B`;

    if (!mediaBuffer) {
      await this.bridge.sendText(`Received ${mediaType} but failed to download it.`);
      return;
    }

    switch (mediaType) {
      case "photo": {
        // Pass the image directly to the chat model so it can see it natively
        const base64 = mediaBuffer.toString("base64");
        const mimeType = mediaMimeType || "image/jpeg";
        const caption = msg.content || "What is in this image?";
        const imageData = [{ url: `data:${mimeType};base64,${base64}`, mediaType: mimeType }];
        await this.handleChatInternal(
          `[Image received (${sizeStr})]: ${caption}`,
          msg,
          imageData,
        );
        break;
      }

      case "document": {
        const fname = mediaFilename ?? "unknown";
        const caption = msg.content ? `\nCaption: "${msg.content}"` : "";

        // Save to vault uploads
        let vaultRef = "";
        if (mediaBuffer && mediaSize && mediaSize > 0) {
          try {
            const uploadsDir = join(this.vaultRoot, "_jobs", "uploads");
            mkdirSync(uploadsDir, { recursive: true });
            const safeName = `${this.config.platformId}-upload-${Date.now()}-${fname.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
            const uploadPath = join(uploadsDir, safeName);
            writeFileSync(uploadPath, mediaBuffer);
            const noteContent = [
              "---",
              "noteType: upload",
              `source: ${this.config.platformId}`,
              `filename: ${safeName}`,
              `size: ${mediaSize}`,
              `receivedAt: ${new Date().toISOString()}`,
              "---",
              "",
              `File saved from ${this.config.platformId}: ${fname}`,
            ].join("\n");
            writeFileSync(join(uploadsDir, safeName.replace(/\.[^.]+$/, ".md")), noteContent);
            vaultRef = `\n\n[Document saved to vault: ${uploadPath}]`;
          } catch (e) {
            console.error(`[${this.label}] Failed to save upload to vault:`, e);
          }
        }

        if (this.mediaAutoProcess && this.mediaHandler && mediaMimeType) {
          const extracted = this.mediaHandler.extractDocumentText(mediaBuffer!, mediaMimeType, fname);
          await this.handleChatInternal(
            `[Document: ${fname} (${sizeStr})]${caption}\n\nContent:\n${extracted}${vaultRef}`,
            msg,
          );
        } else {
          await this.bridge.sendText(`Document received: ${fname} (${sizeStr})${caption}${vaultRef}`);
        }
        break;
      }

      case "video":
        await this.bridge.sendText(`Video received (${sizeStr}).`);
        break;

      case "sticker":
        await this.bridge.sendText(`Sticker received: ${msg.content}`);
        break;

      default:
        await this.bridge.sendText(`${mediaType} received (${sizeStr}).`);
    }
  }

  // ─── Queue ────────────────────────────────────────────────────

  private async processQueue(chatId: string): Promise<void> {
    const queue = this.messageQueueByChat.get(chatId);
    if (!queue) return;
    while (queue.length > 0) {
      const queuedMsg = queue.shift()!;
      const content = queuedMsg.content.trim();

      if (queuedMsg.mediaType && queuedMsg.mediaType !== "audio") {
        await this.handleMedia(queuedMsg);
        continue;
      }
      if (!content) continue;

      console.log(`[${this.label}] Processing queued message for ${chatId}: "${content.substring(0, 40)}"`);
      await this.routeText(content, queuedMsg);
    }
    this.messageQueueByChat.delete(chatId);
  }

  // ─── Session flush (Touch Points — conversation-learner) ───────

  private flushSessionToVault(sessionId: string, harness: string, prompt: string, result: string): void {
    try {
      const sessionsDir = join(this.vaultRoot, "_agent-sessions");
      mkdirSync(sessionsDir, { recursive: true });
      const ts = new Date().toISOString();
      const filename = `${this.config.platformId}-${sessionId}.md`;
      const content = [
        "---",
        `sessionId: "${sessionId}"`,
        `harness: "${harness}"`,
        `source: ${this.config.platformId}`,
        `createdAt: ${ts}`,
        "---",
        `# ${this.config.platformId} Session — ${harness}`,
        "",
        "## User",
        prompt,
        "",
        "## Assistant",
        result,
        "",
      ].join("\n");
      writeFileSync(join(sessionsDir, filename), content, "utf-8");
      console.log(`[${this.label}] Flushed session ${sessionId} to _agent-sessions/${filename}`);
    } catch (err) {
      console.warn(`[${this.label}] Failed to flush session to vault:`, err);
    }
  }

  // ─── CHANNEL-PRESENCE.md ──────────────────────────────────────

  private updateChannelPresence(): void {
    try {
      const presencePath = join(this.vaultRoot, "_system", "CHANNEL-PRESENCE.md");
      if (existsSync(presencePath)) {
        const raw = readFileSync(presencePath, "utf-8");
        const platformId = this.config.platformId;
        const updated = raw.replace(
          new RegExp(`^${platformId}:.*$`, "m"),
          `${platformId}: ${new Date().toISOString()}`,
        );
        writeFileSync(presencePath, updated, "utf-8");
      }
    } catch { /* non-critical */ }
  }

  // ─── Typing indicator ──────────────────────────────────────────

  private startTyping(chatId?: string): void {
    if (!this.config.notifications.showTyping) return;
    const keepAlive = this.config.notifications.typingKeepAliveMs || 4_000;
    this.bridge.sendTyping(chatId).catch(() => {});
    if (this.typingInterval) clearInterval(this.typingInterval);
    this.typingInterval = setInterval(() => {
      this.bridge.sendTyping(chatId).catch(() => {});
    }, keepAlive);
  }

  private stopTyping(): void {
    if (this.typingInterval) {
      clearInterval(this.typingInterval);
      this.typingInterval = null;
    }
    // Also stop the bridge's internal typing keepalive (e.g. TypingManager on Discord)
    this.bridge.stopTyping?.().catch(() => {});
  }

  // ─── Text chunking ─────────────────────────────────────────────

  async sendChunked(text: string, replyToId?: string): Promise<void> {
    const maxLen = this.bridge.capabilities.maxMessageLength;

    if (text.length <= maxLen) {
      await this.bridge.sendText(text, { replyToId, chatId: this.currentChatId || undefined });
      return;
    }

    // Split at paragraph boundaries
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }
      let splitAt = remaining.lastIndexOf("\n\n", maxLen);
      if (splitAt < maxLen / 2) splitAt = remaining.lastIndexOf("\n", maxLen);
      if (splitAt < maxLen / 2) splitAt = remaining.lastIndexOf(" ", maxLen);
      if (splitAt < maxLen / 2) splitAt = maxLen;
      chunks.push(remaining.substring(0, splitAt));
      remaining = remaining.substring(splitAt).trimStart();
    }

    console.log(`[${this.label}] Sending ${chunks.length} chunks (total: ${text.length} chars)`);
    for (let i = 0; i < chunks.length; i++) {
      await this.bridge.sendText(chunks[i], { replyToId: i === 0 ? replyToId : undefined });
    }
  }

  // ─── State persistence ─────────────────────────────────────────

  private loadState(): void {
    try {
      const raw = readFileSync(this.stateFile, "utf8");
      const data = JSON.parse(raw) as { activeHarness?: string };
      const valid: ActiveHarness[] = ["auto", "claude-code", "opencode", "gemini-cli", "codex-cli"];
      if (data.activeHarness && valid.includes(data.activeHarness as ActiveHarness)) {
        this.activeHarness = data.activeHarness as ActiveHarness;
        console.log(`[${this.label}] Loaded persisted harness: ${this.activeHarness}`);
      }
    } catch { /* first run */ }
  }

  protected saveState(): void {
    try {
      writeFileSync(
        this.stateFile,
        JSON.stringify({ activeHarness: this.activeHarness }, null, 2),
        "utf8",
      );
    } catch (err) {
      console.error(`[${this.label}] Failed to save state:`, err);
    }
  }

  // ─── Public harness accessors (for slash command integration) ────

  getActiveHarness(): ActiveHarness {
    return this.activeHarness;
  }

  setActiveHarness(h: ActiveHarness): void {
    this.activeHarness = h;
    if (this.threadId) {
      this.threadStore.setActiveHarness(this.threadId, h).catch(console.error);
    }
    this.saveState();
  }
}
