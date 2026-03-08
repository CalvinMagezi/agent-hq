/**
 * Standalone Bun WebSocket server on port 4748.
 * Bridges VaultSync events → connected PWA clients.
 * Also handles Web Push subscription storage and delivery.
 *
 * Chat uses real CLI harnesses — claude / gemini / opencode — identical to the
 * Telegram relay. No OpenRouter. Harness is selected per-message from the PWA.
 *
 * Claude:    streams via --output-format stream-json, session resumed per thread
 * Gemini:    stateless, full conversation history injected into prompt
 * OpenCode:  stateless, full conversation history injected into prompt
 */

import type { ServerWebSocket } from 'bun'
import { spawn } from 'bun'
import { VaultSync } from '@repo/vault-sync'
import { VaultClient, SearchClient, TraceDB } from '@repo/vault-client'
import webpush from 'web-push'
import * as fs from 'node:fs'
import * as path from 'node:path'

const VAULT_PATH = process.env.VAULT_PATH ?? '/Users/calvinmagezi/Documents/GitHub/agent-hq/.vault'
const WS_PORT = parseInt(process.env.WS_PORT ?? '4748')
const SUBS_FILE = path.join(VAULT_PATH, '_system/push-subscriptions.json')

// ─── Vault singletons ─────────────────────────────────────────────────────────

const vaultClient = new VaultClient(VAULT_PATH)
const searchClient = new SearchClient(VAULT_PATH)
const traceDb = new TraceDB(VAULT_PATH)

// ─── VAPID / Web Push ─────────────────────────────────────────────────────────

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY ?? ''
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY ?? ''
const VAPID_SUBJECT = process.env.VAPID_SUBJECT ?? 'mailto:calvin@kolaborate.io'

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)
}

function loadSubs(): webpush.PushSubscription[] {
  try {
    if (fs.existsSync(SUBS_FILE)) return JSON.parse(fs.readFileSync(SUBS_FILE, 'utf-8'))
  } catch { /* ignore */ }
  return []
}
function saveSubs(subs: webpush.PushSubscription[]) {
  fs.mkdirSync(path.dirname(SUBS_FILE), { recursive: true })
  fs.writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2))
}
export async function sendWebPush(title: string, body: string, url = '/', tag = 'hq') {
  if (!VAPID_PUBLIC_KEY) return
  const subs = loadSubs()
  const dead: string[] = []
  await Promise.allSettled(subs.map(async (sub) => {
    try { await webpush.sendNotification(sub, JSON.stringify({ title, body, url, tag })) }
    catch (err: any) { if (err.statusCode === 404 || err.statusCode === 410) dead.push(sub.endpoint) }
  }))
  if (dead.length) saveSubs(subs.filter(s => !dead.includes(s.endpoint)))
}

// ─── Thread storage ───────────────────────────────────────────────────────────

const THREADS_DIR = path.join(VAULT_PATH, '_threads/web')

interface ThreadMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  harness?: string
  timestamp: string
}
interface Thread {
  threadId: string
  title: string
  harness: string
  messages: ThreadMessage[]
  createdAt: string
  updatedAt: string
}

function loadThread(threadId: string): Thread | null {
  try {
    const p = path.join(THREADS_DIR, `${threadId}.json`)
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : null
  } catch { return null }
}
function saveThread(thread: Thread) {
  fs.mkdirSync(THREADS_DIR, { recursive: true })
  fs.writeFileSync(path.join(THREADS_DIR, `${thread.threadId}.json`), JSON.stringify(thread, null, 2))
}
function listThreads() {
  try {
    if (!fs.existsSync(THREADS_DIR)) return []
    return fs.readdirSync(THREADS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(THREADS_DIR, f), 'utf-8')) as Thread } catch { return null } })
      .filter(Boolean)
      .sort((a: any, b: any) => b.updatedAt.localeCompare(a.updatedAt))
      .map((t: any) => ({ threadId: t.threadId, title: t.title, harness: t.harness, updatedAt: t.updatedAt, messageCount: t.messages.length }))
  } catch { return [] }
}

// ─── Vault context cache ──────────────────────────────────────────────────────

