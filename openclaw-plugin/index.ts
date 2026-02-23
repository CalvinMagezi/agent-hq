/**
 * Agent-HQ Bridge — OpenClaw Plugin
 *
 * Connects OpenClaw to Agent-HQ's secure delegation system.
 * OpenClaw can request Google Workspace operations (and other capabilities)
 * via HQ's relay harnesses, without direct access to Google APIs or HQ internals.
 *
 * Installation:
 *   openclaw plugins install ./openclaw-plugin
 *
 * Configuration:
 *   Set AGENT_HQ_BRIDGE_URL and AGENT_HQ_BRIDGE_TOKEN in OpenClaw env,
 *   or configure via plugin settings.
 */

import { AgentHQClient } from "./src/client";
import { registerTools } from "./src/tools";

/**
 * OpenClaw Plugin API interface (minimal subset).
 * The full API is provided by @openclaw/sdk at runtime.
 */
interface PluginAPI {
  registerTool(tool: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (args: Record<string, unknown>) => Promise<string>;
  }): void;
  getConfig(): { bridgeUrl?: string; token?: string };
  onUnload(callback: () => void): void;
}

export function register(api: PluginAPI): void {
  const pluginConfig = api.getConfig();

  const bridgeUrl =
    pluginConfig.bridgeUrl ??
    process.env.AGENT_HQ_BRIDGE_URL ??
    "http://127.0.0.1:18790";

  const token =
    pluginConfig.token ??
    process.env.AGENT_HQ_BRIDGE_TOKEN ??
    "";

  if (!token) {
    console.warn(
      "[agent-hq-bridge] No token configured. Set AGENT_HQ_BRIDGE_TOKEN or configure plugin token.",
    );
    console.warn(
      "[agent-hq-bridge] The token is in .vault/_external/openclaw/_config.md",
    );
    return;
  }

  const client = new AgentHQClient({ bridgeUrl, token });

  // Register all agent tools
  registerTools(api as Parameters<typeof registerTools>[0], client);

  // Start heartbeat loop (every 30 seconds)
  const heartbeatInterval = setInterval(() => {
    client.heartbeat().catch((err) => {
      console.warn(
        "[agent-hq-bridge] Heartbeat failed:",
        err instanceof Error ? err.message : String(err),
      );
    });
  }, 30_000);

  // Send initial heartbeat
  client
    .heartbeat()
    .then(() => {
      console.log(
        `[agent-hq-bridge] Connected to Agent-HQ at ${bridgeUrl}`,
      );
    })
    .catch((err) => {
      console.warn(
        "[agent-hq-bridge] Initial heartbeat failed (is the daemon running?):",
        err instanceof Error ? err.message : String(err),
      );
    });

  // Cleanup on unload
  api.onUnload(() => {
    clearInterval(heartbeatInterval);
    console.log("[agent-hq-bridge] Plugin unloaded");
  });

  console.log("[agent-hq-bridge] Plugin loaded");
}
