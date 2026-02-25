# vault-gateway

A lightweight authenticated proxy that sits between HQ agents and the [Obsidian Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin. It enforces role-based access control so each agent only touches the vault paths it's allowed to.

## Setup

```bash
bun install
cp .env.example .env
# Edit .env and fill in your values (see below)
```

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `OBSIDIAN_API_KEY` | ✅ | — | API key from the Obsidian Local REST API plugin |
| `OBSIDIAN_REST_HOST` | — | `127.0.0.1` | Host of the Obsidian REST plugin |
| `OBSIDIAN_REST_PORT` | — | `27124` | Port of the Obsidian REST plugin |
| `GATEWAY_PORT` | — | `3001` | Port the gateway listens on |
| `AGENT_TOKENS` | ✅ | — | Comma-separated agent credentials (see below) |
| `MOCK_OBSIDIAN` | — | `false` | Set to `true` to return mock responses (testing) |

### `AGENT_TOKENS` format

```
AGENT_TOKENS="token1:role:id,token2:role:id"
```

- **token** — a strong random string (use `openssl rand -hex 32` to generate one)
- **role** — `admin`, `relay`, or `readonly`
- **id** — a human-readable identifier for the agent

Example:
```
AGENT_TOKENS="abc123:admin:hq-admin,def456:relay:discord-relay"
```

## Running

```bash
bun run index.ts
```

## Testing

```bash
bun test
```

Tests use `MOCK_OBSIDIAN=true` so they don't require a running Obsidian instance.
