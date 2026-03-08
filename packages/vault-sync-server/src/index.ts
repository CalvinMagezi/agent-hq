/**
 * CLI entry point for the vault sync server.
 *
 * Usage:
 *   bun run packages/vault-sync-server/src/index.ts [options]
 *
 * Options:
 *   --port <number>       Port to listen on (default: 18800)
 *   --host <string>       Host to bind (default: 127.0.0.1)
 *   --db <path>           Path to SQLite database (default: ./sync-server.db)
 *   --secret-file <path>  Path to persist HMAC server secret (default: <db-dir>/sync-server.secret)
 *   --tls-cert <path>     TLS certificate file (enables TLS)
 *   --tls-key <path>      TLS private key file
 *   --debug               Enable debug logging
 */

import * as fs from "fs";
import * as path from "path";
import { SyncServer } from "./server";
import { DEFAULT_CONFIG, type SyncServerConfig } from "./config";
import { generateServerSecret } from "@repo/vault-sync-protocol";

/**
 * Load or generate the server secret.
 * On first run: generate a 32-byte random secret and write to file.
 * On subsequent runs: read from file so tokens survive restarts.
 */
function loadOrCreateSecret(secretFilePath: string): string {
  try {
    if (fs.existsSync(secretFilePath)) {
      const secret = fs.readFileSync(secretFilePath, "utf8").trim();
      if (secret.length === 64) {
        return secret; // 32 bytes as hex
      }
      console.warn("[sync-server] Secret file malformed — regenerating");
    }
  } catch {
    // Fall through to generate
  }

  const secret = generateServerSecret();
  try {
    fs.mkdirSync(path.dirname(secretFilePath), { recursive: true });
    fs.writeFileSync(secretFilePath, secret, { mode: 0o600 }); // owner-only read
    console.log(`[sync-server] Generated new server secret → ${secretFilePath}`);
  } catch (err) {
    console.warn("[sync-server] Could not persist server secret:", err);
  }
  return secret;
}

interface ParsedArgs extends Partial<SyncServerConfig> {
  secretFile?: string;
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  const config: ParsedArgs = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--port":
        config.port = parseInt(args[++i], 10);
        break;
      case "--host":
        config.host = args[++i];
        break;
      case "--db":
        config.dbPath = args[++i];
        break;
      case "--secret-file":
        config.secretFile = args[++i];
        break;
      case "--tls-cert":
        config.tlsCertPath = args[++i];
        config.enableTls = true;
        break;
      case "--tls-key":
        config.tlsKeyPath = args[++i];
        config.enableTls = true;
        break;
      case "--debug":
        config.debug = true;
        break;
      case "--help":
        console.log(`
Agent-HQ Vault Sync Server

Usage: bun run sync-server [options]

Options:
  --port <number>         Port to listen on (default: ${DEFAULT_CONFIG.port})
  --host <string>         Host to bind (default: ${DEFAULT_CONFIG.host})
  --db <path>             SQLite database path (default: ${DEFAULT_CONFIG.dbPath})
  --secret-file <path>    Path to persist the HMAC server secret (default: <db-dir>/sync-server.secret)
  --tls-cert <path>       TLS certificate (enables TLS)
  --tls-key <path>        TLS private key
  --debug                 Enable debug logging
  --help                  Show this help
`);
        process.exit(0);
    }
  }

  return config;
}

// ─── Main ────────────────────────────────────────────────────

const userConfig = parseArgs();

// Resolve the secret file path relative to the db file
const dbPath = userConfig.dbPath ?? DEFAULT_CONFIG.dbPath;
const secretFile = userConfig.secretFile ?? path.join(path.dirname(dbPath), "sync-server.secret");
const serverSecret = loadOrCreateSecret(secretFile);

const config: SyncServerConfig = { ...DEFAULT_CONFIG, ...userConfig, serverSecret };

const server = new SyncServer(config);
server.start();

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n[sync-server] Shutting down...");
  server.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  server.stop();
  process.exit(0);
});
