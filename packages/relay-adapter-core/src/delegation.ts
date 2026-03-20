/**
 * delegation — STUB module (delegation system removed).
 *
 * Preserved as no-op exports so unifiedBot.ts compiles without changes.
 * The delegation routing path is never reached in practice.
 */

import type { PlatformBridge } from "./platformBridge.js";

// ─── Types ────────────────────────────────────────────────────────

export interface DelegationState {
  activeJobId: string | null;
  activeJobLabel: string | null;
  activeJobResultDelivered: boolean;
  activeTaskIds: Set<string>;
  activeJobSourceMsgId: string | null;
}

export interface DelegationContext {
  relay: any;
  bridge: PlatformBridge;
  state: DelegationState;
  setProcessing(b: boolean): void;
  sendChunked(text: string): Promise<void>;
  fallbackToChat(content: string): Promise<void>;
  platformLabel: string;
}

// ─── No-op handlers ──────────────────────────────────────────────

export async function handleDelegation(
  _content: string,
  _harness: string,
  _role: string | undefined,
  ctx: DelegationContext,
  _sourceMsgId?: string,
): Promise<void> {
  // Delegation system removed — fall back to direct chat
  await ctx.fallbackToChat(_content);
}

export async function handleVaultEvent(
  _event: string,
  _data: any,
  _ctx: DelegationContext,
): Promise<void> {
  // No-op — delegation events no longer processed
}
