/**
 * TraceDB — SQLite-backed distributed trace store for HQ orchestration.
 *
 * Tracks the full lifecycle of orchestration flows:
 *   Job → Delegation spans → Relay execution spans → Span events (timeline)
 *
 * Database: .vault/_embeddings/trace.db
 * Uses bun:sqlite with WAL mode for concurrent read performance.
 */

import { Database } from "bun:sqlite";
import * as fs from "fs";
import * as path from "path";

// ─── Types ──────────────────────────────────────────────────────

export type TraceStatus = "active" | "completed" | "failed" | "cancelled";
export type SpanType = "job" | "delegation" | "relay_exec";
export type SpanStatus = "active" | "completed" | "failed" | "cancelled";
export type SpanEventType =
  | "started"
  | "claimed"
  | "progress"
  | "completed"
  | "failed"
  | "cancelled"
  | "constraint_violation";

export interface Trace {
  traceId: string;
  jobId: string;
  rootInstruction: string | null;
  status: TraceStatus;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  startedAt: number;
  completedAt: number | null;
}

export interface Span {
  spanId: string;
  traceId: string;
  parentSpanId: string | null;
  taskId: string | null;
  type: SpanType;
  name: string;
  status: SpanStatus;
  claimedBy: string | null;
  startedAt: number;
  completedAt: number | null;
  metadata: Record<string, unknown> | null;
}

export interface SpanEvent {
  eventId: number;
  spanId: string;
  traceId: string;
  timestamp: number;
  eventType: SpanEventType;
  message: string | null;
  metadata: Record<string, unknown> | null;
}

export interface TraceTree extends Trace {
  spans: Array<Span & { events: SpanEvent[] }>;
}

// ─── TraceDB ────────────────────────────────────────────────────

export class TraceDB {
  private db: Database;
  private vaultPath: string;

  constructor(vaultPath: string) {
    this.vaultPath = path.resolve(vaultPath);
    const dbPath = path.join(this.vaultPath, "_embeddings", "trace.db");
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS traces (
        traceId TEXT PRIMARY KEY,
        jobId TEXT NOT NULL,
        rootInstruction TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        totalTasks INTEGER NOT NULL DEFAULT 0,
        completedTasks INTEGER NOT NULL DEFAULT 0,
        failedTasks INTEGER NOT NULL DEFAULT 0,
        startedAt INTEGER NOT NULL,
        completedAt INTEGER
      );

      CREATE TABLE IF NOT EXISTS spans (
        spanId TEXT PRIMARY KEY,
        traceId TEXT NOT NULL,
        parentSpanId TEXT,
        taskId TEXT,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        claimedBy TEXT,
        startedAt INTEGER NOT NULL,
        completedAt INTEGER,
        metadata TEXT,
        FOREIGN KEY (traceId) REFERENCES traces(traceId)
      );

      CREATE TABLE IF NOT EXISTS span_events (
        eventId INTEGER PRIMARY KEY AUTOINCREMENT,
        spanId TEXT NOT NULL,
        traceId TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        eventType TEXT NOT NULL,
        message TEXT,
        metadata TEXT,
        FOREIGN KEY (spanId) REFERENCES spans(spanId)
      );

      CREATE INDEX IF NOT EXISTS idx_spans_trace ON spans(traceId);
      CREATE INDEX IF NOT EXISTS idx_spans_task ON spans(taskId);
      CREATE INDEX IF NOT EXISTS idx_span_events_span ON span_events(spanId);
      CREATE INDEX IF NOT EXISTS idx_span_events_trace ON span_events(traceId);
      CREATE INDEX IF NOT EXISTS idx_traces_job ON traces(jobId);
      CREATE INDEX IF NOT EXISTS idx_traces_status ON traces(status);
    `);
  }

  // ─── Trace Lifecycle ────────────────────────────────────────

  /** Create a new trace for an orchestration flow. Returns traceId. */
  createTrace(jobId: string, instruction: string): string {
    const traceId = `trace-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    this.db.prepare(`
      INSERT INTO traces (traceId, jobId, rootInstruction, status, startedAt)
      VALUES ($traceId, $jobId, $rootInstruction, 'active', $startedAt)
    `).run({
      $traceId: traceId,
      $jobId: jobId,
      $rootInstruction: instruction.substring(0, 200),
      $startedAt: Date.now(),
    });
    return traceId;
  }

