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
import { VaultSync } from '@repo/vault-sync'
import { SearchClient, TraceDB } from '@repo/vault-client'
import { UnifiedAdapterBot, type UnifiedAdapterBotConfig, buildPlatformConfig } from "@repo/relay-adapter-core"
import { WebBridge } from "./webBridge.js"
import webpush from 'web-push'
import * as fs from 'node:fs'
import * as path from 'node:path'

const VAULT_PATH = process.env.VAULT_PATH ?? path.resolve(import.meta.dir, '../../.vault')
const WS_PORT = parseInt(process.env.WS_PORT ?? '4748')
const SUBS_FILE = path.join(VAULT_PATH, '_system/push-subscriptions.json')

// ─── Vault singletons ─────────────────────────────────────────────────────────

const searchClient = new SearchClient(VAULT_PATH)
const traceDb = new TraceDB(VAULT_PATH)

// ─── VAPID / Web Push ─────────────────────────────────────────────────────────

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY ?? ''
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY ?? ''
const VAPID_SUBJECT = process.env.VAPID_SUBJECT ?? 'mailto:your-email@example.com'

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


// ─── Thread helpers (thin wrappers over VaultThreadStore for PWA WS protocol) ─

function listThreads() {
  const threadsDir = path.join(VAULT_PATH, '_threads')
  if (!fs.existsSync(threadsDir)) return []
  return fs.readdirSync(threadsDir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const t = JSON.parse(fs.readFileSync(path.join(threadsDir, f), 'utf-8'))
        return {
          threadId: t.id,
          title: t.title || t.id,
          harness: t.activeHarness,
          updatedAt: new Date(t.updatedAt).toISOString(),
          messageCount: t.messages?.length ?? 0
        }
      } catch { return null }
    })
    .filter(Boolean)
    .sort((a: any, b: any) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
}

const SAFE_THREAD_ID = /^[a-zA-Z0-9_-]{1,120}$/

function loadThread(id: string) {
  if (!SAFE_THREAD_ID.test(id)) return null
  const p = path.join(VAULT_PATH, '_threads', `${id}.json`)
  if (!fs.existsSync(p)) return null
  try {
    const t = JSON.parse(fs.readFileSync(p, 'utf-8'))
    return {
      threadId: t.id,
      title: t.title,
      harness: t.activeHarness,
      messages: t.messages.map((m: any) => ({
        role: m.role,
        content: m.content,
        timestamp: new Date(m.timestamp).toISOString(),
        harness: m.harness
      })),
      createdAt: new Date(t.createdAt).toISOString(),
      updatedAt: new Date(t.updatedAt).toISOString(),
      totalInputTokens: t.totalInputTokens,
      totalOutputTokens: t.totalOutputTokens,
      totalCost: t.totalCost
    }
  } catch { return null }
}

function saveThread(thread: any) {
  const threadsDir = path.join(VAULT_PATH, '_threads')
  fs.mkdirSync(threadsDir, { recursive: true })
  fs.writeFileSync(path.join(threadsDir, `${thread.threadId}.json`), JSON.stringify({
    id: thread.threadId,
    title: thread.title,
    activeHarness: thread.harness,
    messages: thread.messages.map((m: any) => ({
        ...m,
        timestamp: new Date(m.timestamp).getTime()
    })),
    createdAt: new Date(thread.createdAt).getTime(),
    updatedAt: new Date(thread.updatedAt).getTime(),
    totalInputTokens: thread.totalInputTokens,
    totalOutputTokens: thread.totalOutputTokens,
    totalCost: thread.totalCost
  }, null, 2))
}

// ─── VaultSync + WebSocket server ────────────────────────────────────────────

const clients = new Set<ServerWebSocket<unknown>>()

const vaultSync = new VaultSync({ vaultPath: VAULT_PATH, deviceId: 'hq-pwa-ws', debug: false })

// Retry VaultSync start — sync.db may be briefly locked by agent/daemon on startup
async function startVaultSyncWithRetry(retries = 5, delayMs = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      await vaultSync.start()
      return
    } catch (err: any) {
      if (i < retries - 1 && (err?.code === 'SQLITE_BUSY' || err?.code === 'SQLITE_BUSY_RECOVERY')) {
        console.warn(`[hq-ws] VaultSync SQLITE_BUSY, retrying in ${delayMs}ms... (${i + 1}/${retries})`)
        await new Promise(r => setTimeout(r, delayMs))
      } else {
        console.error('[hq-ws] VaultSync failed to start, continuing without sync:', err?.message ?? err)
        return // Non-fatal — WS server still works without VaultSync
      }
    }
  }
}
startVaultSyncWithRetry().catch(console.error)

// ─── Unified Bot Setup ───────────────────────────────────────────────

const webBridge = new WebBridge(clients);

// ─── Message persistence via WebBridge onDone hook ───────────────────────────
// Track the user message for each active chat so we can persist user+assistant
// messages to the thread file BEFORE broadcasting chat:done.
// This ensures loadThread() succeeds when the client sends chat:load immediately after.

