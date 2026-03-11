---
name: content-pipeline
displayName: Content Pipeline
version: 1.0.0
description: |
  3-stage content production pipeline: research → write → audit.
  Best for technical blog posts, documentation, or reports requiring verified accuracy.
executionMode: standard
estimatedDurationMins: 45
tags: [content, documentation, writing, audit]
synthesisAgent: technical-writer

stages:
  - stageId: research
    description: Market analyst + codebase archaeologist gather content sources in parallel
    pattern: parallel
    agents: [market-analyst, codebase-archaeologist]
    taskIds: [content-research-market, content-research-codebase]

  - stageId: write
    description: Technical writer produces the content
    pattern: sequential
    agents: [technical-writer]
    taskIds: [content-write]
    dependsOnStages: [research]

  - stageId: audit
    description: Documentation auditor reviews accuracy; fact-checker verifies claims
    pattern: sequential
    agents: [documentation-auditor, fact-checker]
    taskIds: [content-audit, content-fact-check]
    dependsOnStages: [write]
    gates:
      - gateId: doc-audit-gate
        evaluatorAgent: documentation-auditor
        evaluatesResultOf: content-write
        maxRetries: 2
        passingOutcome: PASS
        blockOnFailure: false
---
