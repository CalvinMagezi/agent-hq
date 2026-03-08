---
name: google-workspace
description: "Google Workspace interactions (Gmail, Drive, Calendar, Docs, Sheets, Chat) via gws CLI. Auto-loaded for all agents."
---

# Google Workspace Skill

Interact with Gmail, Drive, Calendar, Sheets, Docs, and Chat. The `gws` CLI is globally installed on this machine — use it directly via bash OR via the HQ tool gateway depending on your context.

## Which Mode To Use

| Context | How to call |
|---------|-------------|
| HQ Agent (has `hq_call`) | `hq_call google_workspace_read / write / schema` |
| Relay harness / Claude Code / OpenCode (has bash) | `gws <service> <resource> <method> [flags]` directly |

---

## Mode A: HQ Tool Gateway (`hq_call`)

### Schema introspection (always do this first for unfamiliar methods)
```
hq_call google_workspace_schema { "method": "drive.files.list" }
```

### Read (list/get/search)
```
hq_call google_workspace_read {
  "service": "gmail",
  "resource": "users.messages",
  "method": "list",
  "params": { "userId": "me", "q": "is:unread", "maxResults": 10 }
}
```

### Write (create/send/update/delete)
```
hq_call google_workspace_write {
  "service": "calendar",
  "resource": "events",
  "method": "insert",
  "params": { "calendarId": "primary" },
  "body": { "summary": "Meeting", "start": { "dateTime": "2026-03-10T10:00:00Z" }, "end": { "dateTime": "2026-03-10T11:00:00Z" } }
}
```

Flags: `pageAll: true` (fetch all pages), `pageLimit: N`, `dryRun: true` (preview without executing).

---

## Mode B: Direct `gws` CLI (relay harnesses / bash)

```bash
# Invocation pattern
gws <service> <resource> <method> [--params '{}'] [--json '{}'] [--page-all] [--dry-run]

# Read examples
gws drive files list --params '{"pageSize": 5, "orderBy": "modifiedTime desc"}'
gws gmail users.messages list --params '{"userId": "me", "q": "is:unread", "maxResults": 10}'
gws calendar events list --params '{"calendarId": "primary", "singleEvents": true}'
gws sheets spreadsheets.values get --params '{"spreadsheetId": "SHEET_ID", "range": "Sheet1!A1:D10"}'

# Write examples
gws calendar events insert --params '{"calendarId": "primary"}' \
  --json '{"summary": "Meeting", "start": {"dateTime": "2026-03-10T10:00:00Z"}, "end": {"dateTime": "2026-03-10T11:00:00Z"}}'
gws sheets spreadsheets.values append \
  --params '{"spreadsheetId": "SHEET_ID", "range": "Sheet1", "valueInputOption": "USER_ENTERED"}' \
  --json '{"values": [["Row data", "More data"]]}'
gws docs documents create --json '{"title": "New Document"}'

# Schema introspection
gws schema drive.files.list
gws schema gmail.users.messages.send
```

---

## Service Reference

| Service | Resource | Read methods | Write methods |
|---------|----------|-------------|---------------|
| `gmail` | `users.messages` | `list`, `get` | `send`, `delete`, `trash` |
| `gmail` | `users.labels` | `list`, `get` | `create`, `patch`, `delete` |
| `drive` | `files` | `list`, `get` | `create`, `update`, `delete`, `copy` |
| `calendar` | `events` | `list`, `get` | `insert`, `patch`, `delete` |
| `calendar` | `calendarList` | `list`, `get` | — |
| `sheets` | `spreadsheets` | `get` | `create` |
| `sheets` | `spreadsheets.values` | `get`, `batchGet` | `update`, `append`, `batchUpdate` |
| `docs` | `documents` | `get` | `create`, `batchUpdate` |
| `chat` | `spaces` | `list`, `get` | `create` |
| `chat` | `spaces.messages` | `list`, `get` | `create`, `delete` |

---

## Authentication
Credentials stored at `~/.config/gws/credentials.enc`. If auth fails (`invalid_grant` / "No credentials found"), ask the user to run: `gws auth login -s drive,gmail,calendar,sheets,docs,chat`

## Troubleshooting
| Error | Fix |
|-------|-----|
| `gws not found` | `npm install -g @googleworkspace/cli` |
| `invalid_grant` / auth error | `gws auth login` |
| `403 Forbidden` | Missing OAuth scope — re-run `gws auth login` with correct `-s` flags |
| `400 Bad Request` | Run `gws schema <method>` to check correct params/body shape |
