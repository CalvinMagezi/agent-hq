import { createServerFn } from '@tanstack/react-start'
import * as fs from 'node:fs'
import * as path from 'node:path'
import matter from 'gray-matter'
import { VAULT_PATH } from './vault'

export interface DaemonTask {
  task: string
  lastRun: string
  lastSuccess: string
  runs: string
  errors: string
  lastError: string
  status: 'ok' | 'error' | 'warn'
}

export interface DaemonResult {
  meta: Record<string, any>
  tasks: DaemonTask[]
}

export const getDaemon = createServerFn({ method: 'GET' }).handler(
  async (): Promise<DaemonResult> => {
    const filePath = path.join(VAULT_PATH, '_system/DAEMON-STATUS.md')
    if (!fs.existsSync(filePath)) {
      return { meta: {}, tasks: [] }
    }

    const { data, content } = matter(fs.readFileSync(filePath, 'utf-8'))
    const tasks: DaemonTask[] = []
    const lines = content.split('\n')
    let inTable = false

    for (const line of lines) {
      if (line.trim().startsWith('| Task |') || line.trim().startsWith('|Task|')) {
        inTable = true
        continue
      }
      if (inTable && line.trim().startsWith('|---')) continue
      if (inTable && line.trim().startsWith('|')) {
        const parts = line.split('|').map((s) => s.trim())
        if (parts.length >= 7) {
          const errors = parts[5]
          const lastError = parts[6]
          const lastRun = parts[2]
          const status: DaemonTask['status'] =
            lastError && lastError !== '-' && lastError !== ''
              ? 'error'
              : parseInt(errors) > 0
                ? 'warn'
                : 'ok'
          tasks.push({
            task: parts[1],
            lastRun,
            lastSuccess: parts[3],
            runs: parts[4],
            errors,
            lastError,
            status,
          })
        }
      }
    }

    return { meta: data as Record<string, unknown>, tasks }
  }
)
