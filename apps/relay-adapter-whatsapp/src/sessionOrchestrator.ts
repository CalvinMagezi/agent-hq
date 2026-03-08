/**
 * SessionOrchestrator — lifecycle state machine for WhatsApp harness sessions.
 *
 * Wraps LocalHarness with:
 *   - State machine: spawning → working → done / failed / stuck / timed_out
 *   - Progress notifications every 5 minutes while the harness runs
 *   - Auto-retry once on transient failures
 *   - Kill support mid-session
 *
 * Harness-agnostic: works with claude-code, opencode, and gemini-cli.
 */

import type { LocalHarness, LocalHarnessType } from "./localHarness.js";

export type SessionState =
  | "spawning"
  | "working"
  | "done"
  | "failed"
  | "stuck"
  | "timed_out";

export interface OrchestratedSession {
  id: string;
  harness: LocalHarnessType;
  prompt: string;
  state: SessionState;
  startedAt: number;
  retries: number;
  result?: string;
  error?: string;
}

export interface SessionReactions {
  /** Periodic status update (still working, stuck, retrying). */
  onStatusUpdate: (session: OrchestratedSession, message: string) => void;
  /** Final result delivered — harness completed successfully. */
  onResult: (session: OrchestratedSession, result: string) => void;
  /** All retries exhausted or timeout. */
  onFailed: (session: OrchestratedSession, error: string) => void;
}

/** Notify the user every PROGRESS_INTERVAL_MS while the harness is running. */
const PROGRESS_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/** After STUCK_THRESHOLD_MS with no completion, mark session as stuck. */
const STUCK_THRESHOLD_MS = 20 * 60 * 1000; // 20 minutes

/** Max automatic retries on transient error (not timeout). */
const MAX_RETRIES = 1;

function harnessLabel(h: LocalHarnessType): string {
  switch (h) {
    case "claude-code": return "Claude Code";
    case "opencode": return "OpenCode";
    case "gemini-cli": return "Gemini CLI";
    case "codex-cli": return "Codex CLI";
  }
}

export class SessionOrchestrator {
  private localHarness: LocalHarness;
  private activeSessions = new Map<string, OrchestratedSession>();

  constructor(harness: LocalHarness) {
    this.localHarness = harness;
  }

  /** Create and immediately start a session. Returns when the session is done/failed. */
  async run(
    sessionId: string,
    harness: LocalHarnessType,
    prompt: string,
    reactions: SessionReactions,
  ): Promise<void> {
    const session: OrchestratedSession = {
      id: sessionId,
      harness,
      prompt,
      state: "spawning",
      startedAt: Date.now(),
      retries: 0,
    };
    this.activeSessions.set(sessionId, session);

    try {
      await this._execute(session, reactions);
    } finally {
      this.activeSessions.delete(sessionId);
    }
  }

  /** Kill the running harness for a session (if active). */
  killSession(_sessionId: string): void {
    this.localHarness.kill();
  }

  /** Returns the active session by ID, if any. */
  getSession(sessionId: string): OrchestratedSession | undefined {
    return this.activeSessions.get(sessionId);
  }

  /** Returns all currently active sessions. */
  getActiveSessions(): OrchestratedSession[] {
    return Array.from(this.activeSessions.values());
  }

  // ── Internal execution ───────────────────────────────────────

  private async _execute(
    session: OrchestratedSession,
    reactions: SessionReactions,
  ): Promise<void> {
    session.state = "working";

    const label = harnessLabel(session.harness);
    let progressCount = 0;
    let markedStuck = false;

    // Progress timer: fires every PROGRESS_INTERVAL_MS
    const progressTimer = setInterval(() => {
      progressCount++;
      const elapsedMin = Math.round((Date.now() - session.startedAt) / 60_000);

      if (!markedStuck && Date.now() - session.startedAt >= STUCK_THRESHOLD_MS) {
        markedStuck = true;
        session.state = "stuck";
        reactions.onStatusUpdate(
          session,
          `_${label} has been running for ${elapsedMin} minutes and may need more time. Still working..._`,
        );
      } else {
        reactions.onStatusUpdate(
          session,
          `_${label} still working... (${elapsedMin} min elapsed)_`,
        );
      }
    }, PROGRESS_INTERVAL_MS);

    try {
      const result = await this._runWithRetry(session, reactions, label);
      session.state = "done";
      session.result = result;
      reactions.onResult(session, result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("timed out")) {
        session.state = "timed_out";
        reactions.onFailed(session, `${label} timed out after 1 hour.`);
      } else {
        session.state = "failed";
        reactions.onFailed(session, msg);
      }
    } finally {
      clearInterval(progressTimer);
    }
  }

  private async _runWithRetry(
    session: OrchestratedSession,
    reactions: SessionReactions,
    label: string,
  ): Promise<string> {
    try {
      return await this.localHarness.run(session.harness, session.prompt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      // Don't retry timeouts — they are intentional limits
      if (msg.includes("timed out") || session.retries >= MAX_RETRIES) {
        throw err;
      }

      // One auto-retry for transient errors
      session.retries++;
      session.state = "working";
      reactions.onStatusUpdate(
        session,
        `_${label} encountered an error. Retrying (attempt ${session.retries + 1})..._`,
      );

      return await this.localHarness.run(session.harness, session.prompt);
    }
  }
}
