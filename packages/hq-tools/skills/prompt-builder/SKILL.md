---
name: prompt-builder
description: >
  Context-enriched prompt building for delegation tasks. This capability is
  automatically available as the build_prompt tool in orchestrator mode.
  It gathers vault context (preferences, memory, project notes, relevant
  knowledge) and structures prompts using 5 philosophies: clear instructions,
  elaborate explanation, sequential design, clear definition of done, and
  context efficiency. You do NOT need to load this skill — it is a core
  orchestrator tool.
---

# Prompt Builder (Core Orchestrator Tool)

This skill is implemented as a core tool (`build_prompt`) available in orchestrator mode. It does not need to be loaded via `load_skill`.

## When It Activates

The orchestrator agent calls `build_prompt` automatically before every `delegate_to_relay` call. The orchestrator prompt mandates this workflow.

## 5 Prompt Philosophies

1. **Clear Instructions** — The objective is rewritten to be unambiguous and specific
2. **Elaborate Explanation** — Relevant vault context (preferences, project notes, memory, search results) is included so the sub-agent understands the broader picture
3. **Sequential Design** — Task-type-aware execution steps are provided in order
4. **Clear Definition of Done** — Explicit acceptance criteria so the sub-agent knows when the task is complete
5. **Context Efficiency** — Only relevant context is included, with per-section character budgets to prevent prompt bloat

## What It Does

1. Detects task type (coding, research, workspace, analysis, writing, devops, general)
2. Detects project name from `Notebooks/Projects/` directory names
3. Searches vault for relevant notes (keyword search)
4. Reads user preferences and relevant memory lines
5. Structures a rich prompt with all sections above

## Output Format

```markdown
# TASK

## Objective
{Clear instruction}

## Context
### User Preferences | Project Context | Relevant Knowledge | Agent Memory
{Filtered vault context}

## Steps
1. {Ordered execution steps}

## Definition of Done
- [ ] {Acceptance criteria}

## Constraints
{Harness-specific and task-type-specific constraints}
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `rawInstruction` | Yes | The user's original task instruction |
| `taskType` | No | Override auto-detection (coding, research, workspace, etc.) |
| `targetHarness` | No | Target relay type for harness-specific constraints |
| `projectName` | No | Explicit project name for context lookup |
| `additionalContext` | No | Extra context the orchestrator wants to include |