const pendingUserMessages = new Map<string, string>()
const pendingHarness = new Map<string, string>()

webBridge.onDone((chatId: string, responseText: string) => {
  const userMsg = pendingUserMessages.get(chatId)
  pendingUserMessages.delete(chatId)
  const userHarness = pendingHarness.get(chatId)
  pendingHarness.delete(chatId)
  if (!responseText) return

  let thread = loadThread(chatId)
  if (!thread) {
    thread = {
      threadId: chatId,
      title: `Chat ${new Date().toLocaleDateString()}`,
      harness: userHarness || 'auto',
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCost: 0,
    }
  }
  if (userHarness) thread.harness = userHarness // update thread with user's latest harness pick
  if (userMsg) {
    thread.messages.push({ role: 'user', content: userMsg, timestamp: new Date().toISOString() })
  }
  thread.messages.push({ role: 'assistant', content: responseText, timestamp: new Date().toISOString() })
  thread.updatedAt = new Date().toISOString()
  try { saveThread(thread) } catch (e) { console.error('[hq-ws] Failed to save thread:', e) }
})

const botConfig: UnifiedAdapterBotConfig = {
  bridge: webBridge,
  platformConfig: buildPlatformConfig("web", {
    defaultTimeout: 120_000,
    harnessTimeouts: { relay: 120_000 },
  }),
  relay: {
    apiKey: process.env.AGENTHQ_API_KEY || "local-master-key",
    debug: true,
  },
  vaultRoot: VAULT_PATH,
  stateFile: path.join(VAULT_PATH, "_system/.pwa-bot-state.json"),
};

const unifiedBot = new UnifiedAdapterBot(botConfig);
unifiedBot.start().catch(console.error);

vaultSync.eventBus.on('*', (event: any) => {
  if (clients.size === 0) return
  broadcast({ type: 'event', event })

  // Derive workflow-level events from delegation task events
  const evtType: string = event?.type ?? ''
  const evtPath: string = event?.path ?? ''
  if (evtType.startsWith('task:') && evtPath) {
    const ts = Date.now()
    if (evtType === 'task:claimed' && evtPath.includes('_delegation/claimed')) {
      broadcast({ type: 'workflow:stage-started', taskPath: evtPath, timestamp: ts })
    } else if (evtType === 'task:completed' && evtPath.includes('_delegation/completed')) {
      broadcast({ type: 'workflow:stage-completed', taskPath: evtPath, timestamp: ts })
    } else if (evtType === 'task:failed' && evtPath.includes('_delegation/failed')) {
      broadcast({ type: 'workflow:gate-evaluated', outcome: 'BLOCKED', taskPath: evtPath, timestamp: ts })
    }
  }
})

// ─── Metrics directory watcher ────────────────────────────────────────────────
// Watch _metrics/ for performance data changes and optimization recommendations.

const METRICS_DIR = path.join(VAULT_PATH, '_metrics')
const PENDING_OPT_SUBDIR = path.join('pending-optimizations')

let metricsDebounceTimer: ReturnType<typeof setTimeout> | null = null
let optimizationDebounceTimer: ReturnType<typeof setTimeout> | null = null

function startMetricsWatcher() {
  if (!fs.existsSync(METRICS_DIR)) {
    // Create the directory and retry once it exists
    fs.mkdirSync(METRICS_DIR, { recursive: true })
  }
  try {
    fs.watch(METRICS_DIR, { recursive: true }, (_eventType, filename) => {
      if (!filename || clients.size === 0) return
      const normalised = filename.replace(/\\/g, '/')
      if (normalised.includes('pending-optimizations')) {
        if (optimizationDebounceTimer) clearTimeout(optimizationDebounceTimer)
        optimizationDebounceTimer = setTimeout(() => {
          broadcast({ type: 'optimization:available', filename, timestamp: Date.now() })
          optimizationDebounceTimer = null
        }, 500)
      } else {
        if (metricsDebounceTimer) clearTimeout(metricsDebounceTimer)
        metricsDebounceTimer = setTimeout(() => {
          broadcast({ type: 'metric:updated', filename, timestamp: Date.now() })
          metricsDebounceTimer = null
        }, 500)
      }
    })
    console.log(`[hq-ws] Watching metrics dir: ${METRICS_DIR}`)
  } catch (e) {
    console.warn(`[hq-ws] Could not watch metrics dir: ${e}`)
  }
}

