/**
 * @repo/relay-adapter-core — shared infrastructure for relay adapters.
 *
 * Provides: VoiceHandler, LocalHarness, SessionOrchestrator, MediaHandler,
 * intent orchestration, formatter utilities, and the unified relay adapter
 * architecture (UnifiedAdapterBot + platform bridge abstractions).
 */

export { VoiceHandler, type VoiceHandlerConfig } from "./voice.js";
export { LocalHarness, type LocalHarnessType } from "./localHarness.js";
export {
  SessionOrchestrator,
  type SessionState,
  type OrchestratedSession,
  type SessionReactions,
} from "./sessionOrchestrator.js";
export {
  MediaHandler,
  detectImageMime,
  type MediaHandlerConfig,
} from "./media.js";
export {
  detectIntent,
  type OrchestrationIntent,
  type TargetHarness,
  type DetectedRole,
} from "./orchestrator.js";
export {
  extractCodePlaceholders,
  restorePlaceholders,
  type PlaceholderResult,
} from "./formatter.js";

// ── Unified Relay Architecture ────────────────────────────────────

export {
  type PlatformBridge,
  type PlatformId,
  type PlatformCapabilities,
  type UnifiedMessage,
  type PlatformAction,
  type PlatformActionType,
  type SendOpts,
} from "./platformBridge.js";

export {
  type PlatformConfig,
  type NotificationConfig,
  PLATFORM_DEFAULTS,
  buildPlatformConfig,
  loadVaultPlatformConfig,
} from "./platformConfig.js";

export {
  VaultThreadStore,
  type ThreadStore,
  type Thread,
  type ThreadMessage,
  type ThreadMeta,
} from "./threadStore.js";

export {
  routeMessage,
  harnessLabel,
  delegationLabel,
  HARNESS_ALIASES,
  type ActiveHarness,
  type RouteDecision,
  type RoutePath,
} from "./harnessRouter.js";

export {
  dispatchCommand,
  type CommandContext,
} from "./commands.js";

export {
  handleChat,
  type ChatContext,
} from "./chatHandler.js";

export {
  handleDelegation,
  handleVaultEvent,
  type DelegationContext,
  type DelegationState,
} from "./delegation.js";

export {
  UnifiedAdapterBot,
  type UnifiedAdapterBotConfig,
} from "./unifiedBot.js";
