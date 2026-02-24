/**
 * SyncServer — WebSocket relay server using Bun.serve().
 *
 * The server is a thin message relay. It routes encrypted sync
 * messages between devices in the same vault group. It never
 * stores or decrypts file content.
 */

import type { Database } from "bun:sqlite";
import * as fs from "fs";
import { ChangeRouter } from "./changeRouter";
import { openServerDatabase } from "./db";
import { generateServerSecret } from "@repo/vault-sync-protocol";
import type { SyncServerConfig } from "./config";

export class SyncServer {
  private router: ChangeRouter;
  private db: Database;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private config: SyncServerConfig;

  constructor(config: SyncServerConfig) {
    this.config = config;

    // Auto-generate server secret if not provided
    if (!config.serverSecret) {
      config.serverSecret = generateServerSecret();
      if (config.debug) {
        console.log("[sync-server] Generated new server secret");
      }
    }

    this.db = openServerDatabase(config.dbPath);
    this.router = new ChangeRouter(this.db, config);
  }

  /**
   * Start the WebSocket server.
   */
  start(): void {
    const tlsConfig =
      this.config.enableTls && this.config.tlsCertPath && this.config.tlsKeyPath
        ? {
            cert: fs.readFileSync(this.config.tlsCertPath),
            key: fs.readFileSync(this.config.tlsKeyPath),
          }
        : undefined;

    this.server = Bun.serve({
      port: this.config.port,
      hostname: this.config.host,
      tls: tlsConfig,

      fetch(req, server) {
        const url = new URL(req.url);

        // Health check endpoint
        if (url.pathname === "/health") {
          return new Response(
            JSON.stringify({ status: "ok", version: "0.1.0" }),
            { headers: { "Content-Type": "application/json" } },
          );
        }

        // Upgrade to WebSocket
        if (server.upgrade(req, { data: {} })) {
          return; // Upgraded
        }

        return new Response("Agent-HQ Vault Sync Server", { status: 200 });
      },

      websocket: {
        open: (ws) => {
          this.router.handleOpen(ws);
        },
        message: (ws, data) => {
          this.router.handleMessage(ws, data as string);
        },
        close: (ws) => {
          this.router.handleClose(ws);
        },
        perMessageDeflate: true,
      },
    });

    const protocol = this.config.enableTls ? "wss" : "ws";
    console.log(
      `[sync-server] Listening on ${protocol}://${this.config.host}:${this.config.port}`,
    );
    if (this.config.debug) {
      console.log(`[sync-server] Database: ${this.config.dbPath}`);
    }
  }

  /**
   * Stop the server.
   */
  stop(): void {
    if (this.server) {
      this.server.stop();
      this.server = null;
    }
    this.db.close();
    console.log("[sync-server] Server stopped");
  }

  /**
   * Get server stats.
   */
  getStats() {
    return this.router.getStats();
  }
}
