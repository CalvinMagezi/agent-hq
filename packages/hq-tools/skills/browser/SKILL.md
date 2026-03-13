---
name: browser
description: Browser automation via headless Chrome (CDP). Take screenshots, inspect pages, fill forms, test responsive layouts.
license: local
---

# Browser Automation Skill

> [!IMPORTANT]
> **This is the canonical browser tool for all agents in this system.** Use `hq_call browser_*` for all browser tasks. Do NOT use `mcp__claude-in-chrome__*` — those are an external fallback only.

You have access to a headless Chrome browser via `hq_call browser_*` tools. The browser server runs locally on port 19200.

## Decision Table

| Goal | Tool |
|---|---|
| Click a button | `browser_click` |
| Fill input | `browser_fill` |
| Select dropdown | `browser_select` |
| Press a key | `browser_press` |
| Wait for page/element | `browser_wait` |
| Read JS state | `browser_evaluate` |
| Check JS errors | `browser_console` |
| Verify API calls | `browser_network_log` |
| Take screenshot | `browser_screenshot` |
| Mobile testing | `browser_set_viewport` |

## Workflow

Always follow this sequence:
1. `browser_session_start` — creates an isolated Chrome instance, returns `sessionId`
2. `browser_navigate` — go to a URL (localhost + staging domains allowed)
3. `browser_snapshot` (with `interactive: true`) — get the accessibility tree with stable `eN` refs
4. Take actions with refs: `browser_click`, `browser_fill`, `browser_press`
5. `browser_screenshot` — capture and save to vault
6. `browser_session_end` — **always** close when done to free Chrome processes

## Key Rules

- **Always close sessions** — each session launches a Chrome process. Leaked sessions waste memory.
- **Snapshot before acting** — refs (`e0`, `e1`, ...) are only valid after a `browser_snapshot` call.
- **Use `interactive: true`** on snapshots when you just need to interact — it strips static text and reduces tokens by 60–80%.
- **Screenshots go to vault** at `_browser/screenshots/{jobId}/` — share the path with the user.

## Allowed Domains

By default: `localhost`, `*.vercel.app`, `*.ngrok.io`, `*.local`

Other domains will be blocked (403). Ask the user to configure `HQ_BROWSER_ALLOWED_DOMAINS` or use an ngrok tunnel.

## Mobile Testing

```
hq_call browser_set_viewport { sessionId, width: 375, height: 812 }   # iPhone 15
hq_call browser_set_viewport { sessionId, width: 390, height: 844 }   # iPhone 14 Pro
hq_call browser_set_viewport { sessionId, width: 412, height: 915 }   # Pixel 7
```

## Example: Verify a local app

```
1. hq_call browser_session_start { jobId: "job-abc" }
   → { sessionId: "sess-xyz" }

2. hq_call browser_navigate { sessionId: "sess-xyz", url: "http://localhost:3000" }

3. hq_call browser_snapshot { sessionId: "sess-xyz", interactive: true }
   → check that expected nav/buttons exist by ref

4. hq_call browser_screenshot { sessionId: "sess-xyz", label: "desktop-home" }
   → { path: "_browser/screenshots/job-abc/...-desktop-home.png" }

5. hq_call browser_set_viewport { sessionId: "sess-xyz", width: 375, height: 812 }
6. hq_call browser_screenshot { sessionId: "sess-xyz", label: "mobile-375" }

7. hq_call browser_session_end { sessionId: "sess-xyz" }
```

## Advanced Tools Example

```
1. hq_call browser_evaluate { sessionId, script: "document.title" }
   → returns page title

2. hq_call browser_wait { sessionId, ref: "e4", ms: 10000 }
   → waits up to 10s for element e4 to appear

3. hq_call browser_console { sessionId }
   → returns buffered console logs/errors

4. hq_call browser_network_log { sessionId, urlFilter: "/api/v1" }
   → returns recent API requests/responses

5. hq_call browser_select { sessionId, ref: "e2", value: "US" }
   → selects "US" from dropdown e2
```

## Troubleshooting

- **"hq-browser 500"** — Chrome may not be installed at `/Applications/Google Chrome.app`. Ensure it's installed.
- **"hq-browser 403"** — URL blocked by domain allowlist. Use localhost or a staging domain.
- **"hq-browser connect"** — Server not running. The daemon auto-starts it; manually: `cd packages/hq-browser && make build && ./bin/hq-browser --vault .vault --headless`
