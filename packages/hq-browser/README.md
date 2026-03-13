# hq-browser

A Go-based browser automation server for Agent-HQ. Gives AI agents programmatic control over Chrome via the Chrome DevTools Protocol (CDP). Designed for automated verification and testing of agent-built work.

**Primary use case**: A coding agent finishes work (e.g. mobile responsiveness changes), spins up a browser session against the local dev server, takes screenshots, and reports back — all without human intervention.

---

## Requirements

- **Google Chrome** must be installed. The server will find it automatically at the standard location:
  - macOS: `/Applications/Google Chrome.app`
  - Linux: `/usr/bin/google-chrome` or `/usr/bin/chromium-browser`
  - Custom: set `CHROME_PATH=/path/to/chrome` environment variable

- **Go 1.22+** is required to build.

---

## Building

```bash
# Install Go (macOS)
brew install go

# From the monorepo root
cd packages/hq-browser

# Install dependencies
make deps

# Build for your current platform
make build
# → produces bin/hq-browser

# Cross-compile for all supported platforms
make build-all
# → bin/hq-browser-darwin-arm64
# → bin/hq-browser-darwin-amd64
# → bin/hq-browser-linux-amd64
# → bin/hq-browser-linux-arm64
```

> **Note**: Binaries are not committed to the repository. Build before first use.

---

## Running

```bash
# Simplest — reads VAULT_PATH from environment
VAULT_PATH=/path/to/agent-hq/.vault ./bin/hq-browser

# With options
./bin/hq-browser \
  --vault /path/to/agent-hq/.vault \
  --port 19200 \
  --bind 127.0.0.1 \
  --headless

# Via make
VAULT_PATH=/path/to/.vault make run

# Extra allowed domains (beyond localhost/vercel.app/ngrok.io defaults)
./bin/hq-browser --vault $VAULT_PATH --allow-domains "staging.myapp.com,*.review.app"
# or via env:
HQ_BROWSER_ALLOWED_DOMAINS="staging.myapp.com" ./bin/hq-browser --vault $VAULT_PATH
```

The server runs on `http://127.0.0.1:19200` by default.

---

## Integration with Agent-HQ

The daemon (`scripts/agent-hq-daemon.ts`) manages the hq-browser lifecycle automatically. When the daemon starts, hq-browser starts. When it stops, hq-browser stops.

Agents access browser tools via the HQ tool registry (`hq_discover` / `hq_call`):

```
hq_call browser_session_start { "jobId": "job-abc" }
→ { "sessionId": "sess-a1b2c3d4" }

hq_call browser_navigate { "sessionId": "sess-a1b2c3d4", "url": "http://localhost:8081" }

hq_call browser_set_viewport { "sessionId": "sess-a1b2c3d4", "width": 375, "height": 812 }

hq_call browser_screenshot { "sessionId": "sess-a1b2c3d4", "label": "mobile-home" }
→ { "path": "_browser/screenshots/job-abc/1741820400-mobile-home.png", ... }

hq_call browser_session_end { "sessionId": "sess-a1b2c3d4" }
```

---

## REST API

All requests/responses are JSON. Server binds to `127.0.0.1:19200`.

### Health
```
GET /health       → { status, sessions, time }
GET /metrics      → { activeSessions, vaultPath, headless, allowedDomains }
```

### Sessions
```
POST   /sessions              { jobId? }          → { sessionId, jobId, debugPort }
GET    /sessions                                  → { sessions: [...] }
GET    /sessions/{id}                             → session info
DELETE /sessions/{id}                             → { deleted }
```

### Navigation & State
```
POST /sessions/{id}/navigate    { url }           → { url }
GET  /sessions/{id}/snapshot    ?i=1 (interactive only) → { tree, nodeCount, interactCount }
GET  /sessions/{id}/url                           → { url }
GET  /sessions/{id}/title                         → { title }
```

### Actions
```
POST /sessions/{id}/click       { ref }           → { clicked }
POST /sessions/{id}/fill        { ref, value }    → { filled }
POST /sessions/{id}/type        { ref, value }    → { typed }
POST /sessions/{id}/press       { key }           → { pressed }
POST /sessions/{id}/scroll      { direction, amount? } → { scrolled, amount }
POST /sessions/{id}/evaluate    { script }        → { result }
POST /sessions/{id}/viewport    { width, height } → { width, height }
```

### Capture
```
POST /sessions/{id}/screenshot  { label?, jobId? } → { path, fullPath, bytes }
```

---

## Domain Allowlist

By default, only these domains are reachable:

| Pattern | Example |
|---|---|
| `localhost` | `http://localhost:3000` |
| `127.0.0.1` | `http://127.0.0.1:8081` |
| `*.local` | `http://myapp.local` |
| `*.vercel.app` | `https://myapp-abc123.vercel.app` |
| `*.ngrok.io` | `https://abc.ngrok.io` |
| `*.ngrok-free.app` | tunnel URLs |

Production domains are blocked. To add more, use `--allow-domains` or `HQ_BROWSER_ALLOWED_DOMAINS`.

---

## Vault Storage

Browser artifacts are stored under `.vault/_browser/`:

```
.vault/_browser/
├── sessions/          # Active session metadata JSON files
│   └── sess-abc.json
├── profiles/          # Chrome user data (cookies, storage) per session
│   └── sess-abc/
└── screenshots/       # PNG screenshots organised by job
    └── job-abc/
        └── 1741820400-mobile-home.png
```

---

## Architecture

```
packages/hq-browser/
├── cmd/hq-browser/main.go          # CLI entrypoint (flags, config)
├── internal/
│   ├── server/server.go            # HTTP server + all route handlers
│   ├── cdp/                        # Chrome DevTools Protocol client
│   │   ├── client.go               # WebSocket connection, call/event loop
│   │   └── types.go                # CDP message types
│   ├── browser/
│   │   ├── launcher.go             # Chrome binary discovery + launch
│   │   └── instance.go             # Chrome process + CDP session lifecycle
│   ├── session/manager.go          # Multi-session orchestrator
│   ├── snapshot/
│   │   ├── extractor.go            # Accessibility tree → text with refs
│   │   └── refs.go                 # Stable ref assignment (e0, e1, ...)
│   ├── actions/actions.go          # navigate, click, fill, press, scroll, screenshot
│   ├── guardrails/domain.go        # Domain allowlist enforcement
│   └── vault/writer.go             # Write screenshots/sessions to vault
└── Makefile
```

**Key design choices:**

- **Single Go binary** — no runtime dependencies. Build once, run anywhere.
- **Per-session Chrome processes** — full isolation between agent jobs, no shared state.
- **Accessibility tree refs** — stable element identifiers (`e0`, `e1`, ...) instead of fragile CSS selectors. Agents snapshot → act on refs.
- **Vault-native storage** — screenshots go directly into `.vault/_browser/`, accessible to all vault-aware tools.
- **Localhost-first security** — production domains blocked by default, preventing agents from accidentally modifying live systems.
