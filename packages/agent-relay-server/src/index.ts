/**
 * CLI entry point for the Agent Relay Server.
 *
 * Usage:
 *   bun run relay-server [options]
 *
 * Options:
 *   --port <number>       Port to listen on (default: 18900)
 *   --host <string>       Host to bind (default: 127.0.0.1)
 *   --vault-path <path>   Path to .vault directory
 *   --api-key <key>       API key for authentication
 *   --debug               Enable debug logging
 *   --help                Show this help
 */

import { RelayServer } from "./server";
import { DEFAULT_CONFIG, type RelayServerConfig } from "./config";

function parseArgs(): Partial<RelayServerConfig> {
  const args = process.argv.slice(2);
  const config: Partial<RelayServerConfig> = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--port":
        config.port = parseInt(args[++i], 10);
        break;
      case "--host":
        config.host = args[++i];
        break;
      case "--vault-path":
        config.vaultPath = args[++i];
        break;
      case "--api-key":
        config.apiKey = args[++i];
        break;
      case "--debug":
        config.debug = true;
        break;
      case "--help":
        console.log(`
Agent HQ Relay Server

Usage: bun run relay-server [options]

Options:
  --port <number>       Port to listen on (default: ${DEFAULT_CONFIG.port})
  --host <string>       Host to bind (default: ${DEFAULT_CONFIG.host})
  --vault-path <path>   Path to .vault directory (default: ./.vault)
  --api-key <key>       API key (or set AGENTHQ_API_KEY env var)
  --debug               Enable debug logging
  --help                Show this help

Environment Variables:
  VAULT_PATH            Path to vault directory
  AGENTHQ_API_KEY       API key for authentication
  OPENROUTER_API_KEY    Required for chat functionality
  DEFAULT_MODEL         Default LLM model (default: moonshotai/kimi-k2.5)
`);
        process.exit(0);
    }
  }

  return config;
}

// ─── Main ────────────────────────────────────────────────────

const userConfig = parseArgs();
const config: RelayServerConfig = { ...DEFAULT_CONFIG, ...userConfig };

const server = new RelayServer(config);

server.start().catch((err) => {
  console.error("[relay-server] Failed to start:", err);
  process.exit(1);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n[relay-server] Shutting down...");
  server.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  server.stop();
  process.exit(0);
});
