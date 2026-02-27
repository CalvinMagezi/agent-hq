/**
 * Agent tools for the Agent-HQ Bridge plugin.
 *
 * These tools are registered with the OpenClaw Gateway and become
 * available to the AI agent at runtime. Initial scope: Google Workspace
 * capabilities only.
 */

import type { AgentHQClient } from "./client";

/**
 * OpenClaw Plugin API interface (minimal subset needed for tool registration).
 * The full API is provided by @openclaw/sdk at runtime.
 */
interface PluginAPI {
  registerTool(tool: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (args: Record<string, unknown>) => Promise<string>;
  }): void;
}

const GOOGLE_WORKSPACE_CAPABILITIES = [
  "google-drive",
  "google-docs",
  "google-sheets",
  "gmail",
  "google-calendar",
];

export function registerTools(api: PluginAPI, client: AgentHQClient): void {
  // ─── Request Capability ──────────────────────────────────────

  api.registerTool({
    name: "hq_request_capability",
    description: [
      "Request a service from Agent-HQ via its delegation system.",
      "Currently supports Google Workspace operations:",
      "- google-drive: List, read, create, and manage Google Drive files",
      "- google-docs: Read, create, and edit Google Docs",
      "- google-sheets: Read, create, and edit Google Sheets",
      "- gmail: Read, compose, and send emails",
      "- google-calendar: Read and manage calendar events",
      "",
      "The request is processed asynchronously. Use hq_check_result to poll for the result.",
    ].join("\n"),
    parameters: {
      capability: {
        type: "string",
        enum: GOOGLE_WORKSPACE_CAPABILITIES,
        description: "The capability to request",
      },
      instruction: {
        type: "string",
        description:
          "Detailed instruction for the capability (e.g., 'List all files in the Project X folder on Google Drive')",
      },
      priority: {
        type: "number",
        description:
          "Priority (1-100, higher = processed first). Default: 50",
        optional: true,
      },
    },
    execute: async (args) => {
      const result = await client.requestCapability({
        capability: args.capability as string,
        instruction: args.instruction as string,
        priority: (args.priority as number) ?? 50,
      });
      return [
        `Capability request submitted successfully.`,
        `- Request ID: ${result.requestId}`,
        `- Status: ${result.status}`,
        ``,
        `Use hq_check_result with this request ID to poll for the result.`,
        `Note: Google Workspace requests are processed by the Gemini CLI harness and typically complete within 1-3 minutes.`,
      ].join("\n");
    },
  });

  // ─── Check Result ────────────────────────────────────────────

  api.registerTool({
    name: "hq_check_result",
    description: [
      "Check the status and result of a previously submitted capability request.",
      "Returns the current status (pending, running, completed, failed) and the result if completed.",
    ].join("\n"),
    parameters: {
      requestId: {
        type: "string",
        description: "The request ID returned by hq_request_capability",
      },
    },
    execute: async (args) => {
      const result = await client.getCapabilityResult(
        args.requestId as string,
      );

      if (result.status === "completed" && result.result) {
        return [
          `Status: completed`,
          ``,
          `Result:`,
          result.result,
        ].join("\n");
      }

      if (result.status === "failed") {
        return `Status: failed\nError: ${result.error ?? "Unknown error"}`;
      }

      return `Status: ${result.status}. The request is still being processed. Try again in a few seconds.`;
    },
  });

  // ─── Write Note ──────────────────────────────────────────────

  api.registerTool({
    name: "hq_write_note",
    description: [
      "Write a note to your dedicated namespace in Agent-HQ's vault.",
      "Notes are stored as markdown files and persist across sessions.",
      "Useful for saving research results, summaries, or data you want to reference later.",
    ].join("\n"),
    parameters: {
      title: {
        type: "string",
        description: "Title of the note",
      },
      content: {
        type: "string",
        description: "Markdown content of the note",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Optional tags for categorization",
        optional: true,
      },
    },
    execute: async (args) => {
      const result = await client.writeNote({
        title: args.title as string,
        content: args.content as string,
        tags: (args.tags as string[]) ?? [],
      });
      return `Note "${args.title}" saved to ${result.path}`;
    },
  });

  // ─── Read Note ───────────────────────────────────────────────

  api.registerTool({
    name: "hq_read_note",
    description: [
      "Read a note from your Agent-HQ namespace.",
      "Use hq_search_notes to find notes by content, or hq_list_notes to see all available notes.",
    ].join("\n"),
    parameters: {
      path: {
        type: "string",
        description:
          "The filename of the note (e.g., 'my-note.md')",
      },
    },
    execute: async (args) => {
      const note = await client.readNote(args.path as string);
      return [
        `# ${note.title}`,
        note.tags.length > 0 ? `Tags: ${note.tags.join(", ")}` : "",
        `Created: ${note.createdAt}`,
        "",
        note.content,
      ]
        .filter(Boolean)
        .join("\n");
    },
  });

  // ─── Search Notes ────────────────────────────────────────────

  api.registerTool({
    name: "hq_search_notes",
    description:
      "Search your notes in Agent-HQ by text content or title.",
    parameters: {
      query: {
        type: "string",
        description: "Search query",
      },
      limit: {
        type: "number",
        description: "Max results (default 5, max 20)",
        optional: true,
      },
    },
    execute: async (args) => {
      const { results } = await client.searchNotes(
        args.query as string,
        (args.limit as number) ?? 5,
      );

      if (results.length === 0) {
        return "No notes found matching your query.";
      }

      return results
        .map(
          (r, i) =>
            `${i + 1}. **${r.title}** (${r.path})\n   ${r.snippet}`,
        )
        .join("\n\n");
    },
  });

  // ─── Get Context ─────────────────────────────────────────────

  api.registerTool({
    name: "hq_get_context",
    description: [
      "Get shared context from Agent-HQ.",
      "Returns current time and timezone. Does not expose private data.",
    ].join("\n"),
    parameters: {},
    execute: async () => {
      const ctx = await client.getContext();
      return [
        `Current time: ${ctx.currentTime}`,
        `Timezone: ${ctx.timezone}`,
      ].join("\n");
    },
  });

  // ─── List Specialists ────────────────────────────────────────

  api.registerTool({
    name: "hq_list_specialists",
    description: "List specialized sub-agents available in Agent-HQ for task delegation.",
    parameters: {},
    execute: async () => {
      const { agents } = await client.listAgents();
      if (agents.length === 0) return "No specialized agents available.";

      return agents.map(a => `- **${a.id}**: ${a.name} - ${a.description}`).join("\n");
    }
  });

  // ─── List Available Agents (COO-oriented) ────────────────────

  api.registerTool({
    name: "hq_list_available_agents",
    description: [
      "List all available Agent-HQ relay harnesses and their current status.",
      "Use this before delegating tasks to choose the right harness.",
      "Returns harness ID, name, and description.",
    ].join("\n"),
    parameters: {},
    execute: async () => {
      const { agents } = await client.listAvailableAgents();
      if (agents.length === 0) return "No relay agents available.";

      return agents
        .map(a => `- **${a.id}** — ${a.name}: ${a.description}`)
        .join("\n");
    },
  });

  // ─── Delegate Task ───────────────────────────────────────────

  api.registerTool({
    name: "hq_delegate_task",
    description: [
      "Delegate a complex task to a specialized sub-agent (e.g., gemini-cli, claude-code).",
      "The task is processed asynchronously. You will NOT get an immediate result.",
      "The sub-agent will write its response back to the vault when done.",
      "Use dependsOn to chain tasks — a task will not start until all its dependencies complete.",
    ].join("\n"),
    parameters: {
      targetAgentId: {
        type: "string",
        description: "The ID of the target agent (see hq_list_available_agents)",
      },
      instruction: {
        type: "string",
        description: "Detailed instruction for the sub-agent",
      },
      priority: {
        type: "number",
        description: "Priority (1-100). Default: 50",
        optional: true,
      },
      dependsOn: {
        type: "array",
        items: { type: "string" },
        description: "Task IDs that must complete before this task starts",
        optional: true,
      },
      metadata: {
        type: "object",
        description: "Optional metadata to pass to the sub-agent",
        optional: true,
      }
    },
    execute: async (args) => {
      const result = await client.delegateTask({
        instruction: args.instruction as string,
        targetAgentId: args.targetAgentId as string,
        priority: args.priority as number,
        dependsOn: (args.dependsOn as string[]) ?? [],
        metadata: args.metadata as Record<string, any>
      });
      return `Task delegated successfully.\n- Task ID: ${result.taskId}\n- Status: ${result.status}\nUse hq_review_completed_tasks to check results when ready.`;
    }
  });

  // ─── Review Completed Tasks ──────────────────────────────────

  api.registerTool({
    name: "hq_review_completed_tasks",
    description: [
      "Review recently completed delegation tasks from your COO namespace.",
      "Use this to check on work your delegated sub-agents have finished.",
      "Returns up to 20 most recent completed tasks with their results.",
    ].join("\n"),
    parameters: {
      limit: {
        type: "number",
        description: "Max tasks to return (default 10, max 50)",
        optional: true,
      },
    },
    execute: async (args) => {
      const { tasks } = await client.reviewCompletedTasks((args.limit as number) ?? 10);
      if (tasks.length === 0) return "No completed tasks found in your namespace.";

      return tasks
        .map((t, i) => {
          const preview = (t.result ?? t.error ?? "").substring(0, 300);
          return `${i + 1}. **${t.taskId}** [${t.status}]${t.completedAt ? ` — ${t.completedAt}` : ""}\n   ${preview}${preview.length >= 300 ? "..." : ""}`;
        })
        .join("\n\n");
    },
  });

  // ─── Mark Task Completed ──────────────────────────────────────

  api.registerTool({
    name: "hq_mark_task_completed",
    description: "Mark a delegated task as completed or failed with a result.",
    parameters: {
      taskId: {
        type: "string",
        description: "The ID of the task to mark as completed",
      },
      result: {
        type: "string",
        description: "The final result or output of the task",
        optional: true,
      },
      error: {
        type: "string",
        description: "Error message if the task failed",
        optional: true,
      },
      status: {
        type: "string",
        enum: ["completed", "failed"],
        description: "Final status. Default: completed",
        optional: true,
      }
    },
    execute: async (args) => {
      await client.markCompleted({
        taskId: args.taskId as string,
        result: args.result as string,
        error: args.error as string,
        status: (args.status as "completed" | "failed") || "completed"
      });
      return `Task ${args.taskId} has been marked as ${args.status || "completed"}.`;
    }
  });
}