interface VaultCtx { soul: string; memory: string; preferences: string; builtAt: number }
let ctxCache: VaultCtx | null = null
const CTX_TTL = 3 * 60 * 1000

function readSystemFile(name: string): string {
  try {
    const p = path.join(VAULT_PATH, `_system/${name}.md`)
    if (!fs.existsSync(p)) return ''
    return fs.readFileSync(p, 'utf-8').replace(/^---[\s\S]*?---\n?/, '').trim()
  } catch { return '' }
}

async function getVaultCtx(): Promise<VaultCtx> {
  if (ctxCache && Date.now() - ctxCache.builtAt < CTX_TTL) return ctxCache
  try {
    const agentCtx = await vaultClient.getAgentContext()
    ctxCache = {
      soul: agentCtx.soul ?? readSystemFile('SOUL'),
      memory: agentCtx.memory ?? readSystemFile('MEMORY'),
      preferences: agentCtx.preferences ?? readSystemFile('PREFERENCES'),
      builtAt: Date.now(),
    }
  } catch {
    ctxCache = {
      soul: readSystemFile('SOUL'),
      memory: readSystemFile('MEMORY'),
      preferences: readSystemFile('PREFERENCES'),
      builtAt: Date.now(),
    }
  }
  return ctxCache!
}

function buildSystemContext(ctx: VaultCtx): string {
  const date = new Date().toLocaleString('en-US', { timeZone: 'Africa/Kampala', dateStyle: 'full', timeStyle: 'short' })
  const parts = [`Current date/time (Kampala EAT): ${date}`]
  if (ctx.soul) parts.push(`## Identity\n${ctx.soul}`)
  if (ctx.memory) parts.push(`## Persistent Memory\n${ctx.memory}`)
  if (ctx.preferences) parts.push(`## User Preferences\n${ctx.preferences}`)
  parts.push(`## Vault\nThe vault (.vault/) is the shared brain for all agents. Key locations:\n- _system/: SOUL.md, MEMORY.md, PREFERENCES.md\n- _jobs/: job queue\n- Notebooks/Projects/: Kolaborate, SiteSeer, Chamuka, YMF\n- _threads/: conversation history`)
  return parts.join('\n\n')
}

/** Format thread history as a readable transcript for stateless harnesses */
function buildHistoryTranscript(messages: ThreadMessage[]): string {
  return messages
    .filter(m => m.role !== 'system')
    .map(m => {
      const label = m.role === 'user' ? 'User' : (m.harness ?? 'Assistant')
      return `${label}: ${m.content}`
    })
    .join('\n\n')
}

// ─── Claude session store (per thread) ───────────────────────────────────────

interface ClaudeSession { sessionId: string; lastActivity: string }
const CLAUDE_SESSIONS_FILE = path.join(VAULT_PATH, '_threads/web-claude-sessions.json')
const SESSION_TTL_MS = 4 * 60 * 60 * 1000

function loadClaudeSessions(): Record<string, ClaudeSession> {
  try {
    if (fs.existsSync(CLAUDE_SESSIONS_FILE)) return JSON.parse(fs.readFileSync(CLAUDE_SESSIONS_FILE, 'utf-8'))
  } catch { /* ignore */ }
  return {}
}
function saveClaudeSessions(sessions: Record<string, ClaudeSession>) {
  fs.mkdirSync(path.dirname(CLAUDE_SESSIONS_FILE), { recursive: true })
  fs.writeFileSync(CLAUDE_SESSIONS_FILE, JSON.stringify(sessions, null, 2))
}

// ─── Harness runners ──────────────────────────────────────────────────────────

export type HarnessType = 'claude-code' | 'gemini-cli' | 'opencode' | 'hq-agent' | 'codex-cli'

const HARNESS_TIMEOUT_MS = 60 * 60 * 1000 // 1 hour

/**
 * Run Claude Code CLI with streaming.
 * Sends chat:token events to the WebSocket client as Claude generates output.
 * Returns the full response text.
 */
