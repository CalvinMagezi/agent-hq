/**
 * Session Store — SQLite persistence for infinite sessions.
 *
 * Database: .vault/_embeddings/sessions.db
 * Pattern: Same as TraceDB (bun:sqlite, WAL mode, prepare().run())
 */

import { Database } from "bun:sqlite";
import * as path from "path";
import * as fs from "fs";
import { randomUUID } from "crypto";
import type {
  Session,
  SessionSurface,
  SessionMessage,
  Checkpoint,
  CheckpointFact,
  CheckpointToolResult,
  SurfaceType,
  SessionStatus,
  MessageStatus,
} from "./types.js";

const SCHEMA_VERSION = 1;

export class SessionStore {
  private db: Database;

  constructor(vaultPath: string) {
    const dbDir = path.join(vaultPath, "_embeddings");
    fs.mkdirSync(dbDir, { recursive: true });

    const dbPath = path.join(dbDir, "sessions.db");
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");

    this.migrate();
  }

  // ─── Sessions ───────────────────────────────────────────────

  createSession(opts: {
    model: string;
    threadId?: string;
    resumedFrom?: string;
  }): Session {
    const sessionId = `session-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const threadId = opts.threadId ?? sessionId;
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO sessions (session_id, thread_id, status, model, checkpoint_count,
         current_segment, message_count, created_at, last_active_at, resumed_from)
         VALUES ($sessionId, $threadId, $status, $model, $checkpointCount,
         $currentSegment, $messageCount, $createdAt, $lastActiveAt, $resumedFrom)`
      )
      .run({
        $sessionId: sessionId,
        $threadId: threadId,
        $status: "active",
        $model: opts.model,
        $checkpointCount: 0,
        $currentSegment: 0,
        $messageCount: 0,
        $createdAt: now,
        $lastActiveAt: now,
        $resumedFrom: opts.resumedFrom ?? null,
      });

