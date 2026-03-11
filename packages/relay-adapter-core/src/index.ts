/**
 * @repo/relay-adapter-core — shared infrastructure for relay adapters.
 *
 * Provides: VoiceHandler, LocalHarness, SessionOrchestrator, MediaHandler,
 * intent orchestration, and formatter utilities.
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
