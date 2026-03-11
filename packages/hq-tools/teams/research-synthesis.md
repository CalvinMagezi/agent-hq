---
name: research-synthesis
displayName: Research & Synthesis
version: 1.0.0
description: |
  2-stage research pipeline: parallel multi-source research → distillation.
  Best for answering complex questions with multiple angles, market research, technical investigations.
executionMode: standard
estimatedDurationMins: 30
tags: [research, synthesis, analysis, investigation]
synthesisAgent: synthesis-writer

stages:
  - stageId: research
    description: Market analyst and codebase archaeologist research in parallel
    pattern: parallel
    agents: [market-analyst, codebase-archaeologist]
    taskIds: [research-market, research-codebase]

  - stageId: synthesize
    description: Synthesis writer distills parallel research into single deliverable, fact-checker validates
    pattern: sequential
    agents: [synthesis-writer, fact-checker]
    taskIds: [research-synthesize, research-fact-check]
    dependsOnStages: [research]
    gates:
      - gateId: fact-gate
        evaluatorAgent: fact-checker
        evaluatesResultOf: research-synthesize
        maxRetries: 1
        passingOutcome: PASS
        blockOnFailure: false
---
