// Vault path — server functions use raw fs/gray-matter, no bun:sqlite dependency
export const VAULT_PATH =
  process.env.VAULT_PATH ?? '/Users/calvinmagezi/Documents/GitHub/agent-hq/.vault'
