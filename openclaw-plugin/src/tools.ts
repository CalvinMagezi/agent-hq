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
}
