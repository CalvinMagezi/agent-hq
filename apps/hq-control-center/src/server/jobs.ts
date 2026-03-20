import { createServerFn } from '@tanstack/react-start'
import * as fs from 'node:fs'
import * as path from 'node:path'
import matter from 'gray-matter'
import { VAULT_PATH } from './vault'

export interface Job {
  jobId: string
  status: 'running' | 'done' | 'failed' | 'pending'
  type: string
  priority: number
  createdAt: string
  updatedAt: string
  instruction: string
}

export const getJobs = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{ jobs: Job[] }> => {
    const jobs: Job[] = []
    const jobsDir = path.join(VAULT_PATH, '_jobs')

    const readFlatDir = (sub: string, statusText: Job['status']) => {
      const d = path.join(jobsDir, sub)
      if (!fs.existsSync(d)) return
      const files = fs.readdirSync(d).filter((f) => f.endsWith('.md'))
      for (const f of files) {
        try {
          const raw = fs.readFileSync(path.join(d, f), 'utf-8')
          const { data } = matter(raw)
          jobs.push({
            jobId: data?.jobId ?? f.replace('.md', ''),
            status: statusText,
            type: data?.type ?? 'unknown',
            priority: data?.priority ?? 50,
            createdAt: data?.createdAt ?? '',
            updatedAt: data?.updatedAt ?? '',
            instruction: data?.instruction ?? '',
          })
        } catch {
          // skip
        }
      }
    }

    readFlatDir('pending', 'pending')
    readFlatDir('running', 'running')
    readFlatDir('done', 'done')
    readFlatDir('failed', 'failed')

    jobs.sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1))
    return { jobs }
  }
)

export const getJobLogs = createServerFn({ method: 'GET' })
  .inputValidator((jobId: string) => jobId)
  .handler(async ({ data: jobId }): Promise<{ content: string }> => {
    const logsDir = path.join(VAULT_PATH, '_logs')
    if (!fs.existsSync(logsDir)) return { content: 'No logs directory found.' }

    const days = fs
      .readdirSync(logsDir)
      .filter((d) => fs.statSync(path.join(logsDir, d)).isDirectory())
      .sort()
      .reverse()

    for (const day of days) {
      const p = path.join(logsDir, day, `job-${jobId}.md`)
      if (fs.existsSync(p)) {
        return { content: fs.readFileSync(p, 'utf-8') }
      }
    }
    return { content: 'Log not found or not yet flushed.' }
  })

interface CreateJobParams {
  instruction: string
  type?: string
  priority?: number
}

export const createJob = createServerFn({ method: 'POST' })
  .inputValidator((d: CreateJobParams) => d)
  .handler(async ({ data }): Promise<{ success: boolean; jobId: string }> => {
    const timestamp = Date.now()
    const randomSuffix = Math.random().toString(36).substring(2, 8)
    const jobId = `job-${timestamp}-${randomSuffix}`

    const pendingDir = path.join(VAULT_PATH, '_jobs/pending')
    if (!fs.existsSync(pendingDir)) {
      fs.mkdirSync(pendingDir, { recursive: true })
    }

    const nowIso = new Date().toISOString()
    const content = `---
jobId: ${jobId}
type: ${data.type || 'background'}
priority: ${data.priority || 50}
status: pending
createdAt: ${nowIso}
updatedAt: ${nowIso}
---

# Instruction

${data.instruction}
`
    fs.writeFileSync(path.join(pendingDir, `${jobId}.md`), content, 'utf-8')
    return { success: true, jobId }
  })