  /** Complete a trace with final status. */
  completeTrace(traceId: string, status: Exclude<TraceStatus, "active">): void {
    this.db.prepare(`
      UPDATE traces SET status = $status, completedAt = $completedAt
      WHERE traceId = $traceId
    `).run({ $traceId: traceId, $status: status, $completedAt: Date.now() });
  }

  /** Increment task counters on a trace. */
  updateTraceCounts(traceId: string, delta: { total?: number; completed?: number; failed?: number }): void {
    if (delta.total) {
      this.db.prepare(`
        UPDATE traces SET totalTasks = totalTasks + $delta WHERE traceId = $traceId
      `).run({ $traceId: traceId, $delta: delta.total });
    }
    if (delta.completed) {
      this.db.prepare(`
        UPDATE traces SET completedTasks = completedTasks + $delta WHERE traceId = $traceId
      `).run({ $traceId: traceId, $delta: delta.completed });
    }
    if (delta.failed) {
      this.db.prepare(`
        UPDATE traces SET failedTasks = failedTasks + $delta WHERE traceId = $traceId
      `).run({ $traceId: traceId, $delta: delta.failed });
    }
  }

  getTrace(traceId: string): Trace | null {
    const row = this.db.prepare(`SELECT * FROM traces WHERE traceId = $traceId`).get({ $traceId: traceId }) as any;
    return row ? this.rowToTrace(row) : null;
  }

  getTraceByJob(jobId: string): Trace | null {
    const row = this.db.prepare(`SELECT * FROM traces WHERE jobId = $jobId ORDER BY startedAt DESC LIMIT 1`).get({ $jobId: jobId }) as any;
    return row ? this.rowToTrace(row) : null;
  }

  getActiveTraces(): Trace[] {
    const rows = this.db.prepare(`SELECT * FROM traces WHERE status = 'active' ORDER BY startedAt DESC`).all() as any[];
    return rows.map(this.rowToTrace);
  }

  getRecentTraces(limit = 10): Trace[] {
    const rows = this.db.prepare(`SELECT * FROM traces ORDER BY startedAt DESC LIMIT $limit`).all({ $limit: limit }) as any[];
    return rows.map(this.rowToTrace);
  }

  // ─── Span Lifecycle ─────────────────────────────────────────

