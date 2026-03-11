/**
 * delegation — relay job delegation flow for UnifiedAdapterBot.
 *
 * Submits an orchestration job to the relay server, tracks the active
 * job, and handles vault events (task:created/claimed/completed,
 * job:completed/failed) to deliver the result back to the user.
 */

import type { RelayClient } from "@repo/agent-relay-protocol";
import type { CmdResultMessage } from "@repo/agent-relay-protocol";
import type { PlatformBridge } from "./platformBridge.js";
import { delegationLabel } from "./harnessRouter.js";

// ─── Types ────────────────────────────────────────────────────────

export interface DelegationState {
  activeJobId: string | null;
  activeJobLabel: string | null;
  activeJobResultDelivered: boolean;
  activeTaskIds: Set<string>;
  activeJobSourceMsgId: string | null;
}

export interface DelegationContext {
  relay: RelayClient;
  bridge: PlatformBridge;
  state: DelegationState;
  setProcessing(b: boolean): void;
  /** Send (possibly long) response text to the user. */
  sendChunked(text: string): Promise<void>;
  /** Fallback: handle as a direct chat when delegation fails or times out. */
  fallbackToChat(content: string): Promise<void>;
  platformLabel: string;
}

// ─── Job result helpers ────────────────────────────────────────────

async function fetchTaskResult(relay: RelayClient, taskId: string): Promise<string | null> {
  return new Promise((resolve) => {
    const requestId = `tres-${Date.now()}`;
    const unsub = relay.on<CmdResultMessage>("cmd:result", (msg) => {
      if (msg.requestId === requestId) {
        unsub();
        const out = msg.output ?? null;
        resolve(out && out !== "__pending__" ? out : null);
      }
    });
    relay.send({ type: "cmd:execute", command: "task-result", args: { taskId }, requestId });
    setTimeout(() => { unsub(); resolve(null); }, 8_000);
  });
}

async function fetchJobResult(relay: RelayClient, jobId: string): Promise<string | null> {
  return new Promise((resolve) => {
    const requestId = `jres-${Date.now()}`;
    const unsub = relay.on<CmdResultMessage>("cmd:result", (msg) => {
      if (msg.requestId === requestId) {
        unsub();
        const out = msg.output ?? null;
        resolve(out && out !== "__pending__" ? out : null);
      }
    });
    relay.send({ type: "cmd:execute", command: "job-result", args: { jobId }, requestId });
    setTimeout(() => { unsub(); resolve(null); }, 8_000);
  });
}

// ─── handleDelegation ─────────────────────────────────────────────

/**
 * Submit a relay job for a delegated harness request.
 *
 * @param content  enriched message content
 * @param harness  target harness ("gemini-cli" | "claude-code" | "opencode" | "any")
 * @param role     optional role hint
 * @param ctx      delegation context with mutable state
 * @param sourceMsgId  original message ID for reaction tracking
 */
export async function handleDelegation(
  content: string,
  harness: string,
  role: string | undefined,
  ctx: DelegationContext,
  sourceMsgId?: string,
): Promise<void> {
  ctx.setProcessing(true);
  const hLabel = delegationLabel(harness);
  ctx.state.activeJobSourceMsgId = sourceMsgId ?? null;

  if (sourceMsgId) {
    ctx.bridge.sendReaction(sourceMsgId, "⏳").catch(() => {});
  }

  try {
    await ctx.bridge.sendText(`_Routing to ${hLabel}..._`);

    const roleHint = role ? ` role=${role}` : "";
    const instruction =
      `[ORCHESTRATION targetHarness=${harness}${roleHint}]\n\n` +
      `<user_message>\n${content}\n</user_message>\n\n` +
      `Use the delegate_to_relay tool to handle the user's request above via ${harness}` +
      `${role ? ` with role="${role}"` : ""}. Return the complete response to the user.`;

    const jobId = await new Promise<string>((resolve, reject) => {
      const requestId = `job-${Date.now()}`;
      const unsub = ctx.relay.on("job:submitted", (msg: any) => {
        if (msg.requestId === requestId) { unsub(); resolve(msg.jobId); }
      });
      const unsubErr = ctx.relay.on("error", (msg: any) => {
        if (msg.requestId === requestId) { unsubErr(); reject(new Error(msg.message ?? "Job submit failed")); }
      });
      ctx.relay.send({
        type: "job:submit",
        instruction,
        jobType: "background",
        requestId,
      } as any);
      setTimeout(() => {
        unsub(); unsubErr();
        reject(new Error("Job submit timeout — agent may be offline"));
      }, 15_000);
    });

    console.log(`[${ctx.platformLabel}] Job submitted: ${jobId} → ${harness}`);
    ctx.state.activeJobId = jobId;
    ctx.state.activeJobLabel = hLabel;
    ctx.state.activeJobResultDelivered = false;

    await ctx.bridge.sendText(
      `_Task queued (job: \`${jobId.slice(-8)}\`). ${hLabel} will respond shortly. Type !status for updates._`,
    );

    // 10-minute failsafe fallback
    setTimeout(async () => {
      if (ctx.state.activeJobId === jobId && !ctx.state.activeJobResultDelivered) {
        console.warn(`[${ctx.platformLabel}] Job ${jobId} timed out — falling back to direct chat`);
        ctx.state.activeJobId = null;
        ctx.state.activeJobLabel = null;
        ctx.state.activeTaskIds.clear();
        ctx.state.activeJobSourceMsgId = null;
        ctx.setProcessing(false);
        await ctx.bridge.sendText(`_${hLabel} didn't respond in time. Answering directly..._`);
        await ctx.fallbackToChat(content);
      }
    }, 10 * 60 * 1000);
  } catch (err) {
    console.error(`[${ctx.platformLabel}] Delegation setup error:`, err);
    if (ctx.state.activeJobSourceMsgId) {
      ctx.bridge.sendReaction(ctx.state.activeJobSourceMsgId, "❌").catch(() => {});
    }
    ctx.state.activeJobId = null;
    ctx.state.activeJobLabel = null;
    ctx.state.activeTaskIds.clear();
    ctx.state.activeJobSourceMsgId = null;
    ctx.setProcessing(false);
    await ctx.bridge.sendText(`_${hLabel} unavailable — answering directly..._`);
    await ctx.fallbackToChat(content);
  }
}

