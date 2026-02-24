/**
 * RelayServer — Agent-aware WebSocket + REST gateway.
 *
 * Provides real-time job submission, streaming chat, event subscriptions,
 * and vault system status to any connected client.
 *
 * Pattern follows vault-sync-server/src/server.ts.
 */

import type { ServerWebSocket } from "bun";
import { AuthManager } from "./auth";
import type { ClientData } from "./clientRegistry";
import { ClientRegistry } from "./clientRegistry";
import { VaultBridge } from "./bridges/vaultBridge";
import { EventForwarder } from "./bridges/eventForwarder";
import { AgentBridge } from "./bridges/agentBridge";
import { ContextEnricher } from "./bridges/contextEnricher";
import { MemoryProcessor } from "./bridges/memoryProcessor";
import { JobHandler } from "./handlers/job";
import { ChatHandler } from "./handlers/chat";
import { SystemHandler } from "./handlers/system";
import { CommandHandler } from "./handlers/command";
import { TraceHandler } from "./handlers/trace";
import { RestRouter } from "./rest/routes";
import type { RelayServerConfig } from "./config";
import type { RelayMessage } from "@repo/agent-relay-protocol";
import { RELAY_SERVER_VERSION } from "@repo/agent-relay-protocol";

export class RelayServer {
  private config: RelayServerConfig;
  private server: ReturnType<typeof Bun.serve> | null = null;

  private auth: AuthManager;
  private registry: ClientRegistry;
  private bridge: VaultBridge;
  private forwarder: EventForwarder;
  private agentBridge: AgentBridge;
  private jobHandler: JobHandler;
  private chatHandler: ChatHandler;
  private systemHandler: SystemHandler;
  private commandHandler: CommandHandler;
  private traceHandler: TraceHandler;
  private restRouter: RestRouter;

  constructor(config: RelayServerConfig) {
    this.config = config;
    this.auth = new AuthManager(config);
    this.registry = new ClientRegistry();
    this.bridge = new VaultBridge(config.vaultPath);
    this.forwarder = new EventForwarder(this.registry, this.bridge, config.debug);
    this.agentBridge = new AgentBridge(this.registry, config.debug);
    this.jobHandler = new JobHandler(this.registry, this.bridge, config.debug);
    this.chatHandler = new ChatHandler(
      this.bridge,
      this.agentBridge,
      new ContextEnricher(this.bridge),
      new MemoryProcessor(this.bridge),
      config.debug,
    );
    this.systemHandler = new SystemHandler(this.registry, this.bridge, config.debug);
    this.commandHandler = new CommandHandler(this.bridge, config.debug);
    this.traceHandler = new TraceHandler(this.bridge, config.debug);
    this.restRouter = new RestRouter(this.bridge, this.auth, this.registry);
  }

