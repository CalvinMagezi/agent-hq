/**
 * Server functions for the /teams route.
 * Reads agent library, team manifests, performance data, and handles workflow actions.
 */

import { createServerFn } from '@tanstack/react-start'
import * as fs from 'node:fs'
import * as path from 'node:path'
import matter from 'gray-matter'
import { VAULT_PATH } from './vault'

// Resolve paths relative to the workspace root
// One level up from the vault is the repo root
const AGENT_HQ_ROOT = path.resolve(VAULT_PATH, '..')

function tryJsonOrYaml(filePath: string): any {
  if (!fs.existsSync(filePath)) return null
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const match = raw.match(/^---\s*\n([\s\S]*?)\n---/)
    if (match) {
      // Dynamic import yaml
      const js_yaml = require('js-yaml')
      return js_yaml.load(match[1])
    }
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// ── Agent Library ────────────────────────────────────────────────────────────

export interface AgentSummary {
  name: string
  displayName: string
  vertical: string
  baseRole: string
  preferredHarness: string
  tags: string[]
  defaultsTo?: string
  performanceProfile?: {
    targetSuccessRate: number
    keyMetrics: string[]
  }
}

export const getAgentLibrary = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{ agents: AgentSummary[] }> => {
    const agentsRoot = path.join(AGENT_HQ_ROOT, 'packages/hq-tools/agents')
    if (!fs.existsSync(agentsRoot)) return { agents: [] }

    const agents: AgentSummary[] = []
    const verticals = fs.readdirSync(agentsRoot).filter(f =>
      fs.statSync(path.join(agentsRoot, f)).isDirectory()
    )

    for (const vertical of verticals) {
      const vDir = path.join(agentsRoot, vertical)
      const files = fs.readdirSync(vDir).filter(f => f.endsWith('.md'))
      for (const file of files) {
        const fm = tryJsonOrYaml(path.join(vDir, file))
        if (fm) {
          agents.push({
            name: fm.name ?? file.replace('.md', ''),
            displayName: fm.displayName ?? fm.name ?? file.replace('.md', ''),
            vertical: fm.vertical ?? vertical,
            baseRole: fm.baseRole ?? 'researcher',
            preferredHarness: fm.preferredHarness ?? 'claude-code',
            tags: fm.tags ?? [],
            defaultsTo: fm.defaultsTo,
            performanceProfile: fm.performanceProfile,
          })
        }
      }
    }

    return { agents }
  }
)

// ── Team List ────────────────────────────────────────────────────────────────

export interface TeamSummaryItem {
  name: string
  displayName: string
  description: string
  estimatedDurationMins: number
  stageCount: number
  agents: string[]
  tags: string[]
  isCustom: boolean
}

export const getTeamList = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{ teams: TeamSummaryItem[] }> => {
    const teamsRoot = path.join(AGENT_HQ_ROOT, 'packages/hq-tools/teams')
    const vaultTeamsRoot = path.join(VAULT_PATH, '_team-registry')

    const teams: TeamSummaryItem[] = []

    const readTeamsDir = (dir: string, isCustom: boolean) => {
      if (!fs.existsSync(dir)) return
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'))
      for (const file of files) {
        const fm = tryJsonOrYaml(path.join(dir, file))
        if (fm) {
          const agents = Array.from(new Set(
            (fm.stages ?? []).flatMap((s: any) => s.agents ?? [])
          )) as string[]
          teams.push({
            name: fm.name ?? file.replace('.md', ''),
            displayName: fm.displayName ?? fm.name ?? file.replace('.md', ''),
            description: fm.description ?? '',
            estimatedDurationMins: fm.estimatedDurationMins ?? 30,
            stageCount: (fm.stages ?? []).length,
            agents,
            tags: fm.tags ?? [],
            isCustom,
          })
        }
      }
    }

    readTeamsDir(teamsRoot, false)
    readTeamsDir(vaultTeamsRoot, true)

    return { teams }
  }
)

// ── Team Performance ─────────────────────────────────────────────────────────

export interface TeamPerformanceData {
  teamName: string
  totalRuns: number
  successRate: number
  avgDurationMs: number
  latestRuns: any[]
}

export const getTeamPerformance = createServerFn({ method: 'GET' })
  .inputValidator((teamName: string) => teamName)
  .handler(async ({ data: teamName }): Promise<{ performance: TeamPerformanceData | null }> => {
    const summaryPath = path.join(VAULT_PATH, '_metrics', 'teams', teamName, 'summary.md')
    const fm = tryJsonOrYaml(summaryPath)
    if (!fm) return { performance: null }
    return { performance: fm as TeamPerformanceData }
  })

// ── Agent Leaderboard ────────────────────────────────────────────────────────

