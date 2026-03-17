# CLAUDE.md

## What This Is

Agent-HQ: Bun monorepo, local-first AI agent hub. Data lives in `.vault/` (Obsidian vault, gitignored). Package manager: **Bun**.

## Rules

- camelCase for source files (e.g., `vaultApi.ts`, not `vault-api.ts`)
- `packages/convex/` is archived legacy — do not use or modify
- `packages/vault-mcp/` was removed — all vault tools now in `packages/hq-tools/`
- Frontmatter parsing: always use `gray-matter` (not custom YAML parsing)
- Job/task claiming: `fs.renameSync` for atomic operations (ENOENT = lost race)
- `.vault/_embeddings/` is gitignored (SQLite DBs for search + sync)
- LLM provider: OpenRouter (model config in `apps/agent/lib/modelConfig.ts`)
- bun:sqlite gotcha: use `db.prepare(...).run()` not `db.run()` with named params
- Timer types: use `ReturnType<typeof setTimeout>` not `Timer` for cross-tsconfig compat

## Entry Points

| What | Path |
|------|------|
| CLI (all management) | `scripts/hq.ts` |
| Agent worker | `apps/agent/index.ts` |
| Discord relay | `apps/discord-relay/index.ts` |
| Daemon (crons) | `scripts/agent-hq-daemon.ts` |
| MCP server | `packages/hq-tools/src/mcp.ts` |
| Terminal chat | `scripts/agent-hq-chat.ts` |

## Development

All commands from monorepo root:

```bash
bun run build    # Workspace-wide production build
bun run lint     # Lint all packages
bun run check    # Lint + build all packages
bun run agent    # Start HQ agent
bun run relay    # Start Discord relay
bun run chat     # Terminal chat interface
bun run daemon   # Background workflow daemon
```

## Workspaces

- `apps/*` — agent, discord-relay, relay adapters
- `packages/*` — vault-client, hq-tools, vault-sync, discord-core, env-loader, etc.
- `plugins/*` — obsidian-vault-sync
