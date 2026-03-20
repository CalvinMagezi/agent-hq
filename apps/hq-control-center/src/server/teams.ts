/**
 * Server functions for the /teams route.
 * Reads agent library, team manifests, performance data, and handles workflow actions.
 */

import { createServerFn } from '@tanstack/react-start'
import * as fs from 'node:fs'
import * as path from 'node:path'
import matter from 'gray-matter'
import { VAULT_PATH } from './vault'

// Resolve repo root: vault is always at {REPO_ROOT}/.vault
const AGENT_HQ_ROOT = path.resolve(VAULT_PATH, '..')

function tryJsonOrYaml(filePath: string): any {
  if (!fs.existsSync(filePath)) return null
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const { data } = matter(raw)
    return data && Object.keys(data).length > 0 ? data : null
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

/** Raw data loader — call directly from route loaders (same process, no serialization) */
export async function fetchAgentLibrary(): Promise<{ agents: AgentSummary[] }> {
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
          preferredHarness: fm.preferredHarness ?? 'hq',
          tags: fm.tags ?? [],
          defaultsTo: fm.defaultsTo,
          performanceProfile: fm.performanceProfile,
        })
      }
    }
  }

  return { agents }
}

export const getAgentLibrary = createServerFn({ method: 'GET' }).handler(fetchAgentLibrary)

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

export async function fetchTeamList(): Promise<{ teams: TeamSummaryItem[] }> {
  const teamsRoot = path.join(AGENT_HQ_ROOT, 'packages/hq-tools/teams')
  const vaultTeamsRoot = path.join(VAULT_PATH, '_team-registry')
  const teams: TeamSummaryItem[] = []

  const readTeamsDir = (dir: string, isCustom: boolean) => {
    if (!fs.existsSync(dir)) return
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.md'))) {
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
          agents, tags: fm.tags ?? [], isCustom,
        })
      }
    }
  }

  readTeamsDir(teamsRoot, false)
  readTeamsDir(vaultTeamsRoot, true)
  return { teams }
}

export const getTeamList = createServerFn({ method: 'GET' }).handler(fetchTeamList)

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

export async function fetchAgentLeaderboard(): Promise<{ leaderboard: any[] }> {
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

export const getAgentLeaderboard = createServerFn({ method: 'GET' }).handler(fetchAgentLeaderboard)

// ── Active Workflows ─────────────────────────────────────────────────────────

export async function fetchActiveWorkflows(): Promise<{ workflows: any[] }> {
  const retroDir = path.join(VAULT_PATH, 'Notebooks/Projects/Agent-HQ/Retros')
  if (!fs.existsSync(retroDir)) return { workflows: [] }
  const files = fs.readdirSync(retroDir).filter(f => f.endsWith('-retro.md')).slice(-20)
  const workflows = files
    .map(f => { const raw = tryJsonOrYaml(path.join(retroDir, f)); return raw ? { ...raw, retroFile: f } : null })
    .filter(Boolean)
    .sort((a: any, b: any) => (b.startedAt > a.startedAt ? 1 : -1))
  return { workflows }
}

export const getActiveWorkflows = createServerFn({ method: 'GET' }).handler(fetchActiveWorkflows)

// ── Pending Optimizations ────────────────────────────────────────────────────

export async function fetchPendingOptimizations(): Promise<{ optimizations: any[] }> {
  const pendingDir = path.join(VAULT_PATH, '_metrics', 'pending-optimizations')
  if (!fs.existsSync(pendingDir)) return { optimizations: [] }
  const opts = fs.readdirSync(pendingDir)
    .filter(f => f.endsWith('.md'))
    .map(f => { const data = tryJsonOrYaml(path.join(pendingDir, f)); return data ? { ...data, _file: f } : null })
    .filter(Boolean)
  return { optimizations: opts }
}

export const getPendingOptimizations = createServerFn({ method: 'GET' }).handler(fetchPendingOptimizations)

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
    const content = matter.stringify('', team)
    fs.writeFileSync(path.join(registryDir, `${teamId}.md`), content, 'utf-8')

    return { success: true, teamId }
  })

// ── Launch Team Workflow ─────────────────────────────────────────────────────

interface LaunchWorkflowInput {
  teamName: string
  instruction: string
  harnessOverride?: string
}

export const launchTeamWorkflow = createServerFn({ method: 'POST' })
  .inputValidator((d: LaunchWorkflowInput) => d)
  .handler(async ({ data }): Promise<{ success: boolean; workflowId: string; status?: string; durationMs?: number }> => {
    const { WorkflowEngine, getTeam } = await import('@repo/hq-tools')

    const team = getTeam(data.teamName)
    if (!team) throw new Error(`Team '${data.teamName}' not found`)

    const engine = new WorkflowEngine(VAULT_PATH)
    const result = await engine.run({
      team,
      instruction: data.instruction,
      executionMode: 'standard',
      harnessOverride: data.harnessOverride as any,
    })

    return {
      success: result.status === 'completed',
      workflowId: result.runId,
      status: result.status,
      durationMs: result.durationMs,
    }
  })
