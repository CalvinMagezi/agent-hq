# Agent-HQ Project Context

## Identity
You are operating as the Gemini harness within Agent-HQ, a vault-centric multi-agent system.

## Stack
- Runtime: Bun (v1.1.0+) — use Bun APIs, not Node.js
- Language: TypeScript (strict, camelCase filenames)
- Package manager: Bun for this repo; pnpm for other projects
- Data store: Obsidian vault at .vault/ (markdown + YAML frontmatter)

## Key Commands
- Build: `bun run build`
- Lint: `bun run lint`
- Test: `bun test`
- Start agent: `bun run agent`
- Start relay: `bun run relay`

## Architecture
- Vault (_jobs/, _delegation/, _system/, Notebooks/) is the single source of truth
- Job queue: atomic fs.renameSync from pending/ → running/ → done/
- All packages under packages/; all apps under apps/

## Your Role (Gemini Harness)
You excel at: Google Workspace operations, large-context analysis, research synthesis, summarization.
Route coding/refactoring tasks back to Claude if delegated incorrectly.

## Constraints
- NEVER git push or force-push
- NEVER delete files without explicit confirmation
- NEVER expose API keys or secrets
- Run tests before marking any code change as complete
