/**
 * HTTP route handlers for the OpenClaw Bridge.
 *
 * All routes go through auth + rate limit + circuit breaker checks
 * before reaching the handler. Audit logging happens on every request.
 */

import {
  OpenClawAdapter,
  SecurityError,
  RateLimitError,
} from "@repo/vault-client/orchestrator-adapter";
import { validateRequest } from "./auth";
import { AuditLogger } from "./audit";
import { filterResult } from "./resultFilter";
import type {
  CapabilityRequestBody,
  NoteCreateBody,
  NoteUpdateBody,
  HeartbeatBody,
  DelegateBody,
  CompletedBody,
} from "./types";

export function createRouter(adapter: OpenClawAdapter, audit: AuditLogger) {
  /** Shared middleware: auth + rate limit + audit */
  async function withAuth(
    req: Request,
    action: string,
    handler: () => Promise<Response>,
  ): Promise<Response> {
    const authHeader = req.headers.get("authorization");
    const error = validateRequest(adapter, authHeader);

    if (error) {
      audit.log({
        timestamp: new Date().toISOString(),
        action,
        details: { method: req.method, url: req.url },
        status: error.status === 429 ? "rejected" : "blocked",
      });
      return Response.json({ error: error.error }, { status: error.status });
    }

    adapter.recordRequest();

    try {
      const response = await handler();
      audit.log({
        timestamp: new Date().toISOString(),
        action,
        details: { method: req.method, url: req.url },
        status: "accepted",
      });
      return response;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Internal server error";
      const status =
        err instanceof SecurityError
          ? 403
          : err instanceof RateLimitError
            ? 429
            : 500;

      audit.log({
        timestamp: new Date().toISOString(),
        action,
        details: { method: req.method, url: req.url, error: message },
        status: status === 403 ? "blocked" : "error",
      });

      return Response.json({ error: message }, { status });
    }
  }

  /** Route dispatcher */
  return async function handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const pathname = url.pathname;
    const method = req.method;

    // Health endpoint (no auth required)
    if (method === "GET" && pathname === "/api/health") {
      const config = adapter.getConfig();
      return Response.json({
        status: config.enabled ? "ok" : "disabled",
        circuitBreaker: config.circuitBreaker.status,
        timestamp: new Date().toISOString(),
      });
    }

    // ─── Heartbeat ────────────────────────────────────────────
    if (method === "POST" && pathname === "/api/heartbeat") {
      return withAuth(req, "heartbeat", async () => {
        const body = (await req.json()) as HeartbeatBody;
        adapter.writeHeartbeat({
          version: body.version,
          gatewayPort: body.gatewayPort,
          activeChannels: body.activeChannels,
        });
        return Response.json({ status: "ok" });
      });
    }

    // ─── Capability Request ───────────────────────────────────
    if (method === "POST" && pathname === "/api/capabilities/request") {
      return withAuth(req, "capability_request", async () => {
        const body = (await req.json()) as CapabilityRequestBody;

        if (!body.capability || !body.instruction) {
          return Response.json(
            { error: "Missing capability or instruction" },
            { status: 400 },
          );
        }

        const requestId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

        adapter.submitCapabilityRequest({
          requestId,
          capability: body.capability,
          instruction: body.instruction,
          priority: body.priority,
        });

        return Response.json({
          requestId,
          status: "pending",
          message: `Capability "${body.capability}" request submitted`,
        });
      });
    }

    // ─── Capability Status ────────────────────────────────────
    if (method === "GET" && pathname.startsWith("/api/capabilities/")) {
      const parts = pathname.split("/");
      const requestId = parts[3]; // /api/capabilities/{id}/status
      if (!requestId || parts[4] !== "status") {
        return Response.json({ error: "Invalid path" }, { status: 400 });
      }

      return withAuth(req, "capability_status", async () => {
        const result = adapter.getCapabilityResult(requestId);

        // Filter the result before returning
        if (result.result) {
          result.result = filterResult(result.result);
        }

        return Response.json(result);
      });
    }

    // ─── List Notes ───────────────────────────────────────────
    if (method === "GET" && pathname === "/api/notes") {
      return withAuth(req, "notes_list", async () => {
        const notes = adapter.listNotes();
        return Response.json({
          notes: notes.map((n) => ({
            title: n.title,
            tags: n.tags,
            path: n._filePath,
            createdAt: n.createdAt,
          })),
        });
      });
    }

    // ─── Search Notes ─────────────────────────────────────────
    if (method === "GET" && pathname === "/api/notes/search") {
      return withAuth(req, "notes_search", async () => {
        const q = url.searchParams.get("q") ?? "";
        const limit = parseInt(url.searchParams.get("limit") ?? "5", 10);

        if (!q) {
          return Response.json(
            { error: "Missing query parameter 'q'" },
            { status: 400 },
          );
        }

        const results = adapter.searchNotes(q, Math.min(limit, 20));
        return Response.json({ results });
      });
    }

    // ─── Create Note ──────────────────────────────────────────
    if (method === "POST" && pathname === "/api/notes") {
      return withAuth(req, "note_create", async () => {
        const body = (await req.json()) as NoteCreateBody;

        if (!body.title || !body.content) {
          return Response.json(
            { error: "Missing title or content" },
            { status: 400 },
          );
        }

        const filePath = adapter.writeNote(
          body.title,
          body.content,
          body.tags,
        );
        return Response.json({
          status: "created",
          path: filePath,
        });
      });
    }

    // ─── Read Note ────────────────────────────────────────────
    if (method === "GET" && pathname.startsWith("/api/notes/")) {
      const notePath = pathname.replace("/api/notes/", "");
      if (!notePath) {
        return Response.json({ error: "Missing note path" }, { status: 400 });
      }

      return withAuth(req, "note_read", async () => {
        const note = adapter.readNote(decodeURIComponent(notePath));
        if (!note) {
          return Response.json({ error: "Note not found" }, { status: 404 });
        }
        return Response.json(note);
      });
    }

    // ─── Update Note ──────────────────────────────────────────
    if (method === "PUT" && pathname.startsWith("/api/notes/")) {
      const notePath = pathname.replace("/api/notes/", "");
      if (!notePath) {
        return Response.json({ error: "Missing note path" }, { status: 400 });
      }

      return withAuth(req, "note_update", async () => {
        const body = (await req.json()) as NoteUpdateBody;
        const existing = adapter.readNote(decodeURIComponent(notePath));
        if (!existing) {
          return Response.json({ error: "Note not found" }, { status: 404 });
        }

        const filePath = adapter.writeNote(
          existing.title,
          body.content ?? existing.content,
          body.tags ?? existing.tags,
        );
        return Response.json({ status: "updated", path: filePath });
      });
    }

    // ─── Delete Note ──────────────────────────────────────────
    if (method === "DELETE" && pathname.startsWith("/api/notes/")) {
      const notePath = pathname.replace("/api/notes/", "");
      if (!notePath) {
        return Response.json({ error: "Missing note path" }, { status: 400 });
      }

      return withAuth(req, "note_delete", async () => {
        const deleted = adapter.deleteNote(decodeURIComponent(notePath));
        if (!deleted) {
          return Response.json({ error: "Note not found" }, { status: 404 });
        }
        return Response.json({ status: "deleted" });
      });
    }

    // ─── Context ──────────────────────────────────────────────
    if (method === "GET" && pathname === "/api/context") {
      return withAuth(req, "context", async () => {
        const context = adapter.getFilteredContext();
        return Response.json(context);
      });
    }

    // ─── Agents ───────────────────────────────────────────────
    if (method === "GET" && pathname === "/api/agents") {
      return withAuth(req, "agents_list", async () => {
        const agents = adapter.listSpecialists();
        return Response.json({ agents });
      });
    }

    // ─── Delegate ──────────────────────────────────────────────
    if (method === "POST" && pathname === "/api/delegate") {
      return withAuth(req, "delegate", async () => {
        const body = (await req.json()) as DelegateBody;
        if (!body.instruction || !body.targetAgentId) {
          return Response.json({ error: "Missing instruction or targetAgentId" }, { status: 400 });
        }

        const taskId = adapter.delegateToHarness({
          instruction: body.instruction,
          targetHarnessType: body.targetAgentId as any,
          priority: body.priority,
          dependsOn: body.dependsOn,
          metadata: body.metadata
        });

        return Response.json({ status: "pending", taskId });
      });
    }

    // ─── Review Completed (GET) ────────────────────────────────
    if (method === "GET" && pathname === "/api/completed") {
      return withAuth(req, "completed_review", async () => {
        const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
        const tasks = adapter.getRecentCompletedTasks(Math.min(limit, 50));
        return Response.json({ tasks });
      });
    }

    // ─── Mark Completed (POST) ────────────────────────────────
    if (method === "POST" && pathname === "/api/completed") {
      return withAuth(req, "completed", async () => {
        const body = (await req.json()) as CompletedBody;
        if (!body.taskId) {
          return Response.json({ error: "Missing taskId" }, { status: 400 });
        }

        adapter.markTaskCompleted({
          taskId: body.taskId,
          result: body.result,
          error: body.error,
          status: body.status || "completed"
        });

        return Response.json({ status: "ok" });
      });
    }

    // ─── 404 ──────────────────────────────────────────────────
    return Response.json(
      { error: `Not found: ${method} ${pathname}` },
      { status: 404 },
    );
  };
}
