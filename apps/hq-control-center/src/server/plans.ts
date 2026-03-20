import * as fs from 'node:fs'
import * as path from 'node:path'
import { createServerFn } from '@tanstack/react-start'
import matter from 'gray-matter'
import { VAULT_PATH } from './vault'

// ─── Types ───────────────────────────────────────────────────────────────────

export type PlanStatus = 'delegated' | 'in_progress' | 'planning' | 'completed' | 'failed' | 'abandoned'
export type PlanMode = 'act' | 'sketch' | 'blueprint'

export interface PlanSummary {
  planId: string
  title: string
  project: string
  status: PlanStatus
  planningMode: PlanMode
  ambiguityScore: number
  phaseCount: number
  assetCount: number
  createdAt: string
  updatedAt: string
  completedAt?: string
  outcome?: string
  folder: string      // relative: _plans/active/... or _plans/archive/...
  archived: boolean
}

export interface PlanDetail extends PlanSummary {
  content: string     // full plan.md body (markdown, no frontmatter)
  frontmatter: Record<string, any>
  assets: Array<{ type: string; filename: string; label: string }>
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readPlanFromDir(absDir: string, relativeTo: string): PlanSummary | null {
  const planMd = path.join(absDir, 'plan.md')
  if (!fs.existsSync(planMd)) return null

  try {
    const raw = fs.readFileSync(planMd, 'utf-8')
    const { data } = matter(raw)
    if (!data.planId) return null

    // Count assets from manifest if present
    let assetCount = 0
    const manifestPath = path.join(absDir, 'manifest.json')
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
        assetCount = manifest.assets?.length ?? 0
      } catch { /* ignore */ }
    }

    // Count phases — try to parse from content
    const rawBody = matter(raw).content
    const phaseMatches = rawBody.match(/^### Phase \d+/gm)
    const phaseCount = phaseMatches?.length ?? 0

    const relFolder = path.relative(VAULT_PATH, absDir)
    const archived = relFolder.includes('_plans/archive') || relFolder.includes('_plans\\archive')

    return {
      planId: data.planId,
      title: data.title || data.planId,
      project: data.project || 'default',
      status: data.status || 'delegated',
      planningMode: data.planningMode || 'sketch',
      ambiguityScore: data.ambiguityScore ?? 0,
      phaseCount,
      assetCount,
      createdAt: data.createdAt || '',
      updatedAt: data.updatedAt || '',
      completedAt: data.completedAt,
      outcome: data.outcome,
      folder: relFolder,
      archived,
    }
  } catch {
    return null
  }
}

function scanPlanDir(dir: string): PlanSummary[] {
  if (!fs.existsSync(dir)) return []
  const results: PlanSummary[] = []

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name)
      if (entry.isDirectory() && entry.name.startsWith('plan-')) {
        const summary = readPlanFromDir(entryPath, dir)
        if (summary) results.push(summary)
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        // Legacy flat file
        try {
          const raw = fs.readFileSync(entryPath, 'utf-8')
          const { data } = matter(raw)
          if (!data.planId) continue
          const relFolder = path.relative(VAULT_PATH, dir)
          results.push({
            planId: data.planId,
            title: data.title || entry.name.replace('.md', ''),
            project: data.project || 'default',
            status: data.status || 'delegated',
            planningMode: data.planningMode || 'sketch',
            ambiguityScore: data.ambiguityScore ?? 0,
            phaseCount: 0,
            assetCount: 0,
            createdAt: data.createdAt || '',
            updatedAt: data.updatedAt || '',
            completedAt: data.completedAt,
            outcome: data.outcome,
            folder: relFolder,
            archived: relFolder.includes('archive'),
          })
        } catch { /* ignore */ }
      }
    }
  } catch { /* dir unreadable */ }

  return results
}

// ─── Server Functions ─────────────────────────────────────────────────────────

export const getPlans = createServerFn({ method: 'GET' })
  .inputValidator((d: { status?: string; search?: string; includeArchived?: boolean }) => d)
  .handler(async ({ data }) => {
    const activeDir = path.join(VAULT_PATH, '_plans', 'active')
    const archiveDir = path.join(VAULT_PATH, '_plans', 'archive')

    let plans: PlanSummary[] = [
      ...scanPlanDir(activeDir),
      ...(data.includeArchived ? scanPlanDir(archiveDir) : []),
    ]

    // Filter by status
    if (data.status && data.status !== 'all') {
      plans = plans.filter(p => p.status === data.status)
    }

    // Filter by search query (title or project)
    if (data.search?.trim()) {
      const q = data.search.trim().toLowerCase()
      plans = plans.filter(p =>
        p.title.toLowerCase().includes(q) ||
        p.project.toLowerCase().includes(q) ||
        p.planId.toLowerCase().includes(q)
      )
    }

    // Sort: in_progress first, then by updatedAt desc
    const statusOrder: Record<string, number> = {
      in_progress: 0,
      delegated: 1,
      planning: 2,
      completed: 3,
      failed: 4,
      abandoned: 5,
    }
    plans.sort((a, b) => {
      const so = (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9)
      if (so !== 0) return so
      return (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || '')
    })

    return { plans, total: plans.length }
  })

export const getPlanDetail = createServerFn({ method: 'GET' })
  .inputValidator((d: { planId: string }) => d)
  .handler(async ({ data }) => {
    // Validate planId format to prevent path traversal
    if (!data.planId || !/^plan-[a-zA-Z0-9_-]{1,80}$/.test(data.planId)) {
      return { plan: null }
    }

    // Try active first, then archive
    const dirs = [
      path.join(VAULT_PATH, '_plans', 'active', data.planId),
      path.join(VAULT_PATH, '_plans', 'archive', data.planId),
    ]

    for (const dir of dirs) {
      const planMd = path.join(dir, 'plan.md')
      if (!fs.existsSync(planMd)) continue

      try {
        const raw = fs.readFileSync(planMd, 'utf-8')
        const { data: fm, content } = matter(raw)

        // Read asset list from manifest
        let assets: PlanDetail['assets'] = []
        const manifestPath = path.join(dir, 'manifest.json')
        if (fs.existsSync(manifestPath)) {
          try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
            assets = (manifest.assets || []).map((a: any) => ({
              type: a.asset_type,
              filename: a.filename,
              label: a.label,
            }))
          } catch { /* ignore */ }
        }

        const phaseMatches = content.match(/^### Phase \d+/gm)
        const relFolder = path.relative(VAULT_PATH, dir)
        const archived = relFolder.includes('archive')

        return {
          plan: {
            planId: fm.planId || data.planId,
            title: fm.title || data.planId,
            project: fm.project || 'default',
            status: fm.status || 'delegated',
            planningMode: fm.planningMode || 'sketch',
            ambiguityScore: fm.ambiguityScore ?? 0,
            phaseCount: phaseMatches?.length ?? 0,
            assetCount: assets.length,
            createdAt: fm.createdAt || '',
            updatedAt: fm.updatedAt || '',
            completedAt: fm.completedAt,
            outcome: fm.outcome,
            folder: relFolder,
            archived,
            content: content.trim(),
            frontmatter: fm,
            assets,
          } as PlanDetail,
        }
      } catch {
        continue
      }
    }

    return { plan: null }
  })