  async start(): Promise<void> {
    // Initialize vault sync engine
    await this.bridge.initSync();

    // Start event forwarding and job status tracking
    this.forwarder.start();
    this.jobHandler.start();

    // Connect to agent's WS server (non-blocking, retries automatically)
    this.agentBridge.connect().catch(() => {});

    const {
      auth,
      registry,
      jobHandler,
      chatHandler,
      systemHandler,
      commandHandler,
      traceHandler,
      restRouter,
      config,
    } = this;

    this.server = Bun.serve<ClientData>({
      port: config.port,
      hostname: config.host,

      async fetch(req, server) {
        const url = new URL(req.url);

        // Try REST routes first
        const restResponse = await restRouter.handle(req);
        if (restResponse) return restResponse;

        // WebSocket upgrade
        if (server.upgrade(req, { data: {} as ClientData })) {
          return;
        }

        return new Response("Agent HQ Relay Server", { status: 200 });
      },

      websocket: {
        open(ws) {
          if (config.debug) {
            console.log(`[relay-server] Client connected: ${ws.remoteAddress}`);
          }
        },

        message(ws, data) {
          let msg: RelayMessage;
          try {
            msg = JSON.parse(data as string) as RelayMessage;
          } catch {
            ws.send(
              JSON.stringify({
                type: "error",
                code: "INVALID_JSON",
                message: "Could not parse message",
              }),
            );
            return;
          }

          // ── Auth handshake ──────────────────────────────────────
          if (msg.type === "auth") {
            const sessionToken = auth.validateApiKey(
              msg.apiKey,
              msg.clientId,
              msg.clientType,
            );

            if (!sessionToken) {
              ws.send(
                JSON.stringify({
                  type: "auth-ack",
                  success: false,
                  error: "Invalid API key",
                  serverVersion: RELAY_SERVER_VERSION,
                }),
              );
              ws.close(1008, "Unauthorized");
              return;
            }

            const clientData: ClientData = {
              sessionToken,
              clientId: msg.clientId ?? "anonymous",
              clientType: msg.clientType ?? "unknown",
              connectedAt: Date.now(),
              subscriptions: new Set(),
            };

            registry.add(ws, clientData);

            ws.send(
              JSON.stringify({
                type: "auth-ack",
                success: true,
                sessionToken,
                serverVersion: RELAY_SERVER_VERSION,
              }),
            );

            if (config.debug) {
              console.log(
                `[relay-server] Authenticated: ${clientData.clientId} (${clientData.clientType})`,
              );
            }
            return;
          }

          // ── Require authentication ──────────────────────────────
          if (!ws.data?.sessionToken) {
            ws.send(
              JSON.stringify({
                type: "error",
                code: "NOT_AUTHENTICATED",
                message: "Send auth message first",
              }),
            );
            return;
          }

          // ── Route to handlers ───────────────────────────────────
          switch (msg.type) {
            case "ping":
              ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
              break;

            case "job:submit":
              jobHandler.handleSubmit(ws, msg);
              break;

            case "job:cancel":
              jobHandler.handleCancel(ws, msg);
              break;

            case "chat:send":
              chatHandler.handleChatSend(ws, msg);
              break;

            case "chat:abort":
              chatHandler.handleChatAbort(ws, msg);
              break;

            case "system:status":
              systemHandler.handleStatus(ws);
              break;

            case "system:subscribe":
              systemHandler.handleSubscribe(ws, msg);
              break;

            case "cmd:execute":
              commandHandler.handleCommand(ws, msg);
              break;

            case "trace:status":
              traceHandler.handleStatus(ws, msg);
              break;

            case "trace:cancel-task":
              traceHandler.handleCancelTask(ws, msg);
              break;

            default:
              ws.send(
                JSON.stringify({
                  type: "error",
                  code: "UNKNOWN_MESSAGE_TYPE",
                  message: `Unknown message type: ${(msg as any).type}`,
                }),
              );
          }
        },

        close(ws) {
          const data = ws.data;
          if (data?.sessionToken) {
            auth.removeSession(data.sessionToken);
            registry.remove(ws);
            if (config.debug) {
              console.log(`[relay-server] Disconnected: ${data.clientId}`);
            }
          }
        },

        perMessageDeflate: true,
      },
    });

    console.log(`[relay-server] Listening on ws://${config.host}:${config.port}`);
    if (config.debug) {
      console.log(`[relay-server] Vault: ${config.vaultPath}`);
      console.log(`[relay-server] API key configured: ${!!config.apiKey}`);
      console.log(
        `[relay-server] Agent bridge: ws://127.0.0.1:${process.env.AGENT_WS_PORT ?? 5678}`,
      );
    }
  }

  stop(): void {
    this.forwarder.stop();
    this.agentBridge.disconnect();
    if (this.server) {
      this.server.stop();
      this.server = null;
    }
    this.bridge.stopSync().catch(() => {});
    console.log("[relay-server] Server stopped");
  }

  getStats() {
    return {
      connectedClients: this.registry.size,
      agentBridgeConnected: this.agentBridge.isConnected,
      vaultPath: this.config.vaultPath,
      port: this.config.port,
    };
  }
}
