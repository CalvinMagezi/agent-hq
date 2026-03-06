/**
 * Vault Adapter — Decouples the context engine from the VaultClient implementation.
 *
 * Provides helpers for adapting different vault client shapes to the
 * VaultClientLike interface expected by the context engine.
 */

import type { VaultClientLike } from "../types.js";

/**
 * Create a VaultClientLike from any object that has the necessary methods.
 * Fills in missing optional methods with safe defaults.
 */
export function adaptVaultClient(client: any): VaultClientLike {
    if (!client.getAgentContext) {
        throw new Error("Vault client must implement getAgentContext()");
    }
    if (!client.searchNotes) {
        throw new Error("Vault client must implement searchNotes()");
    }

    return {
        getAgentContext: client.getAgentContext.bind(client),
        searchNotes: client.searchNotes.bind(client),
        getRecentMessages: client.getRecentMessages
            ? client.getRecentMessages.bind(client)
            : undefined,
        getMemoryFacts: client.getMemoryFacts
            ? client.getMemoryFacts.bind(client)
            : undefined,
    };
}

/**
 * Create a minimal mock vault client for testing.
 */
export function createMockVault(
    overrides: Partial<VaultClientLike> = {}
): VaultClientLike {
    return {
        getAgentContext: async () => ({
            soul: "",
            memory: "",
            preferences: "",
            config: {},
            pinnedNotes: [],
        }),
        searchNotes: async () => [],
        ...overrides,
    };
}
