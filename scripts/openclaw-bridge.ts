/**
 * OpenClaw Bridge — HTTP server for the OpenClaw integration.
 *
 * Embedded in the daemon process via startBridge().
 * Listens on localhost:18790, serves the sandboxed OpenClaw API.
 */

import { OpenClawAdapter } from "@repo/vault-client/openclaw-adapter";
import { AuditLogger } from "./openclaw-bridge/audit";
import { createRouter } from "./openclaw-bridge/routes";

const DEFAULT_PORT = 18790;

export interface BridgeContext {
  adapter: OpenClawAdapter;
  audit: AuditLogger;
  server: ReturnType<typeof Bun.serve> | null;
}

/**
 * Start the OpenClaw Bridge HTTP server.
 * Called by the daemon on startup.
 *
 * @param vaultPath - Absolute path to the .vault/ directory
 * @param port - Port to listen on (default 18790)
 * @returns BridgeContext for monitoring and shutdown
 */
export function startBridge(
  vaultPath: string,
  port: number = DEFAULT_PORT,
): BridgeContext {
  const adapter = new OpenClawAdapter(vaultPath);
  adapter.ensureDirectories();

  const audit = new AuditLogger(adapter.auditPath);
  const router = createRouter(adapter, audit);

  const config = adapter.getConfig();
  if (!config.enabled) {
    console.log(
      "[openclaw-bridge] Integration is disabled in config. Bridge will start but reject all requests.",
    );
    console.log(
      "[openclaw-bridge] Enable it by setting `enabled: true` in .vault/_external/openclaw/_config.md",
    );
  }

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1", // localhost only — never expose externally
    fetch: router,
  });

  console.log(
    `[openclaw-bridge] Listening on http://127.0.0.1:${server.port}`,
  );

  return { adapter, audit, server };
}

/**
 * Stop the Bridge server gracefully.
 */
export function stopBridge(ctx: BridgeContext): void {
  if (ctx.server) {
    ctx.server.stop();
    console.log("[openclaw-bridge] Server stopped");
  }
}
