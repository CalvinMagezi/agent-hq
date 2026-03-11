---
name: engineering-sprint
displayName: Engineering Sprint
version: 1.0.0
description: |
  A 3-stage engineering pipeline: plan → implement → review.
  Best for well-defined feature work where requirements are clear and code needs to ship with review.
executionMode: standard
estimatedDurationMins: 45
tags: [engineering, feature, sprint, implementation, review]
synthesisAgent: synthesis-writer

stages:
  - stageId: planning
    description: Feature Coder reads codebase and creates implementation plan
    pattern: sequential
    agents: [feature-coder]
    taskIds: [sprint-plan]

  - stageId: implementation
    description: Feature Coder implements the plan
    pattern: sequential
    agents: [feature-coder]
    taskIds: [sprint-implement]
    dependsOnStages: [planning]
    gates:
      - gateId: plan-gate
        evaluatorAgent: reality-checker
        evaluatesResultOf: sprint-plan
        maxRetries: 2
        passingOutcome: PASS
        blockOnFailure: true

  - stageId: review
    description: Security auditor + reality checker review the implementation in parallel
    pattern: parallel
    agents: [security-auditor, reality-checker]
    taskIds: [sprint-security-review, sprint-qa-review]
    dependsOnStages: [implementation]
    gates:
      - gateId: qa-gate
        evaluatorAgent: reality-checker
        evaluatesResultOf: sprint-implement
        maxRetries: 2
        passingOutcome: PASS
        blockOnFailure: false
---
