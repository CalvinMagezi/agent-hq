/**
 * Shared module-level state for delegation tools.
 *
 * All delegation tools access this state via imported getters/setters.
 * State is initialized once via initDelegationTools() and updated per-job
 * via setCurrentJob().
 */

import { VaultClient } from "@repo/vault-client";
import { TraceDB } from "@repo/vault-client/trace";
import type { ExecutionMode } from "../executionModes.js";

// Module-level config set at init time
export let _vault: VaultClient | null = null;
export let _vaultPath: string = "";
export let _currentJobId: string | null = null;
export let _currentUserId: string | null = null;
export let _traceDb: TraceDB | null = null;
export let _currentTraceId: string | null = null;
export let _currentJobSpanId: string | null = null;

// Execution mode — set per-job via setCurrentExecutionMode()
export let _currentExecutionMode: ExecutionMode = "standard";

// Notifiers — set at agent startup via setDelegationNotifiers()
export let _discordBot: { sendProgressMessage: (content: string, embed?: any) => Promise<void> } | null = null;
export let _wsServer: { broadcast: (msg: any) => void } | null = null;

/**
 * Set Discord bot and WebSocket server references for autonomous monitoring.
 * Called once from index.ts after both are initialized. Both may be null.
 */
export function setDelegationNotifiers(
    discordBot: { sendProgressMessage: (content: string, embed?: any) => Promise<void> } | null,
    wsServer: { broadcast: (msg: any) => void } | null,
): void {
    _discordBot = discordBot;
    _wsServer = wsServer;
}

/** Initialize delegation tools with vault path */
export function initDelegationTools(vaultPath: string, _apiKey?: string) {
    _vault = new VaultClient(vaultPath);
    _vaultPath = vaultPath;
    _traceDb = new TraceDB(vaultPath);
}

/** Set the current job context for delegation (called per-job) */
export function setCurrentJob(
    jobId: string | null,
    userId: string | null,
    traceId?: string | null,
    jobSpanId?: string | null,
) {
    _currentJobId = jobId;
    _currentUserId = userId;
    _currentTraceId = traceId ?? null;
    _currentJobSpanId = jobSpanId ?? null;
}

/** Set the execution mode for the current job (affects parallelism, timeouts, etc.) */
export function setCurrentExecutionMode(mode: ExecutionMode): void {
    _currentExecutionMode = mode;
}
