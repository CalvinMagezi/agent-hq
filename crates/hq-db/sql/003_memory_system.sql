-- Full memory system schema extensions.
-- The base memories + consolidations tables are in 001_initial.sql.
-- This migration adds the extra columns and the replays table.

-- Extra columns on memories (ALTER TABLE is idempotent via IF NOT EXISTS on index)
-- SQLite doesn't have ALTER TABLE ADD COLUMN IF NOT EXISTS, so we use a trick:
-- try to add each column; if it already exists, the migration runner will have
-- already applied this migration and won't re-run it.

ALTER TABLE memories ADD COLUMN harness TEXT NOT NULL DEFAULT '';
ALTER TABLE memories ADD COLUMN raw_text TEXT NOT NULL DEFAULT '';
ALTER TABLE memories ADD COLUMN summary TEXT NOT NULL DEFAULT '';
ALTER TABLE memories ADD COLUMN entities TEXT NOT NULL DEFAULT '[]';
ALTER TABLE memories ADD COLUMN topics TEXT NOT NULL DEFAULT '[]';
ALTER TABLE memories ADD COLUMN last_accessed_at TEXT;
ALTER TABLE memories ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN replay_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN delta_summary TEXT;

-- Extra column on consolidations
ALTER TABLE consolidations ADD COLUMN connections TEXT NOT NULL DEFAULT '[]';

-- Replays table
CREATE TABLE IF NOT EXISTS replays (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    trigger_type   TEXT NOT NULL,
    trigger_source TEXT NOT NULL,
    trigger_ref    TEXT NOT NULL,
    memory_ids     TEXT NOT NULL,
    sequence       TEXT NOT NULL DEFAULT '[]',
    credit_delta   REAL NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_memories_consolidated ON memories(consolidated);
CREATE INDEX IF NOT EXISTS idx_memories_topics ON memories(topics);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_replay ON memories(replay_count DESC);
CREATE INDEX IF NOT EXISTS idx_replays_trigger ON replays(trigger_type, created_at DESC);
