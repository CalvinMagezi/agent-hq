import { createFileRoute } from '@tanstack/react-router'
import { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react'
import { MarkdownViewer } from '~/components/MarkdownViewer'

export const Route = createFileRoute('/chat')({
  component: ChatPage,
})

// ─── Harness definitions ──────────────────────────────────────────────────────

const HARNESSES = [
  { id: 'claude-code', name: 'Claude Code', short: 'Claude', color: '#e8a228' },
  { id: 'gemini-cli', name: 'Gemini CLI', short: 'Gemini', color: '#4285F4' },
  { id: 'opencode', name: 'OpenCode', short: 'OpenCode', color: '#10a37f' },
  { id: 'hq-agent', name: 'HQ Agent', short: 'HQ', color: '#8b5cf6' },
  { id: 'codex-cli', name: 'Codex CLI', short: 'Codex', color: '#0ea5e9' },
] as const

const DEFAULT_HARNESS = HARNESSES[0].id

function getHarness(id: string) {
  return HARNESSES.find(h => h.id === id) ?? HARNESSES[0]
}

// ─── Types ────────────────────────────────────────────────────────────────────

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

interface ThreadMeta {
  threadId: string
  title: string
  harness: string
  updatedAt: string
  messageCount: number
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function newThreadId() {
  return `web-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

function relTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

// ─── Harness picker ───────────────────────────────────────────────────────────

function HarnessPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const h = getHarness(value)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-mono font-bold transition-colors"
        style={{ background: `${h.color}18`, border: `1px solid ${h.color}40`, color: h.color }}
      >
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: h.color }} />
        {h.short}
        <span className="opacity-60 text-[10px]">▾</span>
      </button>

      {open && (
        <div
          className="absolute bottom-full mb-2 left-0 min-w-[220px] rounded-xl overflow-hidden shadow-2xl z-50"
          style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
        >
          <div className="p-1.5 text-[9px] font-mono tracking-widest uppercase px-3 pt-2.5 pb-1" style={{ color: 'var(--text-dim)' }}>
            Switch harness
          </div>
          {HARNESSES.map(harness => (
            <button
              key={harness.id}
              onClick={() => { onChange(harness.id); setOpen(false) }}
              className="w-full flex items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-white/5"
            >
              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: harness.color }} />
              <div>
                <div className="text-xs font-mono font-bold" style={{ color: harness.id === value ? harness.color : 'var(--text-primary)' }}>
                  {harness.name}
                </div>
                <div className="text-[10px] font-mono" style={{ color: 'var(--text-dim)' }}>
                  {harness.id.split('/')[0]}
                </div>
              </div>
              {harness.id === value && <span className="ml-auto text-[10px]" style={{ color: harness.color }}>✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Message bubble ───────────────────────────────────────────────────────────

function MessageBubble({ msg, isStreaming }: { msg: ThreadMessage; isStreaming?: boolean }) {
  const h = msg.harness ? getHarness(msg.harness) : null

  if (msg.role === 'system') {
    return (
      <div className="flex items-center gap-3 py-2 px-4">
        <div className="flex-1 h-px" style={{ background: 'var(--border)' }} />
        <span className="text-[10px] font-mono px-2" style={{ color: 'var(--text-dim)' }}>{msg.content.replace(/^\[|\]$/g, '')}</span>
        <div className="flex-1 h-px" style={{ background: 'var(--border)' }} />
      </div>
    )
  }

  if (msg.role === 'user') {
    return (
      <div className="flex justify-end px-4 py-1.5">
        <div
          className="max-w-[75%] rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm"
          style={{ background: 'rgba(255,255,255,0.08)', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}
        >
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{msg.content}</p>
        </div>
      </div>
    )
  }

  // Assistant
  return (
    <div className="flex gap-3 px-4 py-1.5 items-start">
      {/* Harness avatar */}
      <div
        className="w-6 h-6 rounded-full flex-shrink-0 flex items-center justify-center text-[10px] font-mono font-bold mt-0.5"
        style={{ background: `${h?.color ?? 'var(--accent-green)'}22`, color: h?.color ?? 'var(--accent-green)', border: `1px solid ${h?.color ?? 'var(--accent-green)'}44` }}
      >
        {h?.short.slice(0, 1) ?? 'A'}
      </div>

      <div className="flex-1 min-w-0">
        {/* Harness label */}
        <div className="text-[10px] font-mono mb-1" style={{ color: h?.color ?? 'var(--text-dim)' }}>
          {h?.name ?? 'Assistant'}
        </div>

        {/* Content */}
        <div className="text-sm" style={{ color: 'var(--text-primary)' }}>
          {msg.content ? (
            <MarkdownViewer content={msg.content} />
          ) : isStreaming ? (
            <span className="inline-block w-2 h-4 align-middle animate-pulse" style={{ background: h?.color ?? 'var(--accent-green)' }} />
          ) : null}
          {isStreaming && msg.content && (
            <span className="inline-block w-0.5 h-4 align-middle ml-0.5 animate-pulse" style={{ background: h?.color ?? 'var(--accent-green)', marginTop: '-2px' }} />
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Thread sidebar item ──────────────────────────────────────────────────────

function ThreadItem({ meta, active, onClick, onDelete }: {
  meta: ThreadMeta; active: boolean; onClick: () => void; onDelete: () => void
}) {
  const h = getHarness(meta.harness)
  return (
    <div
      className="group relative flex items-start gap-2.5 px-3 py-2.5 cursor-pointer transition-colors rounded-lg mx-1"
      style={{
        background: active ? 'rgba(255,255,255,0.06)' : 'transparent',
        borderLeft: active ? `2px solid ${h.color}` : '2px solid transparent',
      }}
      onClick={onClick}
    >
      <span className="w-2 h-2 rounded-full mt-1 flex-shrink-0" style={{ background: h.color }} />
      <div className="flex-1 min-w-0">
        <p className="text-xs font-mono font-medium truncate" style={{ color: active ? 'var(--text-primary)' : 'var(--text-dim)' }}>
          {meta.title || 'New chat'}
        </p>
        <p className="text-[10px] font-mono mt-0.5" style={{ color: 'var(--text-dim)' }}>
          {h.short} · {relTime(meta.updatedAt)} · {meta.messageCount} msg
        </p>
      </div>
      <button
        onClick={e => { e.stopPropagation(); onDelete() }}
        className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 p-0.5 rounded hover:bg-white/10 text-[10px]"
        style={{ color: 'var(--text-dim)' }}
        title="Delete thread"
      >✕</button>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

const LAST_THREAD_KEY = 'hq:chat:lastThreadId'

function ChatPage() {
  const wsRef = useRef<WebSocket | null>(null)
  const [wsReady, setWsReady] = useState(false)
  const [threads, setThreads] = useState<ThreadMeta[]>([])
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ThreadMessage[]>([])
  const [streamingContent, setStreamingContent] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [toolActivity, setToolActivity] = useState<string | null>(null)
  const [harness, setHarness] = useState(DEFAULT_HARNESS)
  const [input, setInput] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const activeThreadRef = useRef<string | null>(null)
  activeThreadRef.current = activeThreadId

  // Persist active thread across reconnects and page loads
  const setActiveThreadIdPersisted = useCallback((id: string | null) => {
    setActiveThreadId(id)
    if (id) localStorage.setItem(LAST_THREAD_KEY, id)
    else localStorage.removeItem(LAST_THREAD_KEY)
  }, [])

  // Auto-scroll to bottom
  useLayoutEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamingContent])

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }, [input])

  // Connect WS
  useEffect(() => {
    const wsUrl = `ws://${window.location.hostname}:4748/ws`
    let socket: WebSocket
    let retryTimer: ReturnType<typeof setTimeout>

    const connect = () => {
      socket = new WebSocket(wsUrl)

      socket.onopen = () => {
        wsRef.current = socket
        setWsReady(true)
        socket.send(JSON.stringify({ type: 'chat:list' }))
      }

      socket.onclose = () => {
        wsRef.current = null
        setWsReady(false)
        retryTimer = setTimeout(connect, 3000)
      }

      socket.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data)
          const tid = activeThreadRef.current

          if (msg.type === 'chat:threads') {
            setThreads(msg.threads)
            // Restore last active thread on reconnect / fresh load
            if (!activeThreadRef.current && msg.threads.length > 0) {
              const saved = localStorage.getItem(LAST_THREAD_KEY)
              const toRestore = saved && msg.threads.find((t: ThreadMeta) => t.threadId === saved)
                ? saved
                : msg.threads[0].threadId
              activeThreadRef.current = toRestore
              setActiveThreadId(toRestore)
              socket.send(JSON.stringify({ type: 'chat:load', threadId: toRestore }))
            }
          } else if (msg.type === 'chat:history') {
            if (msg.thread) {
              setMessages(msg.thread.messages)
              setHarness(msg.thread.harness)
            }
          } else if (msg.type === 'chat:status') {
            if (msg.threadId === tid) {
              setToolActivity(msg.status ?? null)
            }
          } else if (msg.type === 'chat:token') {
            if (msg.threadId === tid) {
              setToolActivity(null)
              setStreamingContent(prev => prev + msg.token)
            }
          } else if (msg.type === 'chat:done') {
            if (msg.threadId === tid) {
              setIsStreaming(false)
              setStreamingContent('')
              setToolActivity(null)
              // Reload the thread to get the saved message
              socket.send(JSON.stringify({ type: 'chat:load', threadId: tid }))
              socket.send(JSON.stringify({ type: 'chat:list' }))
            }
          } else if (msg.type === 'chat:error') {
            if (msg.threadId === tid) {
              setIsStreaming(false)
              setStreamingContent('')
              setToolActivity(null)
              setMessages(prev => [...prev, {
                role: 'system',
                content: `[Error: ${msg.error}]`,
                timestamp: new Date().toISOString(),
              }])
            }
          }
        } catch { /* ignore */ }
      }
    }

    connect()
    return () => {
      socket?.close()
      clearTimeout(retryTimer)
    }
  }, [])

  const openThread = useCallback((threadId: string) => {
    setActiveThreadIdPersisted(threadId)
    setMessages([])
    setStreamingContent('')
    setIsStreaming(false)
    setSidebarOpen(false)
    wsRef.current?.send(JSON.stringify({ type: 'chat:load', threadId }))
  }, [setActiveThreadIdPersisted])

  const newThread = useCallback(() => {
    const threadId = newThreadId()
    setActiveThreadIdPersisted(threadId)
    setMessages([])
    setStreamingContent('')
    setIsStreaming(false)
    setInput('')
    setSidebarOpen(false)
  }, [setActiveThreadIdPersisted])

  const deleteThread = useCallback((threadId: string) => {
    wsRef.current?.send(JSON.stringify({ type: 'chat:delete', threadId }))
    if (activeThreadId === threadId) {
      setActiveThreadIdPersisted(null)
      setMessages([])
    }
  }, [activeThreadId, setActiveThreadIdPersisted])

  const sendMessage = useCallback(() => {
    const content = input.trim()
    if (!content || isStreaming || !wsRef.current) return

    const threadId = activeThreadId ?? newThreadId()
    // Sync the ref immediately so WS message handlers see the correct threadId
    // before the async state update propagates
    activeThreadRef.current = threadId
    if (!activeThreadId) setActiveThreadIdPersisted(threadId)

    // Optimistically add user message
    const userMsg: ThreadMessage = { role: 'user', content, timestamp: new Date().toISOString() }
    setMessages(prev => [...prev, userMsg])
    setInput('')
    setIsStreaming(true)
    setStreamingContent('')
    setToolActivity(null)

    wsRef.current.send(JSON.stringify({ type: 'chat:send', threadId, content, harness }))
  }, [input, isStreaming, activeThreadId, harness, setActiveThreadIdPersisted])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  // Derived streaming message for display
  const streamMsg: ThreadMessage | null = isStreaming ? {
    role: 'assistant',
    content: toolActivity ? '' : streamingContent,
    harness,
    timestamp: new Date().toISOString(),
  } : null

  const hasNoKey = !wsReady

  // ── Sidebar ─────────────────────────────────────────────────────────────────
  const sidebar = (
    <div className="flex flex-col h-full">
      <div className="p-3 flex-shrink-0">
        <button
          onClick={newThread}
          className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl text-sm font-mono font-bold transition-colors"
          style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
        >
          <span className="text-base leading-none">+</span> New Chat
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-1 space-y-0.5">
        {threads.length === 0 ? (
          <p className="text-center text-xs font-mono py-8" style={{ color: 'var(--text-dim)' }}>No conversations yet</p>
        ) : threads.map(t => (
          <ThreadItem
            key={t.threadId}
            meta={t}
            active={t.threadId === activeThreadId}
            onClick={() => openThread(t.threadId)}
            onDelete={() => deleteThread(t.threadId)}
          />
        ))}
      </div>

      <div className="p-3 border-t flex-shrink-0 space-y-1" style={{ borderColor: 'var(--border)' }}>
        <div className="text-[9px] font-mono tracking-widest uppercase mb-2" style={{ color: 'var(--text-dim)' }}>
          Agents
        </div>
        {HARNESSES.map(h => (
          <div key={h.id} className="flex items-center gap-2 text-[10px] font-mono" style={{ color: 'var(--text-dim)' }}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: h.color }} />
            {h.name}
          </div>
        ))}
      </div>
    </div>
  )

  return (
    <div className="h-full flex overflow-hidden">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div className="md:hidden fixed inset-0 z-40 bg-black/60" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Thread sidebar */}
      <aside
        className={`
          fixed md:relative inset-y-0 left-0 z-50
          w-72 flex-shrink-0 border-r
          transition-transform duration-200
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
        `}
        style={{ background: 'var(--bg-surface)', borderColor: 'var(--border)' }}
      >
        <div className="flex items-center justify-between px-3 py-3 border-b flex-shrink-0" style={{ borderColor: 'var(--border)' }}>
          <span className="text-xs font-mono font-bold tracking-wider" style={{ color: 'var(--text-dim)' }}>CONVERSATIONS</span>
          <button onClick={() => setSidebarOpen(false)} className="md:hidden text-xs" style={{ color: 'var(--text-dim)' }}>✕</button>
        </div>
        {sidebar}
      </aside>

      {/* Chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Chat header */}
        <div
          className="flex-shrink-0 flex items-center gap-3 px-4 py-3 border-b"
          style={{ background: 'var(--bg-surface)', borderColor: 'var(--border)' }}
        >
          <button
            onClick={() => setSidebarOpen(true)}
            className="md:hidden p-1.5 rounded text-xs"
            style={{ background: 'var(--bg-elevated)', color: 'var(--text-dim)', border: '1px solid var(--border)' }}
          >
            ☰
          </button>
          <div className="flex-1 min-w-0">
            {activeThreadId ? (
              <p className="text-xs font-mono truncate" style={{ color: 'var(--text-dim)' }}>
                {threads.find(t => t.threadId === activeThreadId)?.title ?? 'New conversation'}
              </p>
            ) : (
              <p className="text-xs font-mono" style={{ color: 'var(--text-dim)' }}>Select or start a conversation</p>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <div
              className="w-1.5 h-1.5 rounded-full"
              style={{ background: wsReady ? 'var(--accent-green)' : 'var(--accent-red)' }}
            />
            <span className="text-[10px] font-mono" style={{ color: 'var(--text-dim)' }}>
              {wsReady ? 'connected' : 'offline'}
            </span>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto py-4" style={{ background: 'var(--bg-base)' }}>
          {!activeThreadId && messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center gap-4 px-6">
              <div className="text-4xl opacity-20">◎</div>
              <p className="text-sm font-mono text-center" style={{ color: 'var(--text-dim)' }}>
                Start a new conversation or select one from the left
              </p>
              <div className="flex flex-wrap justify-center gap-2 mt-2">
                {HARNESSES.slice(0, 3).map(h => (
                  <button
                    key={h.id}
                    onClick={() => { setHarness(h.id); newThread() }}
                    className="px-3 py-1.5 rounded-full text-xs font-mono transition-colors"
                    style={{ background: `${h.color}18`, border: `1px solid ${h.color}40`, color: h.color }}
                  >
                    {h.name}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="max-w-3xl mx-auto space-y-1 pb-4">
              {messages
                .filter(m => m.role !== 'tool' && !(m.role === 'assistant' && !m.content))
                .map((msg, i) => (
                  <MessageBubble key={i} msg={msg} />
                ))}
              {streamMsg && <MessageBubble msg={streamMsg} isStreaming />}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Composer */}
        <div
          className="flex-shrink-0 border-t p-3 sm:p-4"
          style={{ background: 'var(--bg-surface)', borderColor: 'var(--border)' }}
        >
          {hasNoKey && (
            <div className="mb-2 px-3 py-1.5 rounded-lg text-xs font-mono" style={{ background: 'rgba(255,68,68,0.08)', border: '1px solid rgba(255,68,68,0.2)', color: 'var(--accent-red)' }}>
              ws-server offline — run <code>bun run ws</code> to enable chat
            </div>
          )}
          <div className="max-w-3xl mx-auto">
            <div
              className="flex flex-col rounded-2xl"
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
            >
              <textarea
                ref={textareaRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={wsReady ? 'Message… (Shift+Enter for newline)' : 'Connecting…'}
                disabled={!wsReady || isStreaming}
                rows={1}
                className="w-full px-4 pt-3 pb-1 font-mono bg-transparent outline-none resize-none rounded-t-2xl"
                style={{ color: 'var(--text-primary)', minHeight: '44px', maxHeight: '200px', fontSize: '16px' }}
              />

              <div className="flex items-center justify-between px-3 pb-2.5 pt-1 gap-3 overflow-visible">
                <HarnessPicker value={harness} onChange={setHarness} />

                <div className="flex items-center gap-2 text-[10px] font-mono" style={{ color: 'var(--text-dim)' }}>
                  {isStreaming && toolActivity && (
                    <span className="animate-pulse flex items-center gap-1" style={{ color: getHarness(harness).color }}>
                      <span className="inline-block w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: getHarness(harness).color }} />
                      {toolActivity}…
                    </span>
                  )}
                  {isStreaming && !toolActivity && (
                    <span className="animate-pulse" style={{ color: getHarness(harness).color }}>
                      generating…
                    </span>
                  )}
                  <span className="hidden sm:block opacity-50">Shift+Enter = newline</span>
                </div>

                <button
                  onClick={sendMessage}
                  disabled={!wsReady || isStreaming || !input.trim()}
                  className="px-4 py-1.5 rounded-xl text-xs font-mono font-bold transition-all"
                  style={{
                    background: getHarness(harness).color,
                    color: '#000',
                    opacity: (!wsReady || isStreaming || !input.trim()) ? 0.3 : 1,
                  }}
                >
                  {isStreaming ? '…' : 'Send ↵'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
