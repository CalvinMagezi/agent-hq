import { VaultClient, SearchClient } from "@repo/vault-client";
import { VaultSync } from "@repo/vault-sync";

// Assumes the vault is the first arg, or defaults to a hardcoded path if needed, 
// but typically read from env or config.
// Since this is agent-hq monorepo, the vault is usually `process.env.VAULT_PATH` or `../../.vault`.
const VAULT_PATH = process.env.VAULT_PATH ?? "/Users/calvinmagezi/Documents/GitHub/agent-hq/.vault";

export const vaultClient = new VaultClient(VAULT_PATH);
export const searchClient = new SearchClient(VAULT_PATH);
export const vaultSync = new VaultSync({
    vaultPath: VAULT_PATH,
    deviceId: "hq-pwa-server",
    debug: false
});

// Start the sync engine so we get events
vaultSync.start().catch(console.error);