async function runClaude(
  ws: ServerWebSocket<unknown>,
  threadId: string,
  prompt: string,
  systemContext: string,
): Promise<string> {
  const sessions = loadClaudeSessions()
  const session = sessions[threadId]
  const age = session ? Date.now() - new Date(session.lastActivity).getTime() : Infinity
  const resumeId = session && age < SESSION_TTL_MS ? session.sessionId : null

  const cmd: string[] = [
    process.env.CLAUDE_PATH ?? 'claude',
    '--dangerously-skip-permissions',
    '--verbose',
    '--output-format', 'stream-json',
    '--max-turns', '100',
    '--model', 'sonnet',
    '--system-prompt', systemContext,
  ]
  if (resumeId) cmd.push('--resume', resumeId)
  cmd.push('-p', prompt)

  const env = { ...process.env }
  // Ensure HOME is set (required for claude/gemini config discovery)
  if (!env.HOME) env.HOME = '/Users/calvinmagezi'

  console.log(`[hq-ws] [claude] spawning: ${cmd.slice(0, 3).join(' ')} ... (thread: ${threadId}, resume: ${resumeId ?? 'none'})`)
  const proc = spawn({ cmd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env })

  let fullText = ''
  let newSessionId: string | null = null

  const timer = setTimeout(() => { console.log('[hq-ws] [claude] timeout, killing'); proc.kill() }, HARNESS_TIMEOUT_MS)

  try {
    // Drain stderr concurrently so it doesn't block stdout pipe
    const stderrChunks: string[] = []
    const stderrDone = new Response(proc.stderr).text().then(s => { if (s.trim()) stderrChunks.push(s.trim()) })

    // Stream stdout line-by-line — parse stream-json format
    const reader = proc.stdout.getReader()
    const decoder = new TextDecoder()
    let buf = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })

      // Process complete lines
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const evt = JSON.parse(trimmed) as Record<string, any>

          // Session ID appears on most events
          if (typeof evt.session_id === 'string') newSessionId = evt.session_id

          // Text content from assistant messages
          if (evt.type === 'assistant') {
            const content = evt.message?.content
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'text' && block.text) {
                  fullText += block.text
                  try { ws.send(JSON.stringify({ type: 'chat:token', threadId, token: block.text })) } catch { /* ws closed */ }
                }
              }
            }
          }

          // Final result — may contain the full response if streaming missed parts
          if (evt.type === 'result') {
            console.log(`[hq-ws] [claude] result event: subtype=${evt.subtype} has_result=${!!evt.result}`)
            if (typeof evt.result === 'string' && evt.result && !fullText) {
              fullText = evt.result
              try { ws.send(JSON.stringify({ type: 'chat:token', threadId, token: fullText })) } catch { /* ws closed */ }
            }
          }

          if (evt.type === 'error') {
            console.error(`[hq-ws] [claude] error event:`, JSON.stringify(evt).slice(0, 200))
          }
        } catch { /* non-JSON line — log for debugging */ }
      }
    }

    const exitCode = await proc.exited
    await stderrDone
    console.log(`[hq-ws] [claude] exit code: ${exitCode}, text length: ${fullText.length}`)
    if (stderrChunks.length) console.error(`[hq-ws] [claude] stderr: ${stderrChunks.join('\n').slice(0, 500)}`)
  } finally {
    clearTimeout(timer)
  }

  // Persist session
  if (newSessionId) {
    sessions[threadId] = { sessionId: newSessionId, lastActivity: new Date().toISOString() }
    saveClaudeSessions(sessions)
  }

  return fullText.trim()
}

/**
 * Run a stateless harness (Gemini CLI or OpenCode).
 * Waits for full output then streams it back in chunks.
 */
