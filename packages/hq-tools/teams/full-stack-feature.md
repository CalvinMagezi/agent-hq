---
name: full-stack-feature
displayName: Full Stack Feature
version: 1.0.0
description: |
  4-stage full feature pipeline: plan → build (parallel) → review → deploy.
  Best for complete features that require UI + backend + testing + deployment.
executionMode: thorough
estimatedDurationMins: 90
tags: [engineering, full-stack, feature, deployment]
synthesisAgent: synthesis-writer

stages:
  - stageId: planning
    description: Feature coder plans the full stack implementation
    pattern: sequential
    agents: [feature-coder]
    taskIds: [feature-plan]
    gates:
      - gateId: plan-gate
        evaluatorAgent: reality-checker
        evaluatesResultOf: feature-plan
        maxRetries: 2
        passingOutcome: PASS
        blockOnFailure: true

  - stageId: build
    description: Feature coder implements, test engineer writes tests in parallel
    pattern: parallel
    agents: [feature-coder, test-engineer]
    taskIds: [feature-implement, feature-tests]
    dependsOnStages: [planning]

  - stageId: review
    description: Security auditor + reality checker + evidence collector run in parallel
    pattern: parallel
    agents: [security-auditor, reality-checker, evidence-collector]
    taskIds: [feature-security, feature-qa, feature-evidence]
    dependsOnStages: [build]
    gates:
      - gateId: evidence-gate
        evaluatorAgent: evidence-collector
        evaluatesResultOf: feature-implement
        maxRetries: 2
        passingOutcome: PASS
        blockOnFailure: true

  - stageId: deploy
    description: Deployment guardian executes safe deployment with dry-run
    pattern: sequential
    agents: [deployment-guardian]
    taskIds: [feature-deploy]
    dependsOnStages: [review]
---
