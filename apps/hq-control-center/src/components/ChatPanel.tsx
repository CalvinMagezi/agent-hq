import { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react'
import { MarkdownViewer } from '~/components/MarkdownViewer'
import { useHQStore } from '~/store/hqStore'

// ─── Scroll-to-bottom button ──────────────────────────────────────────────────

function ScrollToBottomButton({ visible, onClick }: { visible: boolean; onClick: () => void }) {
    return (
        <button
            onClick={onClick}
            className="absolute bottom-4 right-4 z-10 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-mono transition-all duration-300 shadow-lg"
            style={{
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border)',
                color: 'var(--text-dim)',
                opacity: visible ? 1 : 0,
                pointerEvents: visible ? 'auto' : 'none',
                transform: visible ? 'translateY(0)' : 'translateY(8px)',
            }}
            aria-hidden={!visible}
        >
            <span style={{ fontSize: 10 }}>↓</span>
            scroll to bottom
        </button>
    )
}

// ─── Harness definitions ──────────────────────────────────────────────────────

const HARNESSES = [
    { id: 'hq-agent', name: 'HQ Agent', short: 'HQ', color: '#8b5cf6' },
    { id: 'claude-code', name: 'Claude', short: 'Claude', color: '#e8a228' },
    { id: 'codex-cli', name: 'ChatGPT', short: 'ChatGPT', color: '#0ea5e9' },
    { id: 'gemini-cli', name: 'Gemini', short: 'Gemini', color: '#4285F4' },
    { id: 'opencode', name: 'All Models', short: 'All', color: '#10a37f' },
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

// Stable message key: timestamp + role + first 8 chars of content
function msgKey(msg: ThreadMessage, idx: number) {
    return `${msg.timestamp}-${msg.role}-${msg.content.slice(0, 8)}-${idx}`
}

// ─── Message skeleton (loading placeholder) ───────────────────────────────────

function MessageSkeleton() {
    return (
        <div className="flex flex-col gap-4 px-4 py-4 max-w-3xl mx-auto w-full">
            {/* Assistant skeleton */}
            <div className="flex gap-3 items-start">
                <div className="w-6 h-6 rounded-full flex-shrink-0 animate-pulse" style={{ background: 'var(--bg-elevated)' }} />
                <div className="flex-1 space-y-2 pt-0.5">
                    <div className="h-2 rounded animate-pulse w-16" style={{ background: 'var(--bg-elevated)' }} />
                    <div className="h-3 rounded animate-pulse w-3/4" style={{ background: 'var(--bg-elevated)' }} />
                    <div className="h-3 rounded animate-pulse w-1/2" style={{ background: 'var(--bg-elevated)' }} />
                </div>
            </div>
            {/* User skeleton */}
            <div className="flex justify-end">
                <div className="h-8 rounded-2xl animate-pulse w-1/3" style={{ background: 'var(--bg-elevated)' }} />
            </div>
            {/* Assistant skeleton */}
            <div className="flex gap-3 items-start">
                <div className="w-6 h-6 rounded-full flex-shrink-0 animate-pulse" style={{ background: 'var(--bg-elevated)' }} />
                <div className="flex-1 space-y-2 pt-0.5">
                    <div className="h-2 rounded animate-pulse w-16" style={{ background: 'var(--bg-elevated)' }} />
                    <div className="h-3 rounded animate-pulse w-full" style={{ background: 'var(--bg-elevated)' }} />
                    <div className="h-3 rounded animate-pulse w-5/6" style={{ background: 'var(--bg-elevated)' }} />
                    <div className="h-3 rounded animate-pulse w-2/3" style={{ background: 'var(--bg-elevated)' }} />
                </div>
            </div>
        </div>
    )
}

// ─── Reconnecting overlay ─────────────────────────────────────────────────────

function ReconnectingBanner() {
    return (
        <div
            className="mb-2 px-3 py-1.5 rounded-lg text-[10px] font-mono flex items-center gap-2"
            style={{ background: 'rgba(255,170,0,0.08)', border: '1px solid rgba(255,170,0,0.2)', color: 'rgba(255,170,0,0.8)' }}
        >
            <span className="w-1.5 h-1.5 rounded-full animate-pulse inline-block" style={{ background: 'rgba(255,170,0,0.8)' }} />
            Reconnecting…
        </div>
    )
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
                    className="absolute bottom-full mb-2 left-0 min-w-[220px] rounded-xl overflow-hidden shadow-2xl z-[100]"
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
                    className="max-w-[85%] rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm"
                    style={{ background: 'rgba(255,255,255,0.08)', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}
                >
                    <p className="whitespace-pre-wrap text-[13px] leading-relaxed break-words">{msg.content}</p>
                </div>
            </div>
        )
    }

    // Assistant
    return (
        <div className="flex gap-3 px-4 py-1.5 items-start max-w-full">
            <div
                className="w-6 h-6 rounded-full flex-shrink-0 flex items-center justify-center text-[10px] font-mono font-bold mt-0.5"
                style={{ background: `${h?.color ?? 'var(--accent-green)'}22`, color: h?.color ?? 'var(--accent-green)', border: `1px solid ${h?.color ?? 'var(--accent-green)'}44` }}
            >
                {h?.short.slice(0, 1) ?? 'A'}
            </div>

            <div className="flex-1 min-w-0 overflow-x-hidden">
                <div className="text-[10px] font-mono mb-1" style={{ color: h?.color ?? 'var(--text-dim)' }}>
                    {h?.name ?? 'Assistant'}
                </div>

                <div className="text-sm prose-invert max-w-none" style={{ color: 'var(--text-primary)' }}>
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

// ─── Thread drop-down item ───────────────────────────────────────────────────

function ThreadItem({ meta, active, onClick, onDelete }: {
    meta: ThreadMeta; active: boolean; onClick: () => void; onDelete: () => void
}) {
    const h = getHarness(meta.harness)
    return (
        <div
            className="group relative flex items-start gap-2.5 px-3 py-2 cursor-pointer transition-colors rounded-lg mx-1"
            style={{
                background: active ? 'rgba(255,255,255,0.06)' : 'transparent',
                borderLeft: active ? `2px solid ${h.color}` : '2px solid transparent',
            }}
            onClick={onClick}
        >
            <span className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0" style={{ background: h.color }} />
            <div className="flex-1 min-w-0">
                <p className="text-[11px] font-mono font-medium truncate" style={{ color: active ? 'var(--text-primary)' : 'var(--text-dim)' }}>
                    {meta.title || 'New chat'}
                </p>
                <p className="text-[9px] font-mono mt-0.5" style={{ color: 'var(--text-dim)' }}>
                    {h.short} · {relTime(meta.updatedAt)} · {meta.messageCount}m
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

// ─── Main Panel ───────────────────────────────────────────────────────────────

const LAST_THREAD_KEY = 'hq:chat:lastThreadId'
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 15000
const OFFLINE_GRACE_MS = 1500  // delay before showing offline UI

export function ChatPanel({ onClose, fullPage = false }: { onClose?: () => void; fullPage?: boolean }) {
    const wsRef = useRef<WebSocket | null>(null)
    const [wsReady, setWsReady] = useState(false)
    // Grace-period state: don't snap offline UI in immediately
    const [showOffline, setShowOffline] = useState(false)
    const offlineTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    // Token accumulator — batch streaming tokens into state at ~50ms intervals
    // instead of calling setState on every single token (prevents per-token re-renders)
    const tokenBufferRef = useRef('')
    const tokenFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    const [threads, setThreads] = useState<ThreadMeta[]>([])
    const [activeThreadId, setActiveThreadId] = useState<string | null>(null)
    const [messages, setMessages] = useState<ThreadMessage[]>([])
    const [isLoadingThread, setIsLoadingThread] = useState(false)
    const [streamingContent, setStreamingContent] = useState('')
    const [isStreaming, setIsStreaming] = useState(false)
    const [toolActivity, setToolActivity] = useState<string | null>(null)
    const [harness, setHarness] = useState<string>(DEFAULT_HARNESS)
    const [input, setInput] = useState('')
    const [dropdownOpen, setDropdownOpen] = useState(false)
    const messagesEndRef = useRef<HTMLDivElement>(null)
    const messagesContainerRef = useRef<HTMLDivElement>(null)
    const textareaRef = useRef<HTMLTextAreaElement>(null)
    const activeThreadRef = useRef<string | null>(null)
    const prevMsgCountRef = useRef(0)
    const [isAtBottom, setIsAtBottom] = useState(true)
    activeThreadRef.current = activeThreadId

    const { chatContext, setChatContext } = useHQStore()

    // Pre-fill composer from context
    useEffect(() => {
        if (chatContext) {
            const previewText = chatContext.content ? `\n\n${chatContext.content}\n\n---\n` : '\n\n'
            if (chatContext.type === 'file') {
                setInput(`[Referencing: [[${chatContext.path}]]]${previewText}`)
            } else {
                setInput(`[Referencing selection from: [[${chatContext.path}]]]${previewText}`)
            }
            setChatContext(null)
            setTimeout(() => textareaRef.current?.focus(), 50)
        }
    }, [chatContext, setChatContext])

    // Persist active thread across reconnects and page loads
    const setActiveThreadIdPersisted = useCallback((id: string | null) => {
        setActiveThreadId(id)
        if (id) localStorage.setItem(LAST_THREAD_KEY, id)
        else localStorage.removeItem(LAST_THREAD_KEY)
    }, [])

    // Track whether user is near the bottom of the scroll container
    useEffect(() => {
        const container = messagesContainerRef.current
        if (!container) return
        const handleScroll = () => {
            const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
            setIsAtBottom(distanceFromBottom < 80)
        }
        container.addEventListener('scroll', handleScroll, { passive: true })
        return () => container.removeEventListener('scroll', handleScroll)
    }, [])

    // Only auto-scroll when new messages arrive (count grew) or streaming progresses —
    // never when messages are cleared (which would jump to top of empty list).
    useLayoutEffect(() => {
        const grew = messages.length > prevMsgCountRef.current
        prevMsgCountRef.current = messages.length
        if ((grew || streamingContent) && isAtBottom) {
            messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
        }
    }, [messages, streamingContent, isAtBottom])

    const scrollToBottom = useCallback(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
        setIsAtBottom(true)
    }, [])

    // Auto-resize textarea
    useEffect(() => {
        const el = textareaRef.current
        if (!el) return
        el.style.height = 'auto'
        el.style.height = Math.min(el.scrollHeight, 200) + 'px'
    }, [input])

    // Connect WS with exponential backoff
    useEffect(() => {
        const wsUrl = `ws://${window.location.hostname}:4748/ws`
        let socket: WebSocket
        let retryTimer: ReturnType<typeof setTimeout>
        let attempt = 0

        const connect = () => {
            socket = new WebSocket(wsUrl)

            socket.onopen = () => {
                wsRef.current = socket
                attempt = 0
                setWsReady(true)
                setShowOffline(false)
                if (offlineTimerRef.current) {
                    clearTimeout(offlineTimerRef.current)
                    offlineTimerRef.current = null
                }
                socket.send(JSON.stringify({ type: 'chat:list' }))
            }

            socket.onclose = () => {
                wsRef.current = null
                setWsReady(false)
                // Grace period before showing offline UI so brief glitches don't snap the UI
                offlineTimerRef.current = setTimeout(() => {
                    setShowOffline(true)
                }, OFFLINE_GRACE_MS)

                // Exponential backoff capped at RECONNECT_MAX_MS
                const delay = Math.min(RECONNECT_BASE_MS * Math.pow(1.5, attempt), RECONNECT_MAX_MS)
                attempt++
                retryTimer = setTimeout(connect, delay)
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
                            setIsLoadingThread(true)
                            socket.send(JSON.stringify({ type: 'chat:load', threadId: toRestore }))
                        }
                    } else if (msg.type === 'chat:history') {
                        if (msg.thread) {
                            // Atomic swap: replace messages and clear loading in a single batch
                            setMessages(msg.thread.messages ?? [])
                            setHarness(msg.thread.harness)
                            prevMsgCountRef.current = 0 // reset so scroll fires correctly on load
                            setIsLoadingThread(false)
                        }
                    } else if (msg.type === 'chat:status') {
                        if (msg.threadId === tid) {
                            setToolActivity(msg.status ?? null)
                        }
                    } else if (msg.type === 'chat:token') {
                        if (msg.threadId === tid) {
                            setToolActivity(null)
                            // Accumulate tokens; flush to state at 50ms intervals (not per-token)
                            tokenBufferRef.current += msg.token
                            if (!tokenFlushRef.current) {
                                tokenFlushRef.current = setTimeout(() => {
                                    tokenFlushRef.current = null
                                    setStreamingContent(prev => prev + tokenBufferRef.current)
                                    tokenBufferRef.current = ''
                                }, 50)
                            }
                        }
                    } else if (msg.type === 'chat:done') {
                        if (msg.threadId === tid) {
                            // Flush any remaining buffered tokens before clearing
                            if (tokenFlushRef.current) {
                                clearTimeout(tokenFlushRef.current)
                                tokenFlushRef.current = null
                            }
                            if (tokenBufferRef.current) {
                                setStreamingContent(prev => prev + tokenBufferRef.current)
                                tokenBufferRef.current = ''
                            }
                            setIsStreaming(false)
                            setStreamingContent('')
                            setToolActivity(null)
                            setIsLoadingThread(true)
                            socket.send(JSON.stringify({ type: 'chat:load', threadId: tid }))
                            socket.send(JSON.stringify({ type: 'chat:list' }))
                        }
                    } else if (msg.type === 'chat:error') {
                        if (msg.threadId === tid) {
                            setIsStreaming(false)
                            setStreamingContent('')
                            setToolActivity(null)
                            setIsLoadingThread(false)
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
            if (offlineTimerRef.current) clearTimeout(offlineTimerRef.current)
            if (tokenFlushRef.current) clearTimeout(tokenFlushRef.current)
        }
    }, [])

    const openThread = useCallback((threadId: string) => {
        setActiveThreadIdPersisted(threadId)
        // Don't clear messages immediately — show skeleton overlay instead to avoid blank flash
        setIsLoadingThread(true)
        setStreamingContent('')
        setIsStreaming(false)
        setDropdownOpen(false)
        wsRef.current?.send(JSON.stringify({ type: 'chat:load', threadId }))
    }, [setActiveThreadIdPersisted])

    const newThread = useCallback(() => {
        const threadId = newThreadId()
        setActiveThreadIdPersisted(threadId)
        setMessages([])
        setIsLoadingThread(false)
        prevMsgCountRef.current = 0
        setStreamingContent('')
        setIsStreaming(false)
        setInput('')
        setDropdownOpen(false)
    }, [setActiveThreadIdPersisted])

    const deleteThread = useCallback((threadId: string) => {
        wsRef.current?.send(JSON.stringify({ type: 'chat:delete', threadId }))
        if (activeThreadId === threadId) {
            setActiveThreadIdPersisted(null)
            setMessages([])
            setIsLoadingThread(false)
            prevMsgCountRef.current = 0
        }
    }, [activeThreadId, setActiveThreadIdPersisted])

    const sendMessage = useCallback(() => {
        const content = input.trim()
        if (!content || isStreaming || !wsRef.current) return

        const threadId = activeThreadId ?? newThreadId()
        activeThreadRef.current = threadId
        if (!activeThreadId) setActiveThreadIdPersisted(threadId)

        const userMsg: ThreadMessage = { role: 'user', content, timestamp: new Date().toISOString() }
        setMessages(prev => [...prev, userMsg])
        setInput('')
        setIsStreaming(true)
        setStreamingContent('')
        setToolActivity(null)
        setIsAtBottom(true)

        wsRef.current.send(JSON.stringify({ type: 'chat:send', threadId, content, harness }))
    }, [input, isStreaming, activeThreadId, harness, setActiveThreadIdPersisted])

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            sendMessage()
        }
    }

    const streamMsg: ThreadMessage | null = isStreaming ? {
        role: 'assistant',
        content: toolActivity ? '' : streamingContent,
        harness,
        timestamp: new Date().toISOString(),
    } : null

    const activeTitle = activeThreadId ? (threads.find(t => t.threadId === activeThreadId)?.title ?? 'New conversation') : 'Select or start'

    const visibleMessages = messages.filter(m => !(m.role === 'assistant' && !m.content))

    return (
        <div className={`h-full flex flex-col bg-transparent ${fullPage ? 'w-full' : ''}`}>
            {/* Header */}
            <div className="flex-shrink-0 flex items-center justify-between px-3 py-2.5 border-b" style={{ borderColor: 'var(--border)', background: 'var(--bg-surface)' }}>
                <div className="flex items-center gap-2 min-w-0 flex-1 relative">
                    <button
                        onClick={() => setDropdownOpen(o => !o)}
                        className="flex items-center gap-1.5 px-2 py-1 rounded hover:bg-white/5 transition-colors min-w-0"
                    >
                        <span className="text-[11px] font-mono truncate" style={{ color: 'var(--text-primary)' }}>
                            {activeTitle}
                        </span>
                        <span className="text-[9px] opacity-60">▾</span>
                    </button>

                    {dropdownOpen && (
                        <>
                            <div className="fixed inset-0 z-40" onClick={() => setDropdownOpen(false)} />
                            <div
                                className="absolute top-full left-0 mt-1 w-64 rounded-xl shadow-2xl z-50 flex flex-col max-h-[60vh]"
                                style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
                            >
                                <div className="p-2 border-b" style={{ borderColor: 'var(--border)' }}>
                                    <button
                                        onClick={newThread}
                                        className="w-full flex items-center justify-center gap-2 px-3 py-1.5 rounded-lg text-xs font-mono transition-colors"
                                        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                                    >
                                        <span className="text-sm leading-none">+</span> New Chat
                                    </button>
                                </div>
                                <div className="overflow-y-auto p-1 flex-1">
                                    {threads.length === 0 ? (
                                        <div className="p-4 text-center text-xs font-mono" style={{ color: 'var(--text-dim)' }}>No history</div>
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
                            </div>
                        </>
                    )}
                </div>

                <div className="flex items-center gap-2">
                    {/* Connection dot — amber pulsing while reconnecting, green when live */}
                    <div
                        className="flex items-center gap-1.5 mr-1"
                        title={wsReady ? 'Connected' : showOffline ? 'Offline' : 'Reconnecting…'}
                    >
                        <div
                            className="w-1.5 h-1.5 rounded-full"
                            style={{
                                background: wsReady
                                    ? 'var(--accent-green)'
                                    : showOffline
                                        ? 'var(--accent-red)'
                                        : 'rgba(255,170,0,0.8)',
                                transition: 'background 0.4s ease',
                                animation: !wsReady && !showOffline ? 'pulse 1s infinite' : 'none',
                            }}
                        />
                    </div>
                    {onClose && (
                        <button onClick={onClose} className="p-1 rounded opacity-60 hover:opacity-100 hover:bg-white/10" style={{ color: 'var(--text-primary)' }}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                        </button>
                    )}
                </div>
            </div>

            {/* Messages View */}
            <div className="relative flex-1 min-h-0 bg-transparent flex flex-col">
                <div
                    ref={messagesContainerRef}
                    className="flex-1 overflow-y-auto pt-4 pb-8 px-2"
                    style={{ background: 'rgba(0,0,0,0.1)' }}
                >
                    {/* Loading skeleton — shown while thread history is in flight */}
                    {isLoadingThread ? (
                        <MessageSkeleton />
                    ) : !activeThreadId && messages.length === 0 ? (
                        <div className="h-full flex flex-col items-center justify-center gap-4 px-4">
                            <div className="text-3xl opacity-20">◎</div>
                            <p className="text-[11px] font-mono text-center" style={{ color: 'var(--text-dim)' }}>
                                Start a new conversation
                            </p>
                        </div>
                    ) : (
                        <div className="max-w-3xl mx-auto space-y-1">
                            {visibleMessages.map((msg, i) => (
                                <MessageBubble key={msgKey(msg, i)} msg={msg} />
                            ))}
                            {streamMsg && <MessageBubble msg={streamMsg} isStreaming />}
                            <div ref={messagesEndRef} />
                        </div>
                    )}
                </div>
                <ScrollToBottomButton
                    visible={!isAtBottom && (messages.length > 0 || isStreaming)}
                    onClick={scrollToBottom}
                />
            </div>

            {/* Composer */}
            <div className="flex-shrink-0 p-3 pt-2 overflow-visible relative z-[60]" style={{ background: 'var(--bg-surface)', borderTop: '1px solid var(--border)' }}>
                {!wsReady && showOffline && <ReconnectingBanner />}
                <div className="max-w-3xl mx-auto">
                    <div className="flex flex-col rounded-xl" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>
                        <textarea
                            ref={textareaRef}
                            value={input}
                            onChange={e => setInput(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder={wsReady ? 'Message…' : 'Reconnecting…'}
                            disabled={isStreaming}
                            rows={1}
                            className="w-full px-3 py-2.5 font-mono bg-transparent outline-none resize-none"
                            style={{
                                color: 'var(--text-primary)',
                                minHeight: '36px',
                                maxHeight: '200px',
                                fontSize: '16px',  // prevents iOS Safari zoom
                            }}
                        />

                        <div className="flex items-center justify-between px-2 pb-2 mt-0.5">
                            <HarnessPicker value={harness} onChange={setHarness} />

                            <button
                                onClick={sendMessage}
                                disabled={!wsReady || isStreaming || !input.trim()}
                                className="w-6 h-6 rounded-lg flex items-center justify-center transition-all disabled:opacity-30 disabled:grayscale"
                                style={{ background: getHarness(harness).color, color: '#000' }}
                            >
                                {isStreaming ? (
                                    <span className="w-1 h-1 bg-black rounded-full animate-pulse" />
                                ) : (
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    )
}
