/**
 * Context Engine Adapter — Bridges VaultAPI to the context-engine's VaultClientLike.
 *
 * Wraps the Discord relay's VaultAPI (which reads from the Obsidian vault)
 * into the VaultClientLike interface expected by @repo/context-engine.
 *
 * This adapter allows the Discord relay to use the new ContextEngine
 * for token-budgeted, layered context assembly instead of the older
 * ContextEnricher's ad-hoc string concatenation.
 */

import type { VaultClientLike } from "@repo/context-engine";
import type { VaultAPI } from "./vaultApi.js";

/**
 * Adapt the Discord relay's VaultAPI into context-engine's VaultClientLike.
 */
export function createVaultAdapter(vaultApi: VaultAPI): VaultClientLike {
    // We need the underlying VaultClient for getAgentContext.
    // VaultAPI wraps it internally. We'll reconstruct the interface.
    return {
        async getAgentContext() {
            // VaultAPI doesn't expose getAgentContext directly,
            // but the underlying VaultClient does. We'll compose it from
            // the VaultAPI methods we do have.
            const [pinnedNotes, memoryFacts] = await Promise.all([
                vaultApi.getPinnedNotes(),
                vaultApi.getMemoryFacts(),
            ]);

            // For soul/memory/preferences, we'll use the vault client directly.
            // Since VaultAPI tracks the vault path internally, we access it
            // through the methods available.
            // Note: The ContextEngine will call this, so we provide the full shape.
            const { VaultClient } = await import("@repo/vault-client");

            // Access the vault path from the VaultAPI instance
            // VaultAPI stores the vault as a private field; we re-construct from env
            const vaultPath =
                process.env.VAULT_PATH ??
                (await import("path")).resolve(import.meta.dir, "../../../.vault");
            const rawVault = new VaultClient(vaultPath);
            const ctx = await rawVault.getAgentContext();

            return {
                soul: ctx.soul,
                memory: ctx.memory,
                preferences: ctx.preferences,
                config: ctx.config,
                pinnedNotes: ctx.pinnedNotes.map((n: any) => ({
                    title: n.title,
                    content: n.content,
                    tags: n.tags,
                })),
            };
        },

        async searchNotes(query: string, limit: number) {
            const results = await vaultApi.searchNotes(query, limit);
            return results.map((r) => ({
                title: r.title,
                content: r.content,
                notebook: r.notebook,
                tags: r.tags,
            }));
        },

        async getRecentMessages(channelId: string, limit: number) {
            const messages = await vaultApi.getRecentMessages(channelId, limit);
            return messages.map((m) => ({
                role: m.role as "user" | "assistant",
                content: m.content,
                timestamp: m.timestamp ? new Date(m.timestamp).toISOString() : undefined,
            }));
        },

        async getMemoryFacts() {
            const facts = await vaultApi.getMemoryFacts();
            return facts.map((f) => ({
                type: f.type as "fact" | "goal",
                content: f.content,
                deadline: undefined,
            }));
        },
    };
}