startMetricsWatcher()

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
  hostname: process.env.WS_BIND_HOST ?? '127.0.0.1',

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
    // ─── File Upload ──────────────────────────────────────────────────
    if (url.pathname === '/upload' && req.method === 'POST') {
      try {
        const formData = await req.formData()
        const file = formData.get('file') as File | null
        if (!file) return new Response(JSON.stringify({ error: 'No file provided' }), { status: 400, headers: corsHeaders })

        const uploadsDir = path.join(VAULT_PATH, '_uploads')
        fs.mkdirSync(uploadsDir, { recursive: true })

        const ext = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')) : ''
        const safeName = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`
        const filePath = path.join(uploadsDir, safeName)

        const buf = await file.arrayBuffer()
        fs.writeFileSync(filePath, Buffer.from(buf))

        const vaultRelPath = `_uploads/${safeName}`
        console.log(`[hq-ws] File uploaded: ${vaultRelPath} (${file.size} bytes)`)
        return new Response(JSON.stringify({ ok: true, path: vaultRelPath, name: file.name, size: file.size }), { headers: corsHeaders })
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders })
      }
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
          ws.send(JSON.stringify({
            type: 'chat:history',
            threadId: msg.threadId,
            thread,
            sessionTotals: thread ? {
              inputTokens: thread.totalInputTokens ?? 0,
              outputTokens: thread.totalOutputTokens ?? 0,
              cost: thread.totalCost ?? 0,
            } : undefined,
          }))
        } else if (msg.type === 'chat:delete') {
          try {
            if (!msg.threadId || !SAFE_THREAD_ID.test(msg.threadId)) return
            const p = path.join(VAULT_PATH, '_threads', `${msg.threadId}.json`)
            if (fs.existsSync(p)) fs.unlinkSync(p)
            ws.send(JSON.stringify({ type: 'chat:threads', threads: listThreads() }))
          } catch { /* ignore */ }
        } else if (msg.type === 'chat:reset') {
          // No-op for now in unified mode, or we could clear the session in unifiedBot
          ws.send(JSON.stringify({ type: 'chat:reset_ok', threadId: msg.threadId }))
        } else if (msg.type === 'chat:rename') {
          const thread = loadThread(msg.threadId)
          if (thread && msg.title) {
            thread.title = String(msg.title).slice(0, 100)
            thread.updatedAt = new Date().toISOString()
            saveThread(thread)
            broadcast({ type: 'chat:threads', threads: listThreads() })
          }
        } else if (msg.type === 'chat:retry') {
          const thread = loadThread(msg.threadId)
          if (thread && typeof msg.fromIndex === 'number') {
            const truncatedMessages = thread.messages.slice(0, msg.fromIndex + 1)
            const lastUserMsg = truncatedMessages[truncatedMessages.length - 1]
            if (lastUserMsg && lastUserMsg.role === 'user') {
              // We don't save the thread here, webBridge.handleIncoming will handle it
              webBridge.handleIncoming(msg.threadId, lastUserMsg.content).catch(e =>
                ws.send(JSON.stringify({ type: 'chat:error', threadId: msg.threadId, error: e.message }))
              )
            }
          }
        } else if (msg.type === 'chat:search') {
          // Vault search inline
          try {
            const results = searchClient.hybridSearch(msg.query, null, 5)
            const content = results.length > 0 
                ? `Results for "${msg.query}":\n\n` + results.map((r: any) => `- [[${r.path}]]: ${r.content.slice(0, 150)}...`).join('\n')
                : `No results found for "${msg.query}".`
            ws.send(JSON.stringify({
              type: 'chat:history',
              threadId: msg.threadId,
              thread: {
                ...loadThread(msg.threadId),
                messages: [{ role: 'system', content: `[${content}]`, timestamp: new Date().toISOString() }]
              } as any,
              isAppend: true
            }))
          } catch (e: any) {
            ws.send(JSON.stringify({ type: 'chat:error', threadId: msg.threadId, error: e.message }))
          }
        } else if (msg.type === 'chat:send' || msg.type === 'chat:send-with-context') {
          if (!msg.threadId || !SAFE_THREAD_ID.test(msg.threadId)) return
          // Track user message for persistence in the onDone handler
          if (msg.threadId && msg.content) pendingUserMessages.set(msg.threadId, msg.content)
          // Track user's harness selection for thread persistence
          if (msg.threadId && msg.harness) pendingHarness.set(msg.threadId, msg.harness)
          // Pass harness from PWA so the bot routes to the right CLI harness
          const harnessOverride = msg.harness && msg.harness !== 'auto' ? msg.harness : undefined
          webBridge.handleIncoming(msg.threadId, msg.content, 'web-user', harnessOverride).catch(e =>
            ws.send(JSON.stringify({ type: 'chat:error', threadId: msg.threadId, error: e.message }))
          );
        }
      } catch { /* ignore */ }
    },
    close(ws) {
      clients.delete(ws)
    },
  },
})

console.log(`[hq-ws] WebSocket server on ws://${process.env.WS_BIND_HOST ?? '127.0.0.1'}:${server.port}/ws`)
console.log(`[hq-ws] Vault: ${VAULT_PATH}`)
console.log(`[hq-ws] Web Push ${VAPID_PUBLIC_KEY ? 'enabled' : 'disabled'}`)

process.on('SIGINT', () => {
  clearInterval(pingInterval)
  vaultSync.stop().finally(() => process.exit(0))
})
