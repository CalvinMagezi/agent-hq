# CLAUDE.md — Context Engine

## What This Package Does

`@repo/context-engine` is the unified context management layer for Agent HQ. It replaces the ad-hoc context assembly scattered across relay adapters (Discord's `ContextEnricher`, REST route inline code, etc.) with a single `buildFrame()` call that returns a token-budgeted `ContextFrame`.

## Key Concepts

- **ContextFrame** — The structured output of the engine. Contains system prompt, memory, conversation turns, injections (notes/search), and token budget accounting.
- **Token Budget** — Every frame has a declared budget. Layers (system, memory, thread, injections) each get an allocation based on the active profile. Surplus cascades from underspent layers to those that need more.
- **Compaction** — When a layer exceeds its budget, strategies are applied: thread summarization, injection pruning, text truncation.
- **Budget Profiles** — Pre-configured allocations mapped to Agent HQ's execution modes: `quick`, `standard`, `thorough`, `delegation`.
- **Chunk Index** — Notes are split into ~200-token chunks and scored by relevance, recency, pin status, and tag overlap.

## Architecture

```
src/
├── index.ts              # ContextEngine class (public API) + re-exports
├── types.ts              # All type definitions
├── tokenizer/
│   ├── counter.ts        # Token counting (heuristic + tiktoken)
│   └── models.ts         # Model context window limits
├── budget/
│   ├── allocator.ts      # Budget allocation + surplus cascading
│   └── profiles.ts       # Budget profiles (quick/standard/thorough/delegation)
├── layers/
│   ├── system.ts         # Soul + harness instruction assembly
│   ├── memory.ts         # Memory + preferences + structured facts
│   ├── thread.ts         # Conversation history with compaction
│   ├── injections.ts     # Notes, search, reply-to, extras with pruning
│   └── userMessage.ts    # Current turn processing
├── compaction/
│   ├── threadCompactor.ts # LLM summarization + extractive fallback
│   ├── chunkTruncator.ts  # Sentence-boundary-aware truncation
│   └── summarizer.ts      # Extractive summarizer (no LLM needed)
├── vault/
│   ├── adapter.ts        # VaultClientLike adapter + mock factory
│   └── chunkIndex.ts     # Note chunking, scoring, in-memory index
├── observability/
│   ├── metrics.ts        # Token usage tracking, compaction events
│   └── tracing.ts        # Frame assembly tracing
└── __tests__/
    └── engine.test.ts    # 17 tests covering all core modules
```

## Usage

```typescript
import { ContextEngine } from "@repo/context-engine";

const engine = new ContextEngine({
  vault,                          // VaultClientLike instance
  model: "claude-sonnet-4-5",     // Determines token limit
  profile: "standard",            // Budget allocation profile
});

const frame = await engine.buildFrame({
  threadId: "thread-abc123",
  userMessage: "Help me refactor the auth module",
  harnessHint: "claude-code",
});

// frame.system → system prompt (--append-system-prompt)
// engine.flatten(frame) → single string for CLI harnesses
// frame.budget → token accounting for observability
```

## Integration Points

The engine replaces/augments context code in:
1. `apps/discord-relay/src/bot.ts` — Uses ContextEngine with fallback to ContextEnricher
2. `packages/agent-relay-server/src/rest/routes.ts` — REST chat endpoint uses ContextEngine
3. `apps/relay-adapter-whatsapp/` — Ready for integration
4. `apps/relay-adapter-telegram/` — Ready for integration

## Testing

```bash
cd packages/context-engine && bun test
```

## Dependencies

- `@repo/vault-client` — Reads SOUL, MEMORY, notes, threads from the vault
- `gray-matter` — YAML frontmatter parsing
- `js-tiktoken` (optional) — Precise token counting when `precision: true`
