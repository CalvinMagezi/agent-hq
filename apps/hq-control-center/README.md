# HQ Control Center

PWA dashboard for Agent-HQ. Built with TanStack Start, React 19, and Vite PWA.

## What It Does

- Real-time streaming of agent responses via WebSocket
- Vault search and note browsing
- Daemon status monitoring
- Harness switching (Claude Code, Gemini CLI, OpenCode, etc.)
- Document viewers for DOCX, XLSX, and PDF files
- Push notifications for completed tasks
- Installable as a PWA on any device

## Architecture

The PWA connects to two backends:

- **Rust API/WS** (port 5678) -- WebSocket streaming, REST endpoints for vault status, daemon status, search, and health
- **TanStack Start SSR** (port 4747) -- server-side rendering for the React app

For HTTPS access (e.g., over Tailscale), a Caddy reverse proxy config is provided at the repo root (`Caddyfile`).

## Development

```bash
bun install
bun run dev          # start dev server on port 4747
```

## Build

```bash
bun run build        # builds to dist/
bun run start        # serve the production build
```

## Key Dependencies

| Package | Purpose |
|---------|---------|
| @tanstack/react-start | SSR framework |
| @tanstack/react-query | Data fetching |
| @tanstack/react-router | File-based routing |
| zustand | State management |
| framer-motion | Animations |
| shiki | Code syntax highlighting |
| recharts | Charts and graphs |
| marked | Markdown rendering |
| mammoth | DOCX rendering |
| xlsx | Spreadsheet rendering |
| pdfjs-dist | PDF rendering |
| dompurify | HTML sanitization |
| vite-plugin-pwa | PWA support (service worker, manifest) |
| tailwindcss v4 | Styling |

## WebSocket Protocol

The PWA connects to `ws://localhost:5678/ws` (or the Tailscale HTTPS equivalent). Messages are JSON:

```json
{ "type": "agent_message", "data": { "content": "...", "streaming": true } }
{ "type": "vault_update", "data": { "path": "..." } }
{ "type": "daemon_status", "data": { ... } }
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/api/vault-status` | GET | Vault statistics |
| `/api/daemon-status` | GET | Daemon task status |
| `/api/news` | GET | News pulse data |
| `/api/search?q=...` | GET | Vault search |
| `/api/vault-asset?path=...` | GET | Serve vault files |
| `/api/wa-message` | POST | WhatsApp bridge message relay |
