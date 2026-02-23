# Contributing to Agent-HQ

Thank you for your interest in contributing! Agent-HQ is a local-first AI agent hub — contributions that maintain the local-first, privacy-respecting design are especially welcome.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/your-username/agent-hq.git`
3. Install dependencies: `bun install`
4. Copy env examples:
   ```bash
   cp .env.example .env.local
   cp apps/agent/.env.example apps/agent/.env.local
   cp apps/discord-relay/.env.example apps/discord-relay/.env.local
   ```
5. Initialize your vault: `bun run setup`

## Development

```bash
bun run agent     # Start the HQ agent
bun run relay     # Start Discord relay bots
bun run daemon    # Start background daemon
bun run chat      # Terminal chat REPL
bun run build     # Build all packages
bun run lint      # Lint all packages
```

## Project Principles

- **Local-first**: Data stays on your machine. No cloud backends. No telemetry.
- **Vault-as-database**: All state is markdown + YAML frontmatter in `.vault/`
- **Security by default**: New tools should default to the most restrictive security profile
- **Atomic operations**: Job/task claiming must use `fs.renameSync` for race safety
- **No hardcoded secrets**: All credentials via environment variables only

## Code Style

- **TypeScript** with strict mode — no `any` unless truly necessary
- **camelCase** for source files (`vaultApi.ts`, not `vault-api.ts`)
- **Bun** as package manager and runtime
- Frontmatter parsed with `gray-matter` — don't roll your own parser

## Security

⚠️ **Never commit:**
- API keys, tokens, or secrets (use `.env.local`, gitignored)
- Machine-specific config (`.plist` files — use `.plist.example` with `__HOME__` placeholders)
- Runtime state files (session files, worker IDs, usage data)
- The `.vault/` directory (personal data)

The pre-commit hook at `scripts/hooks/pre-commit` scans for common API key patterns. Install it:
```bash
cp scripts/hooks/pre-commit .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

## Pull Requests

1. Keep PRs focused — one feature/fix per PR
2. Update `CHANGELOG.md` under `[Unreleased]`
3. Ensure `bun run lint` passes
4. Test locally with a real vault before submitting

## Issues

Use GitHub Issues for:
- Bug reports (include OS, Bun version, error logs)
- Feature requests (describe the use case, not just the implementation)
- Security vulnerabilities — please use GitHub's private security advisory instead of public issues

## License

By contributing, you agree your contributions will be licensed under the [MIT License](LICENSE).
