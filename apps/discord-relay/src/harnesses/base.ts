import type { ChannelSettings } from "../types.js";

/** Options passed to harness.call() alongside the prompt */
export interface HarnessCallOptions {
  filePaths?: string[];
  channelSettings?: ChannelSettings;
  continueSession?: boolean;
}

/** Usage stats returned by harness.getUsage() */
export interface HarnessUsageStats {
  totalCostUsd: number;
  totalTurns: number;
  totalCalls: number;
  lastCallCostUsd: number;
  lastCallAt: string;
  byModel: Record<string, { calls: number; costUsd: number; turns: number }>;
}

/**
 * Abstract interface that every CLI tool harness must implement.
 * Each harness wraps a specific coding CLI (Claude Code, OpenCode, Gemini CLI, etc.)
 * and provides a uniform API for the bot layer.
 */
export interface BaseHarness {
  /** Human-readable name shown in logs and bot presence, e.g. "Claude Code" */
  readonly harnessName: string;

  /** Initialize persistent storage (sessions, settings, usage) */
  init(): Promise<void>;

  /** Send a prompt and return the response text */
  call(
    prompt: string,
    channelId: string,
    options?: HarnessCallOptions,
  ): Promise<string>;

  resetSession(channelId: string): Promise<void>;
  getSession(channelId: string): { sessionId: string | null };

  getChannelSettings(channelId: string): ChannelSettings;
  setChannelSettings(
    channelId: string,
    settings: Partial<ChannelSettings>,
  ): Promise<ChannelSettings>;
  clearChannelSettings(channelId: string): Promise<void>;

  getUsage(): HarnessUsageStats;
  resetUsage(): Promise<void>;
}
