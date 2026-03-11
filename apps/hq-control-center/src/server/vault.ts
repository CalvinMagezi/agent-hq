import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

// Vault path — server functions use raw fs/gray-matter, no bun:sqlite dependency
const __dirname = typeof import.meta.dir === 'string'
  ? import.meta.dir                          // Bun
  : path.dirname(fileURLToPath(import.meta.url)) // Node/Vite SSR

export const VAULT_PATH =
  process.env.VAULT_PATH ?? path.resolve(__dirname, '../../../../.vault')
