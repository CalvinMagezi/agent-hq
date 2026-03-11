import * as path from 'node:path'

// Vault path — server functions use raw fs/gray-matter, no bun:sqlite dependency
export const VAULT_PATH =
  process.env.VAULT_PATH ?? path.resolve(import.meta.dir, '../../../../.vault')