export const getAgentLeaderboard = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{ leaderboard: any[] }> => {
    const agentsDir = path.join(VAULT_PATH, '_metrics', 'agents')
    if (!fs.existsSync(agentsDir)) return { leaderboard: [] }

    const leaderboard: any[] = []

    for (const agentName of fs.readdirSync(agentsDir)) {
      const agentDir = path.join(agentsDir, agentName)
      if (!fs.statSync(agentDir).isDirectory()) continue

      const runs = fs.readdirSync(agentDir)
        .filter(f => f.startsWith('run-') && f.endsWith('.md'))
        .map(f => tryJsonOrYaml(path.join(agentDir, f)))
        .filter(Boolean)

      if (runs.length === 0) continue

      const avgScore = runs.reduce((s: number, r: any) => s + (r.successScore ?? 0), 0) / runs.length
      leaderboard.push({ agentName, totalRuns: runs.length, successScore: avgScore })
    }

    return { leaderboard: leaderboard.sort((a, b) => b.successScore - a.successScore) }
  }
)

// ── Active Workflows ─────────────────────────────────────────────────────────

export const getActiveWorkflows = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{ workflows: any[] }> => {
    // Read retro notes directory for recent workflows
    const retroDir = path.join(VAULT_PATH, 'Notebooks/Projects/Cloud-HQ/Retros')
    if (!fs.existsSync(retroDir)) return { workflows: [] }

    const files = fs.readdirSync(retroDir)
      .filter(f => f.endsWith('-retro.md'))
      .slice(-20)

    const workflows = files
      .map(f => {
        const raw = tryJsonOrYaml(path.join(retroDir, f))
        return raw ? { ...raw, retroFile: f } : null
      })
      .filter(Boolean)
      .sort((a: any, b: any) => (b.startedAt > a.startedAt ? 1 : -1))

    return { workflows }
  }
)

// ── Pending Optimizations ────────────────────────────────────────────────────

export const getPendingOptimizations = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{ optimizations: any[] }> => {
    const pendingDir = path.join(VAULT_PATH, '_metrics', 'pending-optimizations')
    if (!fs.existsSync(pendingDir)) return { optimizations: [] }

    const opts = fs.readdirSync(pendingDir)
      .filter(f => f.endsWith('.md'))
      .map(f => {
        const data = tryJsonOrYaml(path.join(pendingDir, f))
        return data ? { ...data, _file: f } : null
      })
      .filter(Boolean)

    return { optimizations: opts }
  }
)

// ── Apply Optimization ───────────────────────────────────────────────────────

interface ApplyOptimizationInput {
  file: string
  approved: boolean
}

export const applyOptimization = createServerFn({ method: 'POST' })
  .inputValidator((d: ApplyOptimizationInput) => d)
  .handler(async ({ data }): Promise<{ success: boolean }> => {
    const pendingDir = path.join(VAULT_PATH, '_metrics', 'pending-optimizations')
    const filePath = path.join(pendingDir, data.file)

    if (!fs.existsSync(filePath)) return { success: false }

    if (data.approved) {
      // Move to applied/
      const appliedDir = path.join(VAULT_PATH, '_metrics', 'applied-optimizations')
      fs.mkdirSync(appliedDir, { recursive: true })
      fs.renameSync(filePath, path.join(appliedDir, data.file))
    } else {
      // Move to rejected/
      const rejectedDir = path.join(VAULT_PATH, '_metrics', 'rejected-optimizations')
      fs.mkdirSync(rejectedDir, { recursive: true })
      fs.renameSync(filePath, path.join(rejectedDir, data.file))
    }

    return { success: true }
  })

// ── Save Custom Team ─────────────────────────────────────────────────────────

export const saveCustomTeam = createServerFn({ method: 'POST' })
  .inputValidator((team: any) => team)
  .handler(async ({ data: team }): Promise<{ success: boolean; teamId: string }> => {
    const registryDir = path.join(VAULT_PATH, '_team-registry')
    fs.mkdirSync(registryDir, { recursive: true })

    const teamId = team.name ?? `custom-team-${Date.now()}`
    const js_yaml = require('js-yaml')
    const content = `---\n${js_yaml.dump(team)}---\n`
    fs.writeFileSync(path.join(registryDir, `${teamId}.md`), content, 'utf-8')

    return { success: true, teamId }
  })

// ── Launch Team Workflow ─────────────────────────────────────────────────────

interface LaunchWorkflowInput {
  teamName: string
  instruction: string
}

export const launchTeamWorkflow = createServerFn({ method: 'POST' })
  .inputValidator((d: LaunchWorkflowInput) => d)
  .handler(async ({ data }): Promise<{ success: boolean; workflowId: string }> => {
    // Write a job to vault for the daemon to pick up
    const jobId = `workflow-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`
    const pendingDir = path.join(VAULT_PATH, '_jobs/pending')
    fs.mkdirSync(pendingDir, { recursive: true })

    const content = `---
type: team-workflow
teamName: ${data.teamName}
status: pending
createdAt: "${new Date().toISOString()}"
instruction: |
  ${data.instruction.split('\n').join('\n  ')}
---
`
    fs.writeFileSync(path.join(pendingDir, `${jobId}.md`), content, 'utf-8')
    return { success: true, workflowId: jobId }
  })
