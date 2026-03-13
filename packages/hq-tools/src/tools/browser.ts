import { Type } from "@sinclair/typebox";
import type { HQTool, HQContext } from "../registry.js";

const BASE_URL = `http://127.0.0.1:${process.env.HQ_BROWSER_PORT ?? "19200"}`;

async function call(path: string, method = "GET", body?: unknown): Promise<unknown> {
  const opts: RequestInit = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}${path}`, opts);
  const json = await res.json();
  if (!res.ok) throw new Error((json as any).error ?? `hq-browser ${res.status}`);
  return json;
}

export const browserTools: HQTool[] = [
  {
    name: "browser_session_start",
    description:
      "Start an isolated Chrome browser session. Returns a sessionId used by all other browser tools. Each agent job should use its own session.",
    tags: ["browser", "session", "chrome", "automation"],
    schema: Type.Object({
      jobId: Type.Optional(Type.String({ description: "The current job ID to associate with this session." })),
    }),
    requiresWriteAccess: false,
    execute: async (input: { jobId?: string }, _ctx: HQContext) => {
      return call("/sessions", "POST", { jobId: input.jobId ?? "" });
    },
  },

  {
    name: "browser_navigate",
    description:
      "Navigate the browser to a URL. Only localhost, *.vercel.app, and *.ngrok.io are allowed by default.",
    tags: ["browser", "navigate", "url", "automation"],
    schema: Type.Object({
      sessionId: Type.String({ description: "Session ID from browser_session_start." }),
      url: Type.String({ description: "URL to navigate to." }),
    }),
    requiresWriteAccess: false,
    execute: async (input: { sessionId: string; url: string }, _ctx: HQContext) => {
      return call(`/sessions/${input.sessionId}/navigate`, "POST", { url: input.url });
    },
  },

  {
    name: "browser_snapshot",
    description:
      "Get the accessibility tree of the current page with stable element refs (e0, e1, ...). Use interactive:true to only show clickable/fillable elements and reduce token usage.",
    tags: ["browser", "snapshot", "accessibility", "dom", "automation"],
    schema: Type.Object({
      sessionId: Type.String({ description: "Session ID." }),
      interactive: Type.Optional(
        Type.Boolean({
          description:
            "If true, only return interactive elements (buttons, inputs, links). Reduces tokens significantly.",
        }),
      ),
    }),
    requiresWriteAccess: false,
    execute: async (input: { sessionId: string; interactive?: boolean }, _ctx: HQContext) => {
      const q = input.interactive ? "?i=1" : "";
      return call(`/sessions/${input.sessionId}/snapshot${q}`);
    },
  },

  {
    name: "browser_screenshot",
    description:
      "Take a screenshot of the current page and save it to the vault. Returns the vault-relative path (e.g. _browser/screenshots/job-abc/123-mobile.png) which can be shared with the user.",
    tags: ["browser", "screenshot", "capture", "image", "automation"],
    schema: Type.Object({
      sessionId: Type.String({ description: "Session ID." }),
      label: Type.Optional(
        Type.String({
          description: 'Descriptive label for the screenshot filename (e.g. "mobile-home", "desktop-nav").',
        }),
      ),
      jobId: Type.Optional(Type.String({ description: "Override job ID for the screenshot folder." })),
    }),
    requiresWriteAccess: false,
    execute: async (input: { sessionId: string; label?: string; jobId?: string }, _ctx: HQContext) => {
      return call(`/sessions/${input.sessionId}/screenshot`, "POST", {
        label: input.label,
        jobId: input.jobId,
      });
    },
  },

  {
    name: "browser_click",
    description: "Click an element by its ref (e.g. \"e3\"). Run browser_snapshot first to get refs.",
    tags: ["browser", "click", "interact", "automation"],
    schema: Type.Object({
      sessionId: Type.String({ description: "Session ID." }),
      ref: Type.String({ description: 'Element ref from the last snapshot (e.g. "e3").' }),
    }),
    requiresWriteAccess: true,
    execute: async (input: { sessionId: string; ref: string }, _ctx: HQContext) => {
      return call(`/sessions/${input.sessionId}/click`, "POST", { ref: input.ref });
    },
  },

  {
    name: "browser_fill",
    description: "Clear an input field and type a value into it. Run browser_snapshot first to get refs.",
    tags: ["browser", "fill", "input", "form", "automation"],
    schema: Type.Object({
      sessionId: Type.String({ description: "Session ID." }),
      ref: Type.String({ description: "Input element ref from the last snapshot." }),
      value: Type.String({ description: "Text to type." }),
    }),
    requiresWriteAccess: true,
    execute: async (input: { sessionId: string; ref: string; value: string }, _ctx: HQContext) => {
      return call(`/sessions/${input.sessionId}/fill`, "POST", { ref: input.ref, value: input.value });
    },
  },

  {
    name: "browser_press",
    description: 'Press a key (e.g. "Enter", "Tab", "Escape", "ctrl+a"). Useful after filling forms.',
    tags: ["browser", "press", "key", "keyboard", "automation"],
    schema: Type.Object({
      sessionId: Type.String({ description: "Session ID." }),
      key: Type.String({ description: 'Key to press. Examples: "Enter", "Tab", "Escape", "ctrl+a".' }),
    }),
    requiresWriteAccess: true,
    execute: async (input: { sessionId: string; key: string }, _ctx: HQContext) => {
      return call(`/sessions/${input.sessionId}/press`, "POST", { key: input.key });
    },
  },

  {
    name: "browser_scroll",
    description: "Scroll the page in a direction.",
    tags: ["browser", "scroll", "automation"],
    schema: Type.Object({
      sessionId: Type.String({ description: "Session ID." }),
      direction: Type.Union(
        [Type.Literal("up"), Type.Literal("down"), Type.Literal("left"), Type.Literal("right")],
        { description: "Scroll direction." },
      ),
      amount: Type.Optional(Type.Number({ description: "Pixels to scroll (default: 300)." })),
    }),
    requiresWriteAccess: false,
    execute: async (input: { sessionId: string; direction: string; amount?: number }, _ctx: HQContext) => {
      return call(`/sessions/${input.sessionId}/scroll`, "POST", {
        direction: input.direction,
        amount: input.amount ?? 300,
      });
    },
  },

  {
    name: "browser_set_viewport",
    description:
      "Resize the browser viewport. Use this to test mobile layouts (e.g. 375x812 for iPhone 15, 390x844 for iPhone 14).",
    tags: ["browser", "viewport", "mobile", "responsive", "automation"],
    schema: Type.Object({
      sessionId: Type.String({ description: "Session ID." }),
      width: Type.Number({ description: "Viewport width in pixels." }),
      height: Type.Number({ description: "Viewport height in pixels." }),
    }),
    requiresWriteAccess: false,
    execute: async (input: { sessionId: string; width: number; height: number }, _ctx: HQContext) => {
      return call(`/sessions/${input.sessionId}/viewport`, "POST", {
        width: input.width,
        height: input.height,
      });
    },
  },

  {
    name: "browser_evaluate",
    description:
      "Execute JavaScript in the page and return the result. Use for DOM inspection, " +
      "state reading, or driving SPAs where no AX ref is available. Prefer browser_click/fill " +
      "for interactions when refs exist.",
    tags: ["browser", "javascript", "evaluate", "dom", "automation"],
    schema: Type.Object({
      sessionId: Type.String({ description: "Session ID." }),
      script: Type.String({ description: "JS expression to evaluate. Runs in page context." }),
    }),
    requiresWriteAccess: true,
    execute: async (input: { sessionId: string; script: string }, _ctx: HQContext) => {
      return call(`/sessions/${input.sessionId}/evaluate`, "POST", { script: input.script });
    },
  },

  {
    name: "browser_console",
    description:
      "Drain buffered browser console messages (log/warn/error) since last call. " +
      "Buffer holds 100 entries. Call after navigation or user actions to catch JS errors.",
    tags: ["browser", "console", "debug", "errors", "automation"],
    schema: Type.Object({ sessionId: Type.String() }),
    requiresWriteAccess: false,
    execute: async (input: { sessionId: string }, _ctx: HQContext) => call(`/sessions/${input.sessionId}/console`),
  },

  {
    name: "browser_network_log",
    description:
      "Drain buffered network requests/responses (up to 100 entries) since last call. " +
      "Filter by URL substring. Use to verify API calls, check status codes, debug missing requests.",
    tags: ["browser", "network", "http", "debug", "automation"],
    schema: Type.Object({
      sessionId: Type.String(),
      urlFilter: Type.Optional(Type.String({ description: "Only return entries whose URL contains this string." })),
    }),
    requiresWriteAccess: false,
    execute: async (input: { sessionId: string; urlFilter?: string }, _ctx: HQContext) => {
      const q = input.urlFilter ? `?url=${encodeURIComponent(input.urlFilter)}` : "";
      return call(`/sessions/${input.sessionId}/network${q}`);
    },
  },

  {
    name: "browser_wait",
    description:
      "Wait until a ref appears, the page URL matches a prefix, or N ms elapses. " +
      "Use after clicking a nav link or submitting a form.",
    tags: ["browser", "wait", "navigation", "automation"],
    schema: Type.Object({
      sessionId: Type.String(),
      ref: Type.Optional(Type.String({ description: "AX ref to wait for." })),
      url: Type.Optional(Type.String({ description: "URL prefix to wait for." })),
      ms: Type.Optional(Type.Number({ description: "Max wait in ms (default 5000)." })),
    }),
    requiresWriteAccess: false,
    execute: async (input: { sessionId: string; ref?: string; url?: string; ms?: number }, _ctx: HQContext) =>
      call(`/sessions/${input.sessionId}/wait`, "POST", { ref: input.ref, url: input.url, ms: input.ms }),
  },

  {
    name: "browser_select",
    description: "Select an option in a <select> dropdown by value. Run browser_snapshot first to get ref.",
    tags: ["browser", "select", "dropdown", "form", "automation"],
    schema: Type.Object({
      sessionId: Type.String(),
      ref: Type.String({ description: "Select element ref from snapshot." }),
      value: Type.String({ description: "Option value to select." }),
    }),
    requiresWriteAccess: true,
    execute: async (input: { sessionId: string; ref: string; value: string }, _ctx: HQContext) =>
      call(`/sessions/${input.sessionId}/select`, "POST", { ref: input.ref, value: input.value }),
  },

  {
    name: "browser_session_end",
    description:
      "Close a browser session and terminate the Chrome process. Always call this when done to free resources.",
    tags: ["browser", "session", "cleanup", "automation"],
    schema: Type.Object({
      sessionId: Type.String({ description: "Session ID to close." }),
    }),
    requiresWriteAccess: true,
    execute: async (input: { sessionId: string }, _ctx: HQContext) => {
      return call(`/sessions/${input.sessionId}`, "DELETE");
    },
  },
]
