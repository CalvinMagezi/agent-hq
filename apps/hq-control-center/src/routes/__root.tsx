import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRoute,
} from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { useHQStore } from '~/store/hqStore'
import { getJobs } from '~/server/jobs'
import { getDaemon } from '~/server/daemon'
import { getAgents } from '~/server/agents'
import { JobDrawer } from '~/components/JobDrawer'
import { SearchOverlay } from '~/components/SearchOverlay'
import { QuickNoteOverlay } from '~/components/QuickNoteOverlay'
import { NewJobOverlay } from '~/components/NewJobOverlay'
import appCss from '../../app.css?url'

const WS_BASE = typeof window !== 'undefined'
  ? `http://${window.location.hostname}:4748`
  : 'http://localhost:4748'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'HQ Control Center' },
      { name: 'theme-color', content: '#0a0a0f' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'manifest', href: '/manifest.json' },
    ],
  }),
  component: RootComponent,
})

async function registerPush(swReg: ServiceWorkerRegistration) {
  try {
    const res = await fetch(`${WS_BASE}/push/vapid-public-key`)
    const { key } = await res.json() as { key: string }
    if (!key) return

    const existing = await swReg.pushManager.getSubscription()
    if (existing) return // already subscribed

    const permission = await Notification.requestPermission()
    if (permission !== 'granted') return

    const sub = await swReg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key).buffer as ArrayBuffer,
    })

    await fetch(`${WS_BASE}/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sub),
    })
  } catch (e) {
    console.warn('[hq-push] registration failed', e)
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)))
}

function RootComponent() {
  return (
    <RootDocument>
      <Shell />
      <JobDrawer />
      <SearchOverlay />
      <QuickNoteOverlay />
      <NewJobOverlay />
    </RootDocument>
  )
}

function Shell() {
  const wsConnected = useHQStore((s) => s.wsConnected)
  const [pushPrompt, setPushPrompt] = useState(false)

  // Start WS connection
  useEffect(() => {
    const wsUrl = `ws://${window.location.hostname}:4748/ws`
    let ws: WebSocket | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null

    const connect = () => {
      ws = new WebSocket(wsUrl)
      ws.onopen = () => useHQStore.getState().setWsConnected(true)
      ws.onclose = () => {
        useHQStore.getState().setWsConnected(false)
        retryTimer = setTimeout(connect, 3000)
      }
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data)
          if (msg.type === 'ping') ws?.send(JSON.stringify({ type: 'pong' }))
          if (msg.type === 'event' && msg.event) {
            const event = msg.event
            useHQStore.getState().addEvent(event)

            if (['job:created', 'job:claimed', 'job:completed', 'job:failed'].includes(event.type)) {
              scheduleJobsRefresh()
            } else if (event.type === 'system:modified' && event.path?.includes('DAEMON-STATUS')) {
              scheduleDaemonRefresh()
            } else if (['task:created', 'task:claimed'].includes(event.type)) {
              scheduleRelaysRefresh()
            }
          }
        } catch { /* ignore */ }
      }
    }

    // Debounce timers — prevents parallel filesystem scans when events burst
    let jobsTimer: ReturnType<typeof setTimeout> | null = null
    let daemonTimer: ReturnType<typeof setTimeout> | null = null
    let relaysTimer: ReturnType<typeof setTimeout> | null = null

    const scheduleJobsRefresh = () => {
      if (jobsTimer) clearTimeout(jobsTimer)
      jobsTimer = setTimeout(() => {
        getJobs().then(res => useHQStore.getState().setJobs(res.jobs))
      }, 300)
    }
    const scheduleDaemonRefresh = () => {
      if (daemonTimer) clearTimeout(daemonTimer)
      daemonTimer = setTimeout(() => {
        getDaemon().then(res => useHQStore.getState().setDaemonTasks(res.tasks))
      }, 300)
    }
    const scheduleRelaysRefresh = () => {
      if (relaysTimer) clearTimeout(relaysTimer)
      relaysTimer = setTimeout(() => {
        getAgents().then(res => useHQStore.getState().setRelays(res.relays))
      }, 300)
    }

    connect()
    return () => {
      ws?.close()
      if (retryTimer) clearTimeout(retryTimer)
      if (jobsTimer) clearTimeout(jobsTimer)
      if (daemonTimer) clearTimeout(daemonTimer)
      if (relaysTimer) clearTimeout(relaysTimer)
    }
  }, [])

  // Register service worker + push (only in browser with SW support)
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return

    navigator.serviceWorker.ready.then(async (reg) => {
      // Show push prompt if not yet granted
      if (Notification.permission === 'default') {
        setPushPrompt(true)
      } else if (Notification.permission === 'granted') {
        await registerPush(reg)
      }
    })
  }, [])

  const handleEnablePush = async () => {
    setPushPrompt(false)
    const reg = await navigator.serviceWorker.ready
    await registerPush(reg)
  }

  return (
    <div className="flex flex-col h-full overflow-hidden" style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}>
      {/* Push permission banner */}
      {pushPrompt && (
        <div
          className="flex items-center justify-between px-4 py-2 text-sm"
          style={{ background: 'rgba(0,255,136,0.08)', borderBottom: '1px solid rgba(0,255,136,0.2)' }}
        >
          <span style={{ color: 'var(--text-secondary)' }}>
            🔔 Enable push notifications to receive agent alerts on this device
          </span>
          <div className="flex items-center gap-2 ml-4 shrink-0">
            <button
              onClick={handleEnablePush}
              className="px-3 py-1 rounded text-xs font-mono font-bold"
              style={{ background: 'var(--accent-green)', color: '#000' }}
            >
              Enable
            </button>
            <button
              onClick={() => setPushPrompt(false)}
              className="px-2 py-1 rounded text-xs font-mono"
              style={{ color: 'var(--text-dim)' }}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Persistent top bar */}
      <header
        className="h-14 sm:h-16 border-b flex items-center justify-between px-4 sm:px-6 sticky top-0 z-30"
        style={{ background: 'var(--bg-surface)', borderColor: 'var(--border)' }}
      >
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-3">
            <div className="hq-logo-accent w-6 h-6 sm:w-8 sm:h-8" />
            <h1 className="text-base font-bold tracking-[0.2em] uppercase hidden sm:block">
              HQ
            </h1>
          </div>
          <nav className="flex items-center gap-1">
            <Link
              to="/vault"
              className="px-3 py-1.5 rounded-lg text-xs font-mono font-bold transition-colors"
              activeProps={{ style: { background: 'rgba(255,255,255,0.08)', color: 'var(--text-primary)' } }}
              inactiveProps={{ style: { color: 'var(--text-dim)' } }}
            >
              Vault
            </Link>
            <Link
              to="/drawit"
              className="px-3 py-1.5 rounded-lg text-xs font-mono font-bold transition-colors"
              activeProps={{ style: { background: 'rgba(255,255,255,0.08)', color: 'var(--text-primary)' } }}
              inactiveProps={{ style: { color: 'var(--text-dim)' } }}
            >
              ◈ DrawIt
            </Link>
            <button
              onClick={() => useHQStore.getState().setChatPanelOpen(!useHQStore.getState().chatPanelOpen)}
              className="px-3 py-1.5 rounded-lg text-xs font-mono font-bold transition-colors"
              style={{ color: 'var(--text-dim)' }}
            >
              Chat
            </button>
          </nav>
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
          <button
            onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))}
            className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-mono transition-colors"
            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-dim)' }}
          >
            <span>⌕ Search</span>
            <kbd className="text-[10px] px-1 rounded" style={{ background: 'var(--bg-base)', border: '1px solid var(--border)' }}>⌘K</kbd>
          </button>
          <button
            onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true, bubbles: true }))}
            className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono transition-colors"
            style={{ background: 'rgba(0,255,136,0.08)', border: '1px solid rgba(0,255,136,0.2)', color: 'var(--accent-green)' }}
          >
            + Note
          </button>
          <div className="flex items-center gap-1.5">
            <div className={`status-dot ${wsConnected ? 'active' : 'error'}`} />
            <span className="text-[10px] font-mono hidden sm:block" style={{ color: 'var(--text-dim)' }}>
              {wsConnected ? 'live' : 'offline'}
            </span>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 min-h-0 overflow-hidden w-full">
        <Outlet />
      </main>
    </div>
  )
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body style={{ margin: 0, height: '100dvh', overflow: 'hidden' }}>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