  /** Create a span within a trace. Returns spanId. */
  createSpan(opts: {
    traceId: string;
    parentSpanId?: string;
    taskId?: string;
    type: SpanType;
    name: string;
    metadata?: Record<string, unknown>;
  }): string {
    const spanId = `span-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    this.db.prepare(`
      INSERT INTO spans (spanId, traceId, parentSpanId, taskId, type, name, status, startedAt, metadata)
      VALUES ($spanId, $traceId, $parentSpanId, $taskId, $type, $name, 'active', $startedAt, $metadata)
    `).run({
      $spanId: spanId,
      $traceId: opts.traceId,
      $parentSpanId: opts.parentSpanId ?? null,
      $taskId: opts.taskId ?? null,
      $type: opts.type,
      $name: opts.name,
      $startedAt: Date.now(),
      $metadata: opts.metadata ? JSON.stringify(opts.metadata) : null,
    });
    return spanId;
  }

  /** Update fields on a span. */
  updateSpan(spanId: string, updates: Partial<Pick<Span, "claimedBy" | "metadata">>): void {
    if (updates.claimedBy !== undefined) {
      this.db.prepare(`UPDATE spans SET claimedBy = $claimedBy WHERE spanId = $spanId`)
        .run({ $spanId: spanId, $claimedBy: updates.claimedBy });
    }
    if (updates.metadata !== undefined) {
      this.db.prepare(`UPDATE spans SET metadata = $metadata WHERE spanId = $spanId`)
        .run({ $spanId: spanId, $metadata: JSON.stringify(updates.metadata) });
    }
  }

  /** Complete a span with final status. */
  completeSpan(spanId: string, status: Exclude<SpanStatus, "active">): void {
    this.db.prepare(`
      UPDATE spans SET status = $status, completedAt = $completedAt WHERE spanId = $spanId
    `).run({ $spanId: spanId, $status: status, $completedAt: Date.now() });
  }

  getSpan(spanId: string): Span | null {
    const row = this.db.prepare(`SELECT * FROM spans WHERE spanId = $spanId`).get({ $spanId: spanId }) as any;
    return row ? this.rowToSpan(row) : null;
  }

  getSpanByTaskId(taskId: string): Span | null {
    const row = this.db.prepare(`SELECT * FROM spans WHERE taskId = $taskId ORDER BY startedAt DESC LIMIT 1`).get({ $taskId: taskId }) as any;
    return row ? this.rowToSpan(row) : null;
  }

  getSpansForTrace(traceId: string): Span[] {
    const rows = this.db.prepare(`SELECT * FROM spans WHERE traceId = $traceId ORDER BY startedAt ASC`).all({ $traceId: traceId }) as any[];
    return rows.map(this.rowToSpan);
  }

  // ─── Span Events ────────────────────────────────────────────

  /** Append an event to a span's timeline. */
  addSpanEvent(
    spanId: string,
    traceId: string,
    eventType: SpanEventType,
    message?: string,
    metadata?: Record<string, unknown>,
  ): void {
    this.db.prepare(`
      INSERT INTO span_events (spanId, traceId, timestamp, eventType, message, metadata)
      VALUES ($spanId, $traceId, $timestamp, $eventType, $message, $metadata)
    `).run({
      $spanId: spanId,
      $traceId: traceId,
      $timestamp: Date.now(),
      $eventType: eventType,
      $message: message ?? null,
      $metadata: metadata ? JSON.stringify(metadata) : null,
    });
  }

  getSpanEvents(spanId: string): SpanEvent[] {
    const rows = this.db.prepare(`SELECT * FROM span_events WHERE spanId = $spanId ORDER BY timestamp ASC`).all({ $spanId: spanId }) as any[];
    return rows.map(this.rowToSpanEvent);
  }

  getTraceEvents(traceId: string): SpanEvent[] {
    const rows = this.db.prepare(`SELECT * FROM span_events WHERE traceId = $traceId ORDER BY timestamp ASC`).all({ $traceId: traceId }) as any[];
    return rows.map(this.rowToSpanEvent);
  }

  // ─── Full Tree ──────────────────────────────────────────────

  /** Reconstruct the full trace tree with all spans and their events. */
  getTraceTree(traceId: string): TraceTree | null {
    const trace = this.getTrace(traceId);
    if (!trace) return null;

    const spans = this.getSpansForTrace(traceId);
    const spansWithEvents = spans.map((span) => ({
      ...span,
      events: this.getSpanEvents(span.spanId),
    }));

    return { ...trace, spans: spansWithEvents };
  }

  // ─── Row Mappers ────────────────────────────────────────────

  private rowToTrace(row: any): Trace {
    return {
      traceId: row.traceId,
      jobId: row.jobId,
      rootInstruction: row.rootInstruction,
      status: row.status as TraceStatus,
      totalTasks: row.totalTasks,
      completedTasks: row.completedTasks,
      failedTasks: row.failedTasks,
      startedAt: row.startedAt,
      completedAt: row.completedAt ?? null,
    };
  }

  private rowToSpan(row: any): Span {
    return {
      spanId: row.spanId,
      traceId: row.traceId,
      parentSpanId: row.parentSpanId ?? null,
      taskId: row.taskId ?? null,
      type: row.type as SpanType,
      name: row.name,
      status: row.status as SpanStatus,
      claimedBy: row.claimedBy ?? null,
      startedAt: row.startedAt,
      completedAt: row.completedAt ?? null,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
    };
  }

  private rowToSpanEvent(row: any): SpanEvent {
    return {
      eventId: row.eventId,
      spanId: row.spanId,
      traceId: row.traceId,
      timestamp: row.timestamp,
      eventType: row.eventType as SpanEventType,
      message: row.message ?? null,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
    };
  }

  close(): void {
    this.db.close();
  }
}
