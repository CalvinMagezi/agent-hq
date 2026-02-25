---
name: code-mapper
description: Deterministic codebase parser that maps TypeScript repositories into Obsidian graph notes for zero-token dependency context.
---
# Code Mapper Skill

The Code Mapper skill provides deterministic, static analysis of a codebase to generate precise "blast radius" and dependency context. It builds a graph of `[[wikilinks]]` in the agent's Obsidian vault.

## Capabilities

1. **Mapping a Repository**: The mapper uses `ts-morph` to traverse a TypeScript repository, extract all exports (functions, classes, interfaces), and resolve all local imports into graph links.
2. **Context Enrichment**: Instead of reading massive files or guessing dependencies, you can query the generated graph via the MCP `code-graph` tools to see exactly what a file imports and what imports it.

## Agent Workflow (Code Mode Protocol)

When directed to refactor, modify, or explore existing code, you MUST use the graph:

1. **CALL `get_blast_radius`** on the target file FIRST.
   - Review the dependent files to ensure your proposed changes do not break existing contracts.
2. **CALL `get_dependency_context`** to understand what the target file imports and relies upon.
3. If the repository hasn't been mapped yet, **CALL `map_repository`** to build the structural graph.

## File Generation Standard

The mapper generates Markdown notes with the following structure:

```markdown
---
type: file
repo: [Repo Name]
path: [Relative Path]
exports: [Export A, Export B]
---
# [Filename]

## Summary
*(Pending AI documentation)*

## Outbound Dependencies
- [[Relative/Path/To/Dependency1]]
- [[Relative/Path/To/Dependency2]]

## Inbound Dependents (Backlinks)
*(Auto-populated by Obsidian)*
```
