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
    const jobsDir = path.join(VAULT_PATH, '_fbmq/jobs')

    const readFlatDir = (sub: string, statusText: Job['status']) => {
      const d = path.join(jobsDir, sub)
      if (!fs.existsSync(d)) return
      const files = fs.readdirSync(d).filter((f) => f.endsWith('.md'))
      for (const f of files) {
        try {
          const raw = fs.readFileSync(path.join(d, f), 'utf-8')
          const { data } = matter(raw)
          jobs.push({
            jobId: f.replace('.md', ''),
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

    readFlatDir('processing', 'running')
    readFlatDir('done', 'done')
    readFlatDir('failed', 'failed')

    // Also check standard _jobs paths
    const stdJobsDir = path.join(VAULT_PATH, '_jobs')
    if (fs.existsSync(stdJobsDir)) {
      for (const [sub, statusText] of [
        ['running', 'running'] as const,
        ['done', 'done'] as const,
        ['failed', 'failed'] as const,
      ]) {
        const d = path.join(stdJobsDir, sub)
        if (!fs.existsSync(d)) continue
        const files = fs.readdirSync(d).filter((f) => f.endsWith('.md'))
        for (const f of files) {
          try {
            const raw = fs.readFileSync(path.join(d, f), 'utf-8')
            const { data } = matter(raw)
            jobs.push({
              jobId: f.replace('.md', ''),
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
    }

    // Pending is sharded (00-ff) in _fbmq/jobs/pending
    const pendingRoot = path.join(jobsDir, 'pending')
    if (fs.existsSync(pendingRoot)) {
      for (const bucket of fs.readdirSync(pendingRoot)) {
        const bucketPath = path.join(pendingRoot, bucket)
        if (fs.statSync(bucketPath).isDirectory()) {
          for (const f of fs.readdirSync(bucketPath).filter((f) => f.endsWith('.md'))) {
            try {
              const raw = fs.readFileSync(path.join(bucketPath, f), 'utf-8')
              const { data } = matter(raw)
              jobs.push({
                jobId: f.replace('.md', ''),
                status: 'pending',
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
      }
    }

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
    // format like job-1700000000000-xyz
    const randomSuffix = Math.random().toString(36).substring(2, 8)
    const jobId = `job-${timestamp}-${randomSuffix}`

    // sharding logic: normally jobs go to pending/00 .. pending/ff based on hash
    // simplified: just dump it into pending/00 or create one based on first hex char
    const bucket = require('crypto').createHash('md5').update(jobId).digest('hex').substring(0, 2)
    const pendingDir = path.join(VAULT_PATH, `_fbmq/jobs/pending/${bucket}`)

    if (!fs.existsSync(pendingDir)) {
      fs.mkdirSync(pendingDir, { recursive: true })
    }

    const nowIso = new Date().toISOString()
    const content = `---
type: ${data.type || 'custom'}
priority: ${data.priority || 50}
status: pending
createdAt: ${nowIso}
updatedAt: ${nowIso}
instruction: |
  ${data.instruction.split('\\n').join('\\n  ')}
---

# Output
`
    fs.writeFileSync(path.join(pendingDir, `${jobId}.md`), content, 'utf-8')
    return { success: true, jobId }
  })
