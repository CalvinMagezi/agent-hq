import * as path from "path";
import * as fs from "fs";
import { VaultClient } from "@repo/vault-client";

const COO_POLL_INTERVAL_MS = 2_000;
const COO_POLL_TIMEOUT_MS = 300_000; // 5 min

/**
 * Route a user message to either the internal job queue or the external COO.
 * External mode: writes intent to coo_inbox and returns immediately.
 * The daemon's coo-outbox task will dispatch the COO's response when it arrives.
 */
export async function routeUserMessage(
    vault: VaultClient,
    instruction: string,
    priority: number = 50,
    securityProfile: string = "guarded"
): Promise<{ jobId?: string; intentId?: string; message: string }> {
    try {
        const context = await vault.getAgentContext();
        const mode = context.config["orchestration_mode"] || "internal";

        if (mode === "external") {
            const intentId = await vault.sendToCoo({
                jobId: "",
                instruction,
                priority,
            });
            return {
                intentId,
                message: `Dispatched to COO (Intent ID: ${intentId}). The COO will plan and delegate the work — results will arrive when ready.`,
            };
        } else {
            const jobId = await vault.createJob({
                instruction,
                type: "background",
                priority,
                securityProfile: securityProfile as any,
            });
            return {
                jobId,
                message: `Job dispatched (ID: ${jobId}). The task is now running in the background.`,
            };
        }
    } catch (error: any) {
        throw new Error(`Routing failed: ${error.message}`);
    }
}

/**
 * Poll coo_outbox for a response to the given intentId.
 * Returns the response string when the COO writes it, or null if not yet available.
 * Used for synchronous flows that need to wait for the COO's reply.
 */
export async function pollCooResponse(
    vault: VaultClient,
    intentId: string,
    timeoutMs = COO_POLL_TIMEOUT_MS,
): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const response = await vault.getCooResponse(intentId);
        if (response !== null) return response;
        await new Promise(r => setTimeout(r, COO_POLL_INTERVAL_MS));
    }
    return null; // timed out
}

/**
 * Read orchestration_mode directly from vault _system/CONFIG.md.
 * Falls back to "internal" if unavailable.
 */
export function readOrchestrationMode(vaultPath: string): "internal" | "external" {
    const configPath = path.join(vaultPath, "_system", "CONFIG.md");
    try {
        const raw = fs.readFileSync(configPath, "utf-8");
        const match = raw.match(/\| orchestration_mode\s*\|\s*([a-zA-Z0-9_\-]+)\s*\|/);
        if (match && match[1] === "external") return "external";
    } catch { /* ignore */ }
    return "internal";
}
