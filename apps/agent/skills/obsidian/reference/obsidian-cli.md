# Obsidian CLI Reference

Interact with Obsidian vaults using the Obsidian CLI to read, create, search, and manage notes, tasks, properties, and more. Requires Obsidian to be open.

## Command Reference

Run `obsidian help` to see all available commands. Full docs: https://help.obsidian.md/cli

## Syntax

**Parameters** take a value with `=`. Quote values with spaces:

```bash
obsidian create name="My Note" content="Hello world"
```

**Flags** are boolean switches with no value:

```bash
obsidian create name="My Note" silent overwrite
```

For multiline content use `\n` for newline and `\t` for tab.

## File Targeting

- `file=<name>` — resolves like a wikilink (name only, no path or extension needed)
- `path=<path>` — exact path from vault root, e.g. `folder/note.md`
- Without either, the active file is used

## Vault Targeting

Commands target the most recently focused vault by default. Use `vault=<name>` as the first parameter:

```bash
obsidian vault="My Vault" search query="test"
```

## Common Patterns

```bash
obsidian read file="My Note"
obsidian create name="New Note" content="# Hello" template="Template" silent
obsidian append file="My Note" content="New line"
obsidian search query="search term" limit=10
obsidian daily:read
obsidian daily:append content="- [ ] New task"
obsidian property:set name="status" value="done" file="My Note"
obsidian tasks daily todo
obsidian tags sort=count counts
obsidian backlinks file="My Note"
```

Use `--copy` to copy output to clipboard. Use `silent` to prevent files from opening. Use `total` on list commands to get a count.

## Plugin Development

```bash
obsidian plugin:reload id=my-plugin          # Reload after code changes
obsidian eval code="app.vault.getFiles().length"  # Run JavaScript
obsidian dev:errors                           # Check for errors
obsidian dev:console                          # Console output
obsidian dev:console level=error              # Filter by level
obsidian dev:screenshot path=screenshot.png   # Screenshot
obsidian dev:dom selector=".workspace-leaf" text  # Inspect DOM
obsidian dev:css selector=".workspace-leaf" prop=background-color
obsidian dev:mobile on                        # Mobile emulation
```

## References

- [Obsidian CLI Docs](https://help.obsidian.md/cli)