// ─── handleVaultEvent ─────────────────────────────────────────────

function harnessFromPath(filePath: string): string | null {
  if (filePath.includes("gemini")) return "Gemini";
  if (filePath.includes("claude")) return "Claude Code";
  if (filePath.includes("opencode")) return "OpenCode";
  return null;
}

/**
 * Process a vault event received via `system:event`.
 * Should be called by UnifiedAdapterBot's relay event handler.
 */
export async function handleVaultEvent(
  event: string,
  data: any,
  ctx: DelegationContext,
): Promise<void> {
  const filePath: string = data?.path ?? data?.filePath ?? "";
  const taskIdMatch = filePath.match(/task-([^/]+?)\.md$/);
  const taskId = taskIdMatch?.[1] ?? null;
  const jobIdMatch = filePath.match(/job-([^/]+?)\.md$/);
  const fileJobId = jobIdMatch ? `job-${jobIdMatch[1]}` : null;
  const { state } = ctx;

  switch (event) {
    case "task:created":
      if (state.activeJobId && taskId) {
        state.activeTaskIds.add(taskId);
        console.log(`[${ctx.platformLabel}] Task created: ${taskId} for job ${state.activeJobId}`);
      }
      break;

    case "task:claimed":
      if (state.activeJobId && taskId && state.activeTaskIds.has(taskId)) {
        const claimedBy = data?.claimedBy ?? (harnessFromPath(filePath) ?? "a bot");
        await ctx.bridge.sendText(`_${claimedBy} is now working on your request..._`);
      }
      break;

    case "task:completed":
      if (
        state.activeJobId &&
        taskId &&
        state.activeTaskIds.has(taskId) &&
        !state.activeJobResultDelivered
      ) {
        console.log(`[${ctx.platformLabel}] Task completed: ${taskId} — fetching result`);
        const result = await fetchTaskResult(ctx.relay, taskId);
        if (result) {
          state.activeJobResultDelivered = true;
          if (state.activeJobSourceMsgId) {
            ctx.bridge.sendReaction(state.activeJobSourceMsgId, "✅").catch(() => {});
          }
          state.activeJobId = null;
          state.activeJobLabel = null;
          state.activeTaskIds.clear();
          state.activeJobSourceMsgId = null;
          ctx.setProcessing(false);
          await ctx.sendChunked(result);
        }
      }
      break;

    case "job:completed":
      if (
        state.activeJobId &&
        fileJobId === state.activeJobId &&
        !state.activeJobResultDelivered
      ) {
        console.log(`[${ctx.platformLabel}] Job completed: ${fileJobId} — fetching result`);
        const result = await fetchJobResult(ctx.relay, fileJobId);
        if (result) {
          state.activeJobResultDelivered = true;
          if (state.activeJobSourceMsgId) {
            ctx.bridge.sendReaction(state.activeJobSourceMsgId, "✅").catch(() => {});
          }
          state.activeJobId = null;
          state.activeJobLabel = null;
          state.activeTaskIds.clear();
          state.activeJobSourceMsgId = null;
          ctx.setProcessing(false);
          await ctx.sendChunked(result);
        }
      }
      break;

    case "job:failed":
      if (
        state.activeJobId &&
        fileJobId === state.activeJobId &&
        !state.activeJobResultDelivered
      ) {
        state.activeJobResultDelivered = true;
        if (state.activeJobSourceMsgId) {
          ctx.bridge.sendReaction(state.activeJobSourceMsgId, "❌").catch(() => {});
        }
        state.activeJobId = null;
        state.activeJobLabel = null;
        state.activeTaskIds.clear();
        state.activeJobSourceMsgId = null;
        ctx.setProcessing(false);
        await ctx.bridge.sendText("_The delegated task failed. Try again or rephrase._");
      }
      break;
  }
}
