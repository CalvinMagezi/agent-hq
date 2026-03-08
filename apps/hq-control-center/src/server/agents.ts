import { createServerFn } from '@tanstack/react-start'
import * as fs from 'node:fs'
import * as path from 'node:path'
import matter from 'gray-matter'
import { VAULT_PATH } from './vault'

export interface RelayAgent {
  id: string
  name: string
  type: 'relay'
  status: 'active' | 'idle' | 'error'
  lastHeartbeat?: string
  model?: string
}

export interface WorkerAgent {
  id: string
  name: string
  type: 'worker'
  status: 'active' | 'idle' | 'error'
  lastHeartbeat?: string
  currentJobId?: string
}

export interface AgentsResult {
  relays: RelayAgent[]
  workers: WorkerAgent[]
}

export const getAgents = createServerFn({ method: 'GET' }).handler(
  async (): Promise<AgentsResult> => {
    const relays: RelayAgent[] = []
    const workers: WorkerAgent[] = []

    // Read relay health from _delegation/relay-health/
    try {
      const relayHealthDir = path.join(VAULT_PATH, '_delegation/relay-health')
      if (fs.existsSync(relayHealthDir)) {
        const files = fs.readdirSync(relayHealthDir).filter((f) => f.endsWith('.md'))
        for (const file of files) {
          try {
            const raw = fs.readFileSync(path.join(relayHealthDir, file), 'utf-8')
            const { data } = matter(raw)
            const minutesAgo = data.lastHeartbeat
              ? (Date.now() - new Date(data.lastHeartbeat).getTime()) / 60000
              : Infinity
            relays.push({
              id: data.relayId ?? file.replace('.md', ''),
              name: data.name ?? file.replace('.md', ''),
              type: 'relay',
              status:
                data.status === 'healthy' && minutesAgo < 5
                  ? 'active'
                  : data.status === 'error'
                    ? 'error'
                    : 'idle',
              lastHeartbeat: data.lastHeartbeat,
              model: data.model,
            })
          } catch {
            // skip bad file
          }
        }
      }
    } catch {
      // no relay health dir
    }

    // If no relay health files, provide placeholder relays
    if (relays.length === 0) {
      const defaultRelays = [
        { id: 'relay-discord', name: 'Discord', model: 'discord' },
        { id: 'relay-telegram', name: 'Telegram', model: 'telegram' },
        { id: 'relay-whatsapp', name: 'WhatsApp', model: 'whatsapp' },
        { id: 'relay-claude', name: 'Claude Code', model: 'claude' },
        { id: 'relay-gemini', name: 'Gemini', model: 'gemini' },
        { id: 'relay-opencode', name: 'OpenCode', model: 'opencode' },
      ]
      for (const r of defaultRelays) {
        relays.push({ ...r, type: 'relay', status: 'idle' })
      }
    }

    // Read worker sessions from _agent-sessions/
    try {
      const sessionsDir = path.join(VAULT_PATH, '_agent-sessions')
      if (fs.existsSync(sessionsDir)) {
        const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.md'))
        for (const file of files) {
          try {
            const raw = fs.readFileSync(path.join(sessionsDir, file), 'utf-8')
            const { data } = matter(raw)
            const minutesAgo = data.lastHeartbeat
              ? (Date.now() - new Date(data.lastHeartbeat).getTime()) / 60000
              : Infinity
            workers.push({
              id: data.workerId ?? file.replace('.md', ''),
              name: data.name ?? 'HQ Worker',
              type: 'worker',
              status:
                data.status === 'running' && minutesAgo < 2
                  ? 'active'
                  : data.status === 'error'
                    ? 'error'
                    : 'idle',
              lastHeartbeat: data.lastHeartbeat,
              currentJobId: data.currentJobId,
            })
          } catch {
            // skip
          }
        }
      }
    } catch {
      // no sessions dir
    }

    // If no workers found, show placeholder
    if (workers.length === 0) {
      workers.push({
        id: 'hq-worker',
        name: 'HQ Worker',
        type: 'worker',
        status: 'idle',
      })
    }

    return { relays, workers }
  }
)