async function runStateless(
  ws: ServerWebSocket<unknown>,
  threadId: string,
  harness: 'gemini-cli' | 'opencode' | 'codex-cli',
  prompt: string,
): Promise<string> {
  let cmd: string[]
  if (harness === 'gemini-cli') {
    cmd = [process.env.GEMINI_PATH ?? 'gemini', '--yolo', '-p', prompt]
  } else if (harness === 'opencode') {
    cmd = [process.env.OPENCODE_PATH ?? 'opencode', 'run', '-m', 'openrouter/moonshotai/kimi-k2', prompt]
  } else {
    // codex-cli
    cmd = [process.env.CODEX_PATH ?? 'codex', '-p', prompt]
  }

  const env = { ...process.env }
  if (!env.HOME) env.HOME = '/Users/calvinmagezi'

  console.log(`[hq-ws] [${harness}] spawning: ${cmd[0]} ${cmd[1] ?? ''} (thread: ${threadId})`)
  const proc = spawn({ cmd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env })
  const timer = setTimeout(() => { console.log(`[hq-ws] [${harness}] timeout, killing`); proc.kill() }, HARNESS_TIMEOUT_MS)

  let stdout = ''
  let stderr = ''
  try {
    ;[stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const exitCode = await proc.exited
    console.log(`[hq-ws] [${harness}] exit: ${exitCode}, stdout: ${stdout.length} chars, stderr: ${stderr.length} chars`)
    if (stderr.trim()) console.error(`[hq-ws] [${harness}] stderr: ${stderr.trim().slice(0, 300)}`)
  } finally {
    clearTimeout(timer)
  }

  const result = stdout.trim() || stderr.trim() || `No response from ${harness}.`

  // Stream the result back in word-sized chunks so the UI feels live
  const words = result.split(/(\s+)/)
  for (const word of words) {
    if (!word) continue
    try { ws.send(JSON.stringify({ type: 'chat:token', threadId, token: word })) } catch { break }
    // Small delay between chunks for a natural streaming feel
    await Bun.sleep(8)
  }

  return result
}

/**
 * For hq-agent: create a job in the vault and wait for result.
 * Streams progress updates while waiting.
 */
async function runHQAgent(
  ws: ServerWebSocket<unknown>,
  threadId: string,
  prompt: string,
): Promise<string> {
  try {
    // Use rpc type so the agent submits an explicit result via submit_result tool
    const jobId = await vaultClient.createJob({
      type: 'rpc',
      instruction: prompt,
      priority: 60,
      securityProfile: 'standard',
      threadId,
    })

    console.log(`[hq-ws] [hq-agent] created rpc job: ${jobId}`)
    ws.send(JSON.stringify({ type: 'chat:status', threadId, status: `HQ Agent job queued: ${jobId}` }))

    const POLL_MS = 3000
    const MAX_WAIT_MS = 10 * 60 * 1000
    const start = Date.now()
    let lastProgressAt = 0

    while (Date.now() - start < MAX_WAIT_MS) {
      await Bun.sleep(POLL_MS)

      const elapsed = Math.round((Date.now() - start) / 1000)

      // Poll for completed job via getJob()
      try {
        const job = await vaultClient.getJob(jobId)
        if (job && (job.status === 'done' || job.status === 'failed')) {
          const result = job.result ?? job.streamingText ?? (job.status === 'failed' ? 'HQ Agent job failed.' : '')
          if (result) {
            console.log(`[hq-ws] [hq-agent] job ${job.status}, response length: ${result.length}`)
            const words = result.split(/(\s+)/)
            for (const word of words) {
              if (!word) continue
              try { ws.send(JSON.stringify({ type: 'chat:token', threadId, token: word })) } catch { break }
              await Bun.sleep(8)
            }
            return result
          }
        }
      } catch { /* getJob may throw if files are locked, retry next cycle */ }

      if (elapsed - lastProgressAt >= 10) {
        lastProgressAt = elapsed
        ws.send(JSON.stringify({ type: 'chat:status', threadId, status: `HQ Agent working… (${elapsed}s)` }))
      }
    }

    return 'HQ Agent timed out waiting for job result.'
  } catch (e: any) {
    return `Failed to create HQ Agent job: ${e.message}`
  }
}

// ─── Main chat handler ────────────────────────────────────────────────────────

async function handleChatSend(ws: ServerWebSocket<unknown>, payload: {
  threadId: string; content: string; harness: string
}) {
  const { threadId, content, harness } = payload as { threadId: string; content: string; harness: HarnessType }
  const now = new Date().toISOString()

  // Load or create thread
  let thread = loadThread(threadId) ?? {
    threadId,
    title: content.slice(0, 60).trim(),
    harness,
    messages: [] as ThreadMessage[],
    createdAt: now,
    updatedAt: now,
  }

  // Record harness switch in thread history
  const prevHarness = thread.harness
  if (harness !== prevHarness && thread.messages.length > 0) {
    thread.messages.push({
      role: 'system',
      content: `[Switched to ${harness} from ${prevHarness}]`,
      timestamp: now,
    })
    thread.harness = harness
  }

  // Append user message
  thread.messages.push({ role: 'user', content, timestamp: now })
  thread.updatedAt = now
  saveThread(thread)

  // Build vault context (shared across all harnesses)
  const vaultCtx = await getVaultCtx()
  const systemContext = buildSystemContext(vaultCtx)

  let response = ''

  try {
    if (harness === 'claude-code') {
      // Claude: streaming, session-resumed per thread
      // For the first message or after a harness switch, Claude gets full context via --system-prompt.
      // Session resumption handles all subsequent history automatically.
      response = await runClaude(ws, threadId, content, systemContext)

    } else if (harness === 'gemini-cli' || harness === 'opencode' || harness === 'codex-cli') {
      // Stateless harnesses: inject full conversation history into the prompt
      const history = buildHistoryTranscript(
        thread.messages.filter(m => m.role !== 'system').slice(0, -1) // exclude current user msg
      )

      let fullPrompt = `${systemContext}\n\n`
      if (history) fullPrompt += `## Conversation History\n${history}\n\n`
      fullPrompt += `## Current Message\nUser: ${content}`

      response = await runStateless(ws, threadId, harness as 'gemini-cli' | 'opencode' | 'codex-cli', fullPrompt)

    } else if (harness === 'hq-agent') {
      // HQ Agent: submit job to vault queue
      const history = buildHistoryTranscript(thread.messages.filter(m => m.role !== 'system').slice(0, -1))
      const fullPrompt = history ? `${history}\n\nUser: ${content}` : content
      response = await runHQAgent(ws, threadId, fullPrompt)

    } else {
      response = `Unknown harness: ${harness}`
      ws.send(JSON.stringify({ type: 'chat:token', threadId, token: response }))
    }
  } catch (e: any) {
    const errMsg = `Error running ${harness}: ${e.message}`
    ws.send(JSON.stringify({ type: 'chat:error', threadId, error: errMsg }))
    response = errMsg
  }

  // Save assistant response
  if (response) {
    thread.messages.push({ role: 'assistant', content: response, harness, timestamp: new Date().toISOString() })
    thread.updatedAt = new Date().toISOString()
    saveThread(thread)
  }

  ws.send(JSON.stringify({ type: 'chat:done', threadId, harness }))
}

// ─── Kill active harness ──────────────────────────────────────────────────────

// Track active processes per thread so we can kill them
const activeProcs = new Map<string, { kill: () => void }>()

// ─── VaultSync + WebSocket server ────────────────────────────────────────────

const clients = new Set<ServerWebSocket<unknown>>()

const vaultSync = new VaultSync({ vaultPath: VAULT_PATH, deviceId: 'hq-pwa-ws', debug: false })
vaultSync.start().catch(console.error)

vaultSync.eventBus.on('*', (event: any) => {
  if (clients.size === 0) return
  broadcast({ type: 'event', event })
})

const pingInterval = setInterval(() => broadcast({ type: 'ping' }), 30_000)

function broadcast(msg: unknown) {
  const payload = JSON.stringify(msg)
  for (const client of clients) {
    try { client.send(payload) } catch { clients.delete(client) }
  }
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
}

const server = Bun.serve({
  port: WS_PORT,
  hostname: '0.0.0.0',

  async fetch(req, server) {
    const url = new URL(req.url)
    if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

    if (url.pathname === '/ws') {
      if (server.upgrade(req)) return undefined as any
      return new Response('WebSocket upgrade failed', { status: 400 })
    }
    if (url.pathname === '/push/vapid-public-key')
      return new Response(JSON.stringify({ key: VAPID_PUBLIC_KEY }), { headers: corsHeaders })

    if (url.pathname === '/push/subscribe' && req.method === 'POST') {
      try {
        const sub = await req.json() as webpush.PushSubscription
        const subs = loadSubs()
        if (!subs.find(s => s.endpoint === sub.endpoint)) { subs.push(sub); saveSubs(subs) }
        return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders })
      } catch (e: any) { return new Response(JSON.stringify({ error: e.message }), { status: 400, headers: corsHeaders }) }
    }
    if (url.pathname === '/push/subscribe' && req.method === 'DELETE') {
      try {
        const { endpoint } = await req.json() as { endpoint: string }
        saveSubs(loadSubs().filter(s => s.endpoint !== endpoint))
        return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders })
      } catch (e: any) { return new Response(JSON.stringify({ error: e.message }), { status: 400, headers: corsHeaders }) }
    }
    if (url.pathname === '/push/send' && req.method === 'POST') {
      try {
        const { title, body, url: pushUrl, tag } = await req.json() as any
        await sendWebPush(title, body, pushUrl, tag)
        return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders })
      } catch (e: any) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders }) }
    }
    if (url.pathname === '/search') {
      const q = url.searchParams.get('q') || ''
      try {
        const results = searchClient.hybridSearch(q, null, 20)
        return new Response(JSON.stringify({ results }), { headers: corsHeaders })
      } catch (e: any) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders }) }
    }
    if (url.pathname === '/traces') {
      try {
        const traces = traceDb.getActiveTraces()
        return new Response(JSON.stringify({ traces }), { headers: corsHeaders })
      } catch (e: any) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders }) }
    }
    if (url.pathname.startsWith('/traces/')) {
      const id = url.pathname.split('/').pop()
      if (id) {
        try {
          const trace = traceDb.getTraceTree(id)
          if (!trace) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: corsHeaders })
          return new Response(JSON.stringify({ trace }), { headers: corsHeaders })
        } catch (e: any) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders }) }
      }
    }
    return new Response('HQ WebSocket & REST Server', { status: 200, headers: { 'Content-Type': 'text/plain' } })
  },

  websocket: {
    open(ws) {
      clients.add(ws)
      ws.send(JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() }))
    },
    message(ws, data) {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'pong') {
          // keepalive
        } else if (msg.type === 'chat:list') {
          ws.send(JSON.stringify({ type: 'chat:threads', threads: listThreads() }))
        } else if (msg.type === 'chat:load') {
          const thread = loadThread(msg.threadId)
          ws.send(JSON.stringify({ type: 'chat:history', threadId: msg.threadId, thread }))
        } else if (msg.type === 'chat:delete') {
          try {
            const p = path.join(THREADS_DIR, `${msg.threadId}.json`)
            if (fs.existsSync(p)) fs.unlinkSync(p)
            // Also clear Claude session for this thread
            const sessions = loadClaudeSessions()
            if (sessions[msg.threadId]) {
              delete sessions[msg.threadId]
              saveClaudeSessions(sessions)
            }
            ws.send(JSON.stringify({ type: 'chat:threads', threads: listThreads() }))
          } catch { /* ignore */ }
        } else if (msg.type === 'chat:reset') {
          // Reset harness session for a thread
          const sessions = loadClaudeSessions()
          if (sessions[msg.threadId]) {
            delete sessions[msg.threadId]
            saveClaudeSessions(sessions)
          }
          ws.send(JSON.stringify({ type: 'chat:reset_ok', threadId: msg.threadId }))
        } else if (msg.type === 'chat:send') {
          handleChatSend(ws, msg).catch(e =>
            ws.send(JSON.stringify({ type: 'chat:error', threadId: msg.threadId, error: e.message }))
          )
        }
      } catch { /* ignore */ }
    },
    close(ws) {
      clients.delete(ws)
    },
  },
})

console.log(`[hq-ws] WebSocket server on ws://0.0.0.0:${server.port}/ws`)
console.log(`[hq-ws] Vault: ${VAULT_PATH}`)
console.log(`[hq-ws] Web Push ${VAPID_PUBLIC_KEY ? 'enabled' : 'disabled'}`)

process.on('SIGINT', () => {
  clearInterval(pingInterval)
  vaultSync.stop().finally(() => process.exit(0))
})
