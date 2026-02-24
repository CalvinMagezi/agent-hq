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
 *   --tls-cert <path>     TLS certificate file (enables TLS)
 *   --tls-key <path>      TLS private key file
 *   --debug               Enable debug logging
 */

import { SyncServer } from "./server";
import { DEFAULT_CONFIG, type SyncServerConfig } from "./config";

function parseArgs(): Partial<SyncServerConfig> {
  const args = process.argv.slice(2);
  const config: Partial<SyncServerConfig> = {};

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
  --port <number>     Port to listen on (default: ${DEFAULT_CONFIG.port})
  --host <string>     Host to bind (default: ${DEFAULT_CONFIG.host})
  --db <path>         SQLite database path (default: ${DEFAULT_CONFIG.dbPath})
  --tls-cert <path>   TLS certificate (enables TLS)
  --tls-key <path>    TLS private key
  --debug             Enable debug logging
  --help              Show this help
`);
        process.exit(0);
    }
  }

  return config;
}

// ─── Main ────────────────────────────────────────────────────

const userConfig = parseArgs();
const config: SyncServerConfig = { ...DEFAULT_CONFIG, ...userConfig };

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
