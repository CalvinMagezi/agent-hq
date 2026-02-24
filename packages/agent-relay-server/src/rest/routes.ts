/**
 * REST API routes for the relay server.
 *
 * Provides HTTP endpoints for clients that prefer REST over WebSocket.
 */

import type { VaultBridge } from "../bridges/vaultBridge";
import type { AuthManager } from "../auth";
import type { ClientRegistry } from "../clientRegistry";
import { RELAY_SERVER_VERSION } from "@repo/agent-relay-protocol";

export class RestRouter {
  private bridge: VaultBridge;
  private auth: AuthManager;
  private registry: ClientRegistry;
  private startTime = Date.now();

  constructor(bridge: VaultBridge, auth: AuthManager, registry: ClientRegistry) {
    this.bridge = bridge;
    this.auth = auth;
    this.registry = registry;
  }

  async handle(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // ─── Health (no auth required) ──────────────────────────────────
    if (path === "/health" && method === "GET") {
      return this.json({ status: "ok", version: RELAY_SERVER_VERSION });
    }

    // ─── Auth check for /api/* ───────────────────────────────────────
    if (path.startsWith("/api/")) {
      if (!this.auth.validateBearer(req.headers.get("Authorization"))) {
        return this.json({ error: "Unauthorized" }, 401);
      }
    }

    // ─── Status ─────────────────────────────────────────────────────
    if (path === "/api/status" && method === "GET") {
      const { pendingJobs, runningJobs, agentOnline } =
        await this.bridge.getSystemStatus();
      return this.json({
        status: "healthy",
        agentOnline,
        pendingJobs,
        runningJobs,
        connectedClients: this.registry.size,
        vaultPath: this.bridge.vaultDir,
        serverVersion: RELAY_SERVER_VERSION,
        uptime: Math.floor((Date.now() - this.startTime) / 1000),
      });
    }

    // ─── Jobs ────────────────────────────────────────────────────────
    if (path === "/api/jobs" && method === "POST") {
      let body: any;
      try {
        body = await req.json();
      } catch {
        return this.json({ error: "Invalid JSON body" }, 400);
      }

      if (!body.instruction) {
        return this.json({ error: "instruction is required" }, 400);
      }

      const jobId = await this.bridge.createJob({
        instruction: body.instruction,
        type: body.jobType ?? "background",
        priority: body.priority ?? 50,
        securityProfile: body.securityProfile ?? "standard",
        modelOverride: body.modelOverride,
        threadId: body.threadId,
      });

      return this.json({ jobId, status: "pending", createdAt: new Date().toISOString() }, 201);
    }

    if (path.startsWith("/api/jobs/") && method === "GET") {
      const jobId = path.slice("/api/jobs/".length);
      if (!jobId) return this.json({ error: "Job ID required" }, 400);

      const job = await this.bridge.getJob(jobId);
      if (!job) return this.json({ error: "Job not found" }, 404);

      return this.json(job);
    }

    if (path.startsWith("/api/jobs/") && path.endsWith("/cancel") && method === "POST") {
      const jobId = path.slice("/api/jobs/".length).replace("/cancel", "");
      if (!jobId) return this.json({ error: "Job ID required" }, 400);

      try {
        await this.bridge.client.updateJobStatus(jobId, "failed" as any, {
          result: "Cancelled via API",
        });
        return this.json({ jobId, status: "cancelled" });
      } catch {
        return this.json({ error: "Failed to cancel job" }, 500);
      }
    }

    // ─── Chat (non-streaming) ────────────────────────────────────────
    if (path === "/api/chat" && method === "POST") {
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        return this.json({ error: "OPENROUTER_API_KEY not configured" }, 503);
      }

      let body: any;
      try {
        body = await req.json();
      } catch {
        return this.json({ error: "Invalid JSON body" }, 400);
      }

      if (!body.content) {
        return this.json({ error: "content is required" }, 400);
      }

      try {
        const model = body.modelOverride ?? process.env.DEFAULT_MODEL ?? "moonshotai/kimi-k2.5";
        const ctx = await this.bridge.getAgentContext();
        const systemParts: string[] = [];
        if (ctx.soul) systemParts.push(ctx.soul);
        if (ctx.memory) systemParts.push(`## Memory\n${ctx.memory}`);

        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://agent-hq.local",
            "X-Title": "Agent HQ Relay REST",
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: systemParts.join("\n\n") },
              { role: "user", content: body.content },
            ],
          }),
        });

        if (!response.ok) {
          const errText = await response.text();
          return this.json({ error: `API error: ${errText}` }, 502);
        }

        const data = await response.json() as any;
        const content = data.choices?.[0]?.message?.content ?? "";
        return this.json({
          content,
          model,
          usage: data.usage,
        });
      } catch (err) {
        return this.json({
          error: err instanceof Error ? err.message : "Chat failed",
        }, 500);
      }
    }

    // ─── Notes ───────────────────────────────────────────────────────
    if (path === "/api/notes/search" && method === "GET") {
      const q = url.searchParams.get("q");
      if (!q) return this.json({ error: "q parameter required" }, 400);

      const limit = parseInt(url.searchParams.get("limit") ?? "10", 10);
      const results = await this.bridge.searchNotes(q, limit);
      return this.json({ results });
    }

    // ─── Threads ─────────────────────────────────────────────────────
    if (path === "/api/threads" && method === "GET") {
      const threads = await this.bridge.listThreads();
      return this.json({ threads });
    }

    return null; // Not handled — let Bun.serve handle it
  }

  private json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
}