    return {
      sessionId,
      threadId,
      status: "active",
      model: opts.model,
      checkpointCount: 0,
      currentSegment: 0,
      messageCount: 0,
      createdAt: now,
      lastActiveAt: now,
      resumedFrom: opts.resumedFrom,
    };
  }

  getSession(sessionId: string): Session | null {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE session_id = $sessionId")
      .get({ $sessionId: sessionId }) as any;

    return row ? this.rowToSession(row) : null;
  }

  updateSession(
    sessionId: string,
    updates: Partial<Pick<Session, "status" | "model" | "checkpointCount" | "currentSegment" | "messageCount">>
  ): void {
    const sets: string[] = [];
    const params: Record<string, any> = { $sessionId: sessionId };

    if (updates.status !== undefined) {
      sets.push("status = $status");
      params.$status = updates.status;
    }
    if (updates.model !== undefined) {
      sets.push("model = $model");
      params.$model = updates.model;
    }
    if (updates.checkpointCount !== undefined) {
      sets.push("checkpoint_count = $checkpointCount");
      params.$checkpointCount = updates.checkpointCount;
    }
    if (updates.currentSegment !== undefined) {
      sets.push("current_segment = $currentSegment");
      params.$currentSegment = updates.currentSegment;
    }
    if (updates.messageCount !== undefined) {
      sets.push("message_count = $messageCount");
      params.$messageCount = updates.messageCount;
    }

    sets.push("last_active_at = $lastActiveAt");
    params.$lastActiveAt = new Date().toISOString();

    if (sets.length > 0) {
      this.db
        .prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE session_id = $sessionId`)
        .run(params);
    }
  }

  getActiveSessions(): Session[] {
    const rows = this.db
      .prepare("SELECT * FROM sessions WHERE status = 'active' ORDER BY last_active_at DESC")
      .all() as any[];
    return rows.map((r) => this.rowToSession(r));
  }

  // ─── Messages ───────────────────────────────────────────────

  /** Append a message. Returns the assigned seq number. */
  appendMessage(
    sessionId: string,
    msg: {
      segmentIndex: number;
      role: "user" | "assistant";
      surface: SurfaceType;
      content: string;
      replyToSeq?: number;
      status?: MessageStatus;
      tokens?: number;
    }
  ): number {
    const now = new Date().toISOString();

    const result = this.db
      .prepare(
        `INSERT INTO messages (session_id, segment_index, role, surface, content,
         timestamp, tokens, reply_to_seq, status)
         VALUES ($sessionId, $segmentIndex, $role, $surface, $content,
         $timestamp, $tokens, $replyToSeq, $status)`
      )
      .run({
        $sessionId: sessionId,
        $segmentIndex: msg.segmentIndex,
        $role: msg.role,
        $surface: msg.surface,
        $content: msg.content,
        $timestamp: now,
        $tokens: msg.tokens ?? null,
        $replyToSeq: msg.replyToSeq ?? null,
        $status: msg.status ?? "final",
      });

    // Update session message count and last active
    this.db
      .prepare(
        `UPDATE sessions SET message_count = message_count + 1, last_active_at = $now
         WHERE session_id = $sessionId`
      )
      .run({ $sessionId: sessionId, $now: now });

    return Number(result.lastInsertRowid);
  }

  /** Get messages since a given seq (for catch-up and interrupt detection). */
  getMessagesSince(sessionId: string, sinceSeq: number, limit: number = 100): SessionMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE session_id = $sessionId AND seq > $sinceSeq
         ORDER BY seq ASC LIMIT $limit`
      )
      .all({ $sessionId: sessionId, $sinceSeq: sinceSeq, $limit: limit }) as any[];
    return rows.map((r) => this.rowToMessage(r));
  }

  /** Get all messages for a segment (for checkpoint creation). */
  getSegmentMessages(sessionId: string, segmentIndex: number): SessionMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE session_id = $sessionId AND segment_index = $segmentIndex
         ORDER BY seq ASC`
      )
      .all({ $sessionId: sessionId, $segmentIndex: segmentIndex }) as any[];
    return rows.map((r) => this.rowToMessage(r));
  }

  /** Get the N most recent messages for a session. */
  getRecentMessages(sessionId: string, limit: number): SessionMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE session_id = $sessionId
         ORDER BY seq DESC LIMIT $limit`
      )
      .all({ $sessionId: sessionId, $limit: limit }) as any[];
    return rows.map((r) => this.rowToMessage(r)).reverse();
  }

  /** Search messages via FTS5. */
  searchMessages(sessionId: string, query: string, limit: number = 10): SessionMessage[] {
    const rows = this.db
      .prepare(
        `SELECT m.* FROM messages m
         JOIN messages_fts f ON m.seq = f.rowid
         WHERE f.messages_fts MATCH $query AND m.session_id = $sessionId
         ORDER BY rank LIMIT $limit`
      )
      .all({ $sessionId: sessionId, $query: query, $limit: limit }) as any[];
    return rows.map((r) => this.rowToMessage(r));
  }

  // ─── Checkpoints ────────────────────────────────────────────

  saveCheckpoint(checkpoint: Checkpoint): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO checkpoints
         (checkpoint_id, session_id, segment_index, summary, key_facts, active_goals,
          tool_results, message_seq_start, message_seq_end, token_count, model, created_at)
         VALUES ($checkpointId, $sessionId, $segmentIndex, $summary, $keyFacts, $activeGoals,
          $toolResults, $messageSeqStart, $messageSeqEnd, $tokenCount, $model, $createdAt)`
      )
      .run({
        $checkpointId: checkpoint.checkpointId,
        $sessionId: checkpoint.sessionId,
        $segmentIndex: checkpoint.segmentIndex,
        $summary: checkpoint.summary,
        $keyFacts: JSON.stringify(checkpoint.keyFacts),
        $activeGoals: JSON.stringify(checkpoint.activeGoals),
        $toolResults: checkpoint.toolResults ? JSON.stringify(checkpoint.toolResults) : null,
        $messageSeqStart: checkpoint.messageSeqStart,
        $messageSeqEnd: checkpoint.messageSeqEnd,
        $tokenCount: checkpoint.tokenCount,
        $model: checkpoint.model,
        $createdAt: checkpoint.createdAt,
      });

    // Update FTS index
    this.db
      .prepare(
        `INSERT OR REPLACE INTO checkpoints_fts (rowid, session_id, summary, key_facts)
         VALUES ($rowid, $sessionId, $summary, $keyFacts)`
      )
      .run({
        $rowid: checkpoint.segmentIndex,
        $sessionId: checkpoint.sessionId,
        $summary: checkpoint.summary,
        $keyFacts: JSON.stringify(checkpoint.keyFacts),
      });
  }

  getCheckpoints(sessionId: string): Checkpoint[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM checkpoints WHERE session_id = $sessionId ORDER BY segment_index ASC"
      )
      .all({ $sessionId: sessionId }) as any[];
    return rows.map((r) => this.rowToCheckpoint(r));
  }

  searchCheckpoints(sessionId: string, query: string, limit: number = 5): Checkpoint[] {
    const rows = this.db
      .prepare(
        `SELECT c.* FROM checkpoints c
         JOIN checkpoints_fts f ON c.segment_index = f.rowid AND c.session_id = f.session_id
         WHERE f.checkpoints_fts MATCH $query AND c.session_id = $sessionId
         ORDER BY rank LIMIT $limit`
      )
      .all({ $sessionId: sessionId, $query: query, $limit: limit }) as any[];
    return rows.map((r) => this.rowToCheckpoint(r));
  }

  // ─── Surface Links ──────────────────────────────────────────

  linkSurface(sessionId: string, surface: SurfaceType, channelId: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO surface_links (surface, channel_id, session_id, linked_at, last_seen_seq)
         VALUES ($surface, $channelId, $sessionId, $linkedAt, $lastSeenSeq)`
      )
      .run({
        $surface: surface,
        $channelId: channelId,
        $sessionId: sessionId,
        $linkedAt: new Date().toISOString(),
        $lastSeenSeq: 0,
      });
  }

  getSessionBySurface(surface: SurfaceType, channelId: string): Session | null {
    const link = this.db
      .prepare(
        "SELECT session_id FROM surface_links WHERE surface = $surface AND channel_id = $channelId"
      )
      .get({ $surface: surface, $channelId: channelId }) as any;

    if (!link) return null;
    return this.getSession(link.session_id);
  }

  getSurfaces(sessionId: string): SessionSurface[] {
    const rows = this.db
      .prepare("SELECT * FROM surface_links WHERE session_id = $sessionId")
      .all({ $sessionId: sessionId }) as any[];
    return rows.map((r) => ({
      surface: r.surface as SurfaceType,
      channelId: r.channel_id,
      sessionId: r.session_id,
      linkedAt: r.linked_at,
      lastSeenSeq: r.last_seen_seq,
    }));
  }

  updateSurfaceSeq(surface: SurfaceType, channelId: string, seq: number): void {
    this.db
      .prepare(
        "UPDATE surface_links SET last_seen_seq = $seq WHERE surface = $surface AND channel_id = $channelId"
      )
      .run({ $surface: surface, $channelId: channelId, $seq: seq });
  }

  // ─── Lifecycle ──────────────────────────────────────────────

  close(): void {
    this.db.close();
  }

  // ─── Schema Migration ─────────────────────────────────────

  private migrate(): void {
    const version = this.getSchemaVersion();
    if (version >= SCHEMA_VERSION) return;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        model TEXT NOT NULL,
        checkpoint_count INTEGER DEFAULT 0,
        current_segment INTEGER DEFAULT 0,
        message_count INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        last_active_at TEXT NOT NULL,
        resumed_from TEXT
      );

      CREATE TABLE IF NOT EXISTS checkpoints (
        checkpoint_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(session_id),
        segment_index INTEGER NOT NULL,
        summary TEXT NOT NULL,
        key_facts TEXT NOT NULL,
        active_goals TEXT NOT NULL,
        tool_results TEXT,
        message_seq_start INTEGER NOT NULL,
        message_seq_end INTEGER NOT NULL,
        token_count INTEGER NOT NULL,
        model TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(session_id, segment_index)
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS checkpoints_fts USING fts5(
        session_id,
        summary,
        key_facts,
        tokenize='porter unicode61'
      );

      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(session_id),
        segment_index INTEGER NOT NULL,
        role TEXT NOT NULL,
        surface TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT,
        tokens INTEGER,
        reply_to_seq INTEGER,
        status TEXT NOT NULL DEFAULT 'final'
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        tokenize='porter unicode61',
        content='messages',
        content_rowid='seq'
      );

      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.seq, new.content);
      END;

      CREATE TABLE IF NOT EXISTS surface_links (
        surface TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(session_id),
        linked_at TEXT NOT NULL,
        last_seen_seq INTEGER DEFAULT 0,
        PRIMARY KEY (surface, channel_id)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
      CREATE INDEX IF NOT EXISTS idx_messages_segment ON messages(session_id, segment_index);
      CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints(session_id, segment_index);
    `);

    this.setSchemaVersion(SCHEMA_VERSION);
  }

  private getSchemaVersion(): number {
    try {
      const row = this.db
        .prepare("SELECT value FROM session_meta WHERE key = 'schema_version'")
        .get() as any;
      return row ? parseInt(row.value, 10) : 0;
    } catch {
      return 0;
    }
  }

  private setSchemaVersion(version: number): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO session_meta (key, value) VALUES ('schema_version', $version)"
      )
      .run({ $version: String(version) });
  }

  // ─── Row Mappers ──────────────────────────────────────────

  private rowToSession(row: any): Session {
    return {
      sessionId: row.session_id,
      threadId: row.thread_id,
      status: row.status as SessionStatus,
      model: row.model,
      checkpointCount: row.checkpoint_count,
      currentSegment: row.current_segment,
      messageCount: row.message_count,
      createdAt: row.created_at,
      lastActiveAt: row.last_active_at,
      resumedFrom: row.resumed_from ?? undefined,
    };
  }

  private rowToMessage(row: any): SessionMessage {
    return {
      seq: row.seq,
      sessionId: row.session_id,
      segmentIndex: row.segment_index,
      role: row.role as "user" | "assistant",
      surface: row.surface as SurfaceType,
      content: row.content,
      timestamp: row.timestamp,
      tokens: row.tokens ?? undefined,
      replyToSeq: row.reply_to_seq ?? undefined,
      status: row.status as MessageStatus,
    };
  }

  private rowToCheckpoint(row: any): Checkpoint {
    return {
      checkpointId: row.checkpoint_id,
      sessionId: row.session_id,
      segmentIndex: row.segment_index,
      summary: row.summary,
      keyFacts: JSON.parse(row.key_facts) as CheckpointFact[],
      activeGoals: JSON.parse(row.active_goals) as string[],
      toolResults: row.tool_results
        ? (JSON.parse(row.tool_results) as CheckpointToolResult[])
        : undefined,
      messageSeqStart: row.message_seq_start,
      messageSeqEnd: row.message_seq_end,
      tokenCount: row.token_count,
      model: row.model,
      createdAt: row.created_at,
    };
  }
}
