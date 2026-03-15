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
    { id: 'hq-agent', name: 'HQ Agent', short: 'HQ', color: '#8b5cf6',
      model: 'gemini-2.5-flash', contextWindow: 1048576, capabilities: ['tools', 'vault-access'] },
    { id: 'claude-code', name: 'Claude', short: 'Claude', color: '#e8a228',
      model: 'claude-sonnet-4-6', contextWindow: 200000, capabilities: ['streaming', 'session', 'tools'] },
    { id: 'codex-cli', name: 'ChatGPT', short: 'ChatGPT', color: '#0ea5e9',
      model: 'gpt-5', contextWindow: 200000, capabilities: ['session', 'tools'] },
    { id: 'gemini-cli', name: 'Gemini', short: 'Gemini', color: '#4285F4',
      model: 'gemini-2.5-flash', contextWindow: 1048576, capabilities: ['streaming'] },
    { id: 'opencode', name: 'All Models', short: 'All', color: '#10a37f',
      model: 'moonshotai/kimi-k2', contextWindow: 200000, capabilities: [] },
]

const DEFAULT_HARNESS = HARNESSES[0].id

function getHarness(id: string) {
    return HARNESSES.find(h => h.id === id) ?? HARNESSES[0]
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface MessageStats {
    model: string
    latencyMs: number
    inputTokens: number
    outputTokens: number
    cost: number
    contextUsed?: number
}

interface ThreadMessage {
    role: 'user' | 'assistant' | 'system'
    content: string
    harness?: string
    timestamp: string
    stats?: MessageStats
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
                    className="absolute bottom-full mb-2 left-0 min-w-[320px] rounded-xl overflow-hidden shadow-2xl z-[100]"
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
                            <div className="min-w-0 flex-1">
                                <div className="text-xs font-mono font-bold truncate" style={{ color: harness.id === value ? harness.color : 'var(--text-primary)' }}>
                                    {harness.name}
                                </div>
                                <div className="text-[10px] font-mono opacity-50 truncate">
                                    {harness.model}
                                </div>
                            </div>
                            <div className="flex items-center gap-1.5 flex-shrink-0">
                                <span className="text-[8px] font-mono px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-elevated)', color: 'var(--text-dim)' }}>
                                    {harness.contextWindow >= 1048576 ? `${(harness.contextWindow / 1048576).toFixed(0)}M` : `${harness.contextWindow / 1000}K`}
                                </span>
                                {harness.capabilities.includes('session') && (
                                    <span className="text-[7px] font-mono px-1 py-0.5 rounded bg-green-500/10 text-green-400">session</span>
                                )}
                                {harness.capabilities.includes('tools') && (
                                    <span className="text-[7px] font-mono px-1 py-0.5 rounded bg-blue-500/10 text-blue-400">tools</span>
                                )}
                            </div>
                            {harness.id === value && <span className="ml-1 text-[10px]" style={{ color: harness.color }}>✓</span>}
                        </button>
                    ))}
                    {/* Comparison footer */}
                    <div className="border-t px-3 py-2" style={{ borderColor: 'var(--border)' }}>
                        <table className="w-full text-[8px] font-mono" style={{ color: 'var(--text-dim)' }}>
                            <thead>
                                <tr className="opacity-60">
                                    <th className="text-left py-0.5">Harness</th>
                                    <th className="text-center py-0.5">Context</th>
                                    <th className="text-center py-0.5">Stream</th>
                                    <th className="text-center py-0.5">Session</th>
                                    <th className="text-center py-0.5">Tools</th>
                                </tr>
                            </thead>
                            <tbody>
                                {HARNESSES.map(h => (
                                    <tr key={h.id} style={{ color: h.id === value ? h.color : undefined }}>
                                        <td className="py-0.5">{h.short}</td>
                                        <td className="text-center">{h.contextWindow >= 1048576 ? `${(h.contextWindow / 1048576).toFixed(0)}M` : `${h.contextWindow / 1000}K`}</td>
                                        <td className="text-center">{h.capabilities.includes('streaming') ? '✓' : '—'}</td>
                                        <td className="text-center">{h.capabilities.includes('session') ? '✓' : '—'}</td>
                                        <td className="text-center">{h.capabilities.includes('tools') ? '✓' : '—'}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}
        </div>
    )
}

// ─── Message bubble ───────────────────────────────────────────────────────────

function MessageBubble({ msg, isStreaming, isNew, onRetry }: { 
    msg: ThreadMessage; isStreaming?: boolean; isNew?: boolean; onRetry?: () => void 
}) {
    const h = msg.harness ? getHarness(msg.harness) : null
    const tsLabel = msg.timestamp ? new Date(msg.timestamp).toLocaleString() : ''
    const [copied, setCopied] = useState(false)

    const handleCopy = () => {
        navigator.clipboard.writeText(msg.content)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    }

    if (msg.role === 'system') {
        return (
            <div className={`flex items-center gap-3 py-2 px-4${isNew ? ' msg-new' : ''}`}>
                <div className="flex-1 h-px" style={{ background: 'var(--border)' }} />
                <span className="text-[10px] font-mono px-2" style={{ color: 'var(--text-dim)' }}>{msg.content.replace(/^\[|\]$/g, '')}</span>
                <div className="flex-1 h-px" style={{ background: 'var(--border)' }} />
            </div>
        )
    }

    if (msg.role === 'user') {
        return (
            <div className={`flex justify-end px-4 py-1.5${isNew ? ' msg-new' : ''}`} title={tsLabel}>
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
        <div className={`group relative flex gap-3 px-4 py-1.5 items-start max-w-full${isNew ? ' msg-new' : ''}`} title={tsLabel}>
            <div
                className="w-6 h-6 rounded-full flex-shrink-0 flex items-center justify-center text-[10px] font-mono font-bold mt-0.5"
                style={{ background: `${h?.color ?? 'var(--accent-green)'}22`, color: h?.color ?? 'var(--accent-green)', border: `1px solid ${h?.color ?? 'var(--accent-green)'}44` }}
            >
                {h?.short.slice(0, 1) ?? 'A'}
            </div>

            <div className="flex-1 min-w-0 overflow-x-hidden">
                <div className="flex items-center justify-between mb-1">
                    <div className="text-[10px] font-mono" style={{ color: h?.color ?? 'var(--text-dim)' }}>
                        {h?.name ?? 'Assistant'}
                    </div>
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

                {!isStreaming && (
                    <div className="absolute top-2 right-6 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1">
                        <button 
                            onClick={handleCopy}
                            className="p-1.5 rounded hover:bg-white/10 text-[10px] font-mono"
                            style={{ color: 'var(--text-dim)' }}
                        >
                            {copied ? '✓ Copied' : 'Copy'}
                        </button>
                        {onRetry && (
                            <button 
                                onClick={onRetry}
                                className="p-1.5 rounded hover:bg-white/10 text-[10px] font-mono"
                                style={{ color: 'var(--text-dim)' }}
                            >
                                Retry
                            </button>
                        )}
                    </div>
                )}

                {msg.stats && (
                    <div className="text-[9px] font-mono mt-1.5 flex gap-2" style={{ color: 'var(--text-dim)' }}>
                        <span>{msg.stats.model}</span>
                        <span>·</span>
                        <span>{(msg.stats.latencyMs / 1000).toFixed(1)}s</span>
                        <span>·</span>
                        <span>{msg.stats.outputTokens.toLocaleString()} tok</span>
                        {msg.stats.cost > 0 && <><span>·</span><span>${msg.stats.cost.toFixed(4)}</span></>}
                    </div>
                )}
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
    const isThreadSwitchRef = useRef(false) // true when user explicitly opens a thread
    const [input, setInput] = useState('')
    const [dropdownOpen, setDropdownOpen] = useState(false)
    // Phase 2 Stats State
    const [sessionTotals, setSessionTotals] = useState<{ inputTokens: number; outputTokens: number; cost: number }>({ inputTokens: 0, outputTokens: 0, cost: 0 })
    const [sessionInfo, setSessionInfo] = useState<{ active: boolean; expiresIn?: string } | null>(null)
    const [lastMsgStats, setLastMsgStats] = useState<MessageStats | null>(null)

    const messagesEndRef = useRef<HTMLDivElement>(null)
    const messagesContainerRef = useRef<HTMLDivElement>(null)
    const textareaRef = useRef<HTMLTextAreaElement>(null)
    const activeThreadRef = useRef<string | null>(null)
    const prevMsgCountRef = useRef(0)
    const [isAtBottom, setIsAtBottom] = useState(true)
    // Track which message indices are newly arrived (for animation)
    const [newMsgIndices, setNewMsgIndices] = useState<Set<number>>(new Set())
    // Rename state
    const [renamingTitle, setRenamingTitle] = useState(false)
    const [renameValue, setRenameValue] = useState('')
    const renameInputRef = useRef<HTMLInputElement>(null)
    // Phase 3: Thread search
    const [threadSearch, setThreadSearch] = useState('')
    // Phase 4: Quick replies
    const [suggestions, setSuggestions] = useState<string[]>([])
    // Slash commands
    const [commandQuery, setCommandQuery] = useState('')
    const [selectedCommandIdx, setSelectedCommandIdx] = useState(0)
    // In-conversation message search (Cmd+F)
    const [msgSearchOpen, setMsgSearchOpen] = useState(false)
    const [msgSearchQuery, setMsgSearchQuery] = useState('')
    const [msgSearchIdx, setMsgSearchIdx] = useState(0)
    const msgSearchRef = useRef<HTMLInputElement>(null)
    // Sound notification preference
    const [soundEnabled, setSoundEnabled] = useState(() => localStorage.getItem('hq-chat-sound') !== 'off')
    // Upload in progress
    const [isUploading, setIsUploading] = useState(false)
    const fileInputRef = useRef<HTMLInputElement>(null)

    const COMMANDS = [
        { id: 'clear', name: 'clear', desc: 'Clear thread history', server: true },
        { id: 'new', name: 'new', desc: 'Create new thread', server: false },
        { id: 'rename', name: 'rename', desc: 'Rename current thread', descLong: '/rename <title>', server: true },
        { id: 'export', name: 'export', desc: 'Download thread as .md', server: false },
        { id: 'search', name: 'search', desc: 'Search vault inline', descLong: '/search <query>', server: true },
        { id: 'model', name: 'model', desc: 'Show current model info', server: false },
        { id: 'help', name: 'help', desc: 'List available commands', server: false },
    ]
    const filteredCommands = commandQuery ? COMMANDS.filter(c => c.name.startsWith(commandQuery)) : COMMANDS



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

    // Only auto-scroll when new messages arrive (count grew) or streaming progresses
    useLayoutEffect(() => {
        const prevCount = prevMsgCountRef.current
        const grew = messages.length > prevCount
        if (grew) {
            // Mark new messages for arrival animation
            const newIndices = new Set<number>()
            for (let i = prevCount; i < messages.length; i++) newIndices.add(i)
            setNewMsgIndices(newIndices)
            setTimeout(() => setNewMsgIndices(new Set()), 400)
        }
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
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        const wsUrl = `${wsProtocol}//${window.location.host}/ws`
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
                            isThreadSwitchRef.current = true // restore harness from saved thread
                            socket.send(JSON.stringify({ type: 'chat:load', threadId: toRestore }))
                        }
                    } else if (msg.type === 'chat:history') {
                        // Always clear loading state regardless of whether thread is null
                        setIsLoadingThread(false)
                        if (msg.thread) {
                            // Atomic swap: replace messages and clear ALL streaming state in one batch
                            setMessages(msg.thread.messages ?? [])
                            setIsStreaming(false)
                            setStreamingContent('')
                            setToolActivity(null)
                            // Only restore harness from thread on explicit thread switch,
                            // not on post-response reload (preserves user's harness pick)
                            if (isThreadSwitchRef.current) {
                                setHarness(msg.thread.harness || DEFAULT_HARNESS)
                                isThreadSwitchRef.current = false
                            }
                            prevMsgCountRef.current = 0
                            if (msg.sessionTotals) setSessionTotals(msg.sessionTotals)
                            if (msg.sessionInfo) setSessionInfo(msg.sessionInfo)
                        } else {
                            // Thread not yet on disk — streaming is done, clear state so UI doesn't hang
                            setIsStreaming(false)
                            setStreamingContent('')
                            setToolActivity(null)
                        }
                    } else if (msg.type === 'chat:status') {
                        if (msg.threadId === tid) {
                            setToolActivity(msg.status ?? null)
                        }
                    } else if (msg.type === 'chat:token') {
                        if (msg.threadId === tid) {
                            setToolActivity(null)
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
                            // Flush any remaining buffered tokens into streamingContent so the
                            // bubble shows the complete response while we wait for chat:history.
                            if (tokenFlushRef.current) {
                                clearTimeout(tokenFlushRef.current)
                                tokenFlushRef.current = null
                            }
                            if (tokenBufferRef.current) {
                                setStreamingContent(prev => prev + tokenBufferRef.current)
                                tokenBufferRef.current = ''
                            }
                            // DO NOT clear isStreaming/streamingContent here — keep the bubble
                            // visible until chat:history arrives and atomically swaps messages.
                            // DO NOT set isLoadingThread — no skeleton flash.
                            if (msg.stats) setLastMsgStats(msg.stats)
                            if (msg.sessionTotals) setSessionTotals(msg.sessionTotals)

                            // Sound notification (only when tab not focused)
                            if (soundEnabled && !document.hasFocus()) {
                                try { (new Audio('/notification.wav')).play(); } catch {}
                            }

                            setSuggestions(['Tell me more', 'Give an example', 'Can you simplify this?'])

                            // Silent reload — chat:history will atomically replace messages
                            // AND clear streaming state in one React batch.
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
        isThreadSwitchRef.current = true // mark: restore harness from thread
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

    const activeTitle = activeThreadId ? (threads.find(t => t.threadId === activeThreadId)?.title ?? 'New conversation') : 'Select or start'

    const exportThread = useCallback(() => {
        const title = activeTitle
        const md = `# ${title}\n\n` + messages.map(m => {
            const h = m.harness ? getHarness(m.harness).name : ''
            const role = m.role === 'user' ? 'User' : (m.role === 'system' ? 'System' : h)
            return `**${role}:** ${m.content}\n`
        }).join('\n')
        const blob = new Blob([md], { type: 'text/markdown' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${title.toLowerCase().replace(/\s+/g, '-')}.md`
        a.click()
    }, [activeTitle, messages])

    const retryMessage = useCallback((idx: number) => {
        if (isStreaming || !activeThreadId) return
        // Find the user message preceding this assistant message
        let fromIdx = idx - 1
        while (fromIdx >= 0 && messages[fromIdx].role !== 'user') fromIdx--
        if (fromIdx < 0) return

        setMessages(prev => prev.slice(0, fromIdx + 1))
        prevMsgCountRef.current = fromIdx
        setIsStreaming(true)
        setStreamingContent('')
        wsRef.current?.send(JSON.stringify({ type: 'chat:retry', threadId: activeThreadId, fromIndex: fromIdx }))
    }, [isStreaming, activeThreadId, messages])

    const sendMessage = useCallback(() => {
        const content = input.trim()
        if (!content || isStreaming || !wsRef.current) return

        if (content.startsWith('/')) {
            const parts = content.slice(1).split(' ')
            const cmd = parts[0]
            const args = parts.slice(1).join(' ')
            
            if (cmd === 'clear') wsRef.current.send(JSON.stringify({ type: 'chat:reset', threadId: activeThreadId }))
            else if (cmd === 'new') newThread()
            else if (cmd === 'export') exportThread()
            else if (cmd === 'rename') {
                if (args && activeThreadId) wsRef.current.send(JSON.stringify({ type: 'chat:rename', threadId: activeThreadId, title: args }))
            } else if (cmd === 'search') {
                if (args && activeThreadId) wsRef.current.send(JSON.stringify({ type: 'chat:search', threadId: activeThreadId, query: args }))
            } else if (cmd === 'model') {
                const h = getHarness(harness)
                setMessages(prev => [...prev, { role: 'system', content: `[Current Model: ${h.model} | Window: ${h.contextWindow.toLocaleString()} | Caps: ${h.capabilities.join(', ')}]`, timestamp: new Date().toISOString() }])
            } else if (cmd === 'help') {
                const help = COMMANDS.map(c => `/ ${c.name} — ${c.desc}`).join('\n')
                setMessages(prev => [...prev, { role: 'system', content: `[Available Commands:\n${help}]`, timestamp: new Date().toISOString() }])
            }
            setInput('')
            return
        }

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

    const cycleHarness = useCallback(() => {
        const idx = HARNESSES.findIndex(h => h.id === harness)
        const next = HARNESSES[(idx + 1) % HARNESSES.length]
        setHarness(next.id)
    }, [harness])

    const visibleMessages = messages.filter(m => !(m.role === 'assistant' && !m.content))

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        const isMod = e.metaKey || e.ctrlKey
        
        if (commandQuery !== '') {
            if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSelectedCommandIdx(i => (i + 1) % filteredCommands.length)
                return
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSelectedCommandIdx(i => (i - 1 + filteredCommands.length) % filteredCommands.length)
                return
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault()
                const cmd = filteredCommands[selectedCommandIdx]
                if (cmd) {
                    setInput(`/${cmd.name} `)
                    setCommandQuery('')
                }
                return
            }
            if (e.key === 'Escape') {
                setCommandQuery('')
                return
            }
        }

        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            sendMessage()
        } else if (isMod && e.key === 'Enter') {
            e.preventDefault()
            sendMessage()
        } else if (isMod && e.key === '/') {
            e.preventDefault()
            cycleHarness()
        } else if (isMod && e.key === 'n') {
            e.preventDefault()
            newThread()
        } else if (isMod && e.key === 'f') {
            e.preventDefault()
            setMsgSearchOpen(true)
            setMsgSearchIdx(0)
            setTimeout(() => msgSearchRef.current?.focus(), 30)
        } else if (e.key === 'Escape') {
            if (msgSearchOpen) { setMsgSearchOpen(false); setMsgSearchQuery(''); }
            else setDropdownOpen(false)
        }
    }

    // Computed: message search matches
    const msgSearchMatches = msgSearchQuery
        ? visibleMessages.reduce<number[]>((acc, m, i) => {
            if (m.content.toLowerCase().includes(msgSearchQuery.toLowerCase())) acc.push(i)
            return acc
        }, [])
        : []

    const jumpToSearchMatch = useCallback((idx: number) => {
        const container = messagesContainerRef.current
        if (!container) return
        const els = container.querySelectorAll('[data-msg-idx]')
        const targetIdx = msgSearchMatches[idx]
        for (const el of els) {
            if (parseInt((el as HTMLElement).dataset.msgIdx ?? '-1') === targetIdx) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' })
                break
            }
        }
    }, [msgSearchMatches])

    const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const val = e.target.value
        setInput(val)
        if (val.startsWith('/') && !val.includes(' ')) {
            setCommandQuery(val.slice(1))
            setSelectedCommandIdx(0)
        } else {
            setCommandQuery('')
        }
    }

    const handlePaste = async (e: React.ClipboardEvent) => {
        const items = e.clipboardData.items
        for (let i = 0; i < items.length; i++) {
            if (items[i].type.indexOf('image') !== -1 || items[i].kind === 'file') {
                const file = items[i].getAsFile()
                if (!file) continue
                e.preventDefault()
                setIsUploading(true)
                try {
                    const wsUrl = wsRef.current?.url ?? ''
                    const baseUrl = window.location.origin
                    const form = new FormData()
                    form.append('file', file)
                    const res = await fetch(`${baseUrl}/upload`, { method: 'POST', body: form })
                    const data = await res.json()
                    if (data.ok && data.path) {
                        setInput(prev => `${prev}[Referencing: [[${data.path}]]]\n`.trim() + '\n')
                        setMessages(prev => [...prev, { role: 'system', content: `[Uploaded: ${data.name} (${(data.size / 1024).toFixed(1)}KB) → ${data.path}]`, timestamp: new Date().toISOString() }])
                    } else {
                        setMessages(prev => [...prev, { role: 'system', content: `[Upload failed: ${data.error ?? 'Unknown error'}]`, timestamp: new Date().toISOString() }])
                    }
                } catch (err: any) {
                    setMessages(prev => [...prev, { role: 'system', content: `[Upload error: ${err.message}]`, timestamp: new Date().toISOString() }])
                } finally {
                    setIsUploading(false)
                }
                return // Only handle first file
            }
        }
    }

    const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (!file) return
        e.target.value = '' // reset for re-selection
        setIsUploading(true)
        try {
            const baseUrl = window.location.origin
            const form = new FormData()
            form.append('file', file)
            const res = await fetch(`${baseUrl}/upload`, { method: 'POST', body: form })
            const data = await res.json()
            if (data.ok && data.path) {
                setInput(prev => `${prev}[Referencing: [[${data.path}]]]\n`.trim() + '\n')
                setMessages(prev => [...prev, { role: 'system', content: `[Attached: ${data.name} (${(data.size / 1024).toFixed(1)}KB)]`, timestamp: new Date().toISOString() }])
            } else {
                setMessages(prev => [...prev, { role: 'system', content: `[Upload failed: ${data.error ?? 'Unknown error'}]`, timestamp: new Date().toISOString() }])
            }
        } catch (err: any) {
            setMessages(prev => [...prev, { role: 'system', content: `[Upload error: ${err.message}]`, timestamp: new Date().toISOString() }])
        } finally {
            setIsUploading(false)
        }
    }

    const streamMsg: ThreadMessage | null = isStreaming ? {
        role: 'assistant',
        content: (toolActivity || (!toolActivity && !streamingContent)) ? '' : streamingContent,
        harness,
        timestamp: new Date().toISOString(),
    } : null

    // Thinking indicator: streaming has started but no tokens yet and no tool activity
    const showThinking = isStreaming && !streamingContent && !toolActivity

    return (
        <div className={`h-full flex flex-col bg-transparent ${fullPage ? 'w-full' : ''}`}>
            {/* Header */}
            <div className="flex-shrink-0 flex items-center justify-between px-3 py-2.5 border-b" style={{ borderColor: 'var(--border)', background: 'var(--bg-surface)' }}>
                <div className="flex items-center gap-2 min-w-0 flex-1 relative">
                    {renamingTitle ? (
                        <input
                            ref={renameInputRef}
                            value={renameValue}
                            onChange={e => setRenameValue(e.target.value)}
                            onKeyDown={e => {
                                if (e.key === 'Enter') {
                                    e.preventDefault()
                                    if (renameValue.trim() && activeThreadId) {
                                        wsRef.current?.send(JSON.stringify({ type: 'chat:rename', threadId: activeThreadId, title: renameValue.trim() }))
                                    }
                                    setRenamingTitle(false)
                                } else if (e.key === 'Escape') {
                                    setRenamingTitle(false)
                                }
                            }}
                            onBlur={() => {
                                if (renameValue.trim() && activeThreadId) {
                                    wsRef.current?.send(JSON.stringify({ type: 'chat:rename', threadId: activeThreadId, title: renameValue.trim() }))
                                }
                                setRenamingTitle(false)
                            }}
                            className="flex-1 px-2 py-1 text-[11px] font-mono rounded outline-none"
                            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-primary)', minWidth: 0 }}
                        />
                    ) : (
                        <button
                            onClick={() => setDropdownOpen(o => !o)}
                            onDoubleClick={() => {
                                if (activeThreadId) {
                                    setRenameValue(activeTitle)
                                    setRenamingTitle(true)
                                    setTimeout(() => renameInputRef.current?.select(), 30)
                                }
                            }}
                            className="flex items-center gap-1.5 px-2 py-1 rounded hover:bg-white/5 transition-colors min-w-0"
                            title="Double-click to rename"
                        >
                            <span className="text-[11px] font-mono truncate" style={{ color: 'var(--text-primary)' }}>
                                {activeTitle}
                            </span>
                            <span className="text-[9px] opacity-60">▾</span>
                        </button>
                    )}

                    {dropdownOpen && (
                        <>
                            <div className="fixed inset-0 z-40" onClick={() => setDropdownOpen(false)} />
                            <div
                                className="absolute top-full left-0 mt-1 w-64 rounded-xl shadow-2xl z-50 flex flex-col max-h-[60vh]"
                                style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
                            >
                                <div className="p-2 border-b space-y-2" style={{ borderColor: 'var(--border)' }}>
                                    <input 
                                        type="text"
                                        placeholder="Search threads..."
                                        value={threadSearch}
                                        onChange={e => setThreadSearch(e.target.value)}
                                        className="w-full px-2 py-1.5 text-[10px] font-mono rounded bg-white/5 border border-white/5 focus:border-white/10 outline-none"
                                        style={{ color: 'var(--text-primary)' }}
                                        onClick={e => e.stopPropagation()}
                                        onKeyDown={e => { if (e.key === 'f' && (e.metaKey || e.ctrlKey)) { e.stopPropagation(); } }}
                                    />
                                    <button
                                        onClick={newThread}
                                        className="w-full flex items-center justify-center gap-2 px-3 py-1.5 rounded-lg text-xs font-mono transition-colors"
                                        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                                    >
                                        <span className="text-sm leading-none">+</span> New Chat
                                    </button>
                                </div>
                                <div className="overflow-y-auto p-1 flex-1">
                                    {(() => {
                                        const filtered = threads.filter(t => t.title.toLowerCase().includes(threadSearch.toLowerCase()))
                                        if (filtered.length === 0) return <div className="p-4 text-center text-xs font-mono" style={{ color: 'var(--text-dim)' }}>No matches</div>
                                        return filtered.map(t => (
                                            <ThreadItem
                                                key={t.threadId}
                                                meta={t}
                                                active={t.threadId === activeThreadId}
                                                onClick={() => openThread(t.threadId)}
                                                onDelete={() => deleteThread(t.threadId)}
                                            />
                                        ))
                                    })()}
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

            {/* Phase 2: Context Utilization Bar */}
            {activeThreadId && (
                <div className="h-0.5 w-full bg-transparent overflow-hidden">
                    {(() => {
                        const h = getHarness(harness)
                        const used = lastMsgStats?.contextUsed ?? 0
                        const pct = Math.min(100, (used / h.contextWindow) * 100)
                        const color = pct > 80 ? 'var(--accent-red)' : pct > 50 ? 'var(--accent-amber)' : 'var(--accent-green)'
                        return (
                            <div 
                                className="h-full transition-all duration-500 ease-in-out" 
                                style={{ width: `${pct}%`, background: color, opacity: pct > 0 ? 0.6 : 0 }}
                                title={`${used.toLocaleString()} / ${h.contextWindow.toLocaleString()} tokens (${pct.toFixed(1)}%)`}
                            />
                        )
                    })()}
                </div>
            )}

            {/* Phase 2: Harness Info Bar */}
            <div className="px-3 py-1 border-b flex items-center justify-between" style={{ borderColor: 'var(--border)', background: 'rgba(0,0,0,0.1)' }}>
                <div className="flex items-center gap-2 overflow-hidden">
                    {(() => {
                        const h = getHarness(harness)
                        return (
                            <span className="text-[9px] font-mono whitespace-nowrap" style={{ color: 'var(--text-dim)' }}>
                                <span style={{ color: h.color }}>{h.model}</span>
                                <span className="mx-1.5 opacity-30">·</span>
                                <span>{h.contextWindow >= 1048576 ? `${(h.contextWindow / 1048576).toFixed(0)}M` : `${h.contextWindow / 1000}K`} ctx</span>
                                <span className="mx-1.5 opacity-30">·</span>
                                <span>{h.capabilities.join(', ')}</span>
                            </span>
                        )
                    })()}
                </div>
                {sessionInfo?.active && (
                    <div className="flex items-center gap-1.5 px-1.5 py-0.5 rounded bg-green-500/10 border border-green-500/20">
                        <span className="w-1 h-1 rounded-full bg-green-500 animate-pulse" />
                        <span className="text-[8px] font-mono text-green-500/80 uppercase">Session active {sessionInfo.expiresIn && `(${sessionInfo.expiresIn})`}</span>
                    </div>
                )}
            </div>

            {/* In-conversation message search bar */}
            {msgSearchOpen && (
                <div className="flex-shrink-0 flex items-center gap-2 px-3 py-1.5 border-b" style={{ borderColor: 'var(--border)', background: 'var(--bg-elevated)' }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" opacity={0.5}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                    <input
                        ref={msgSearchRef}
                        value={msgSearchQuery}
                        onChange={e => { setMsgSearchQuery(e.target.value); setMsgSearchIdx(0) }}
                        onKeyDown={e => {
                            if (e.key === 'Enter') {
                                e.preventDefault()
                                const next = e.shiftKey ? (msgSearchIdx - 1 + msgSearchMatches.length) % msgSearchMatches.length : (msgSearchIdx + 1) % msgSearchMatches.length
                                setMsgSearchIdx(next)
                                jumpToSearchMatch(next)
                            } else if (e.key === 'Escape') {
                                setMsgSearchOpen(false)
                                setMsgSearchQuery('')
                            }
                        }}
                        placeholder="Search messages..."
                        className="flex-1 bg-transparent outline-none text-[11px] font-mono"
                        style={{ color: 'var(--text-primary)' }}
                    />
                    {msgSearchQuery && (
                        <span className="text-[9px] font-mono" style={{ color: 'var(--text-dim)' }}>
                            {msgSearchMatches.length > 0 ? `${msgSearchIdx + 1}/${msgSearchMatches.length}` : 'No matches'}
                        </span>
                    )}
                    <button
                        onClick={() => { const prev = (msgSearchIdx - 1 + msgSearchMatches.length) % msgSearchMatches.length; setMsgSearchIdx(prev); jumpToSearchMatch(prev) }}
                        disabled={msgSearchMatches.length === 0}
                        className="p-0.5 rounded hover:bg-white/10 disabled:opacity-20 text-[10px]" style={{ color: 'var(--text-dim)' }}
                    >↑</button>
                    <button
                        onClick={() => { const next = (msgSearchIdx + 1) % msgSearchMatches.length; setMsgSearchIdx(next); jumpToSearchMatch(next) }}
                        disabled={msgSearchMatches.length === 0}
                        className="p-0.5 rounded hover:bg-white/10 disabled:opacity-20 text-[10px]" style={{ color: 'var(--text-dim)' }}
                    >↓</button>
                    <button
                        onClick={() => { setMsgSearchOpen(false); setMsgSearchQuery('') }}
                        className="p-0.5 rounded hover:bg-white/10 text-[10px]" style={{ color: 'var(--text-dim)' }}
                    >✕</button>
                </div>
            )}

            {/* Messages View */}
            <div className="relative flex-1 min-h-0 bg-transparent flex flex-col">
                <div
                    ref={messagesContainerRef}
                    className="flex-1 overflow-y-auto pt-4 pb-8 px-2"
                    style={{ background: 'rgba(0,0,0,0.1)' }}
                >
                    {/* Loading skeleton — only shown on initial load / thread switch (no messages yet) */}
                    {isLoadingThread && messages.length === 0 ? (
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
                                <div
                                    key={msgKey(msg, i)}
                                    data-msg-idx={i}
                                    style={msgSearchQuery && msgSearchMatches.includes(i) ? {
                                        background: i === msgSearchMatches[msgSearchIdx] ? 'rgba(255,200,0,0.12)' : 'rgba(255,200,0,0.05)',
                                        borderRadius: 8,
                                        transition: 'background 0.2s',
                                    } : undefined}
                                >
                                    <MessageBubble
                                        msg={msg}
                                        isNew={newMsgIndices.has(i)}
                                        onRetry={msg.role === 'assistant' ? () => retryMessage(i) : undefined}
                                    />
                                </div>
                            ))}
                            {suggestions.length > 0 && !isStreaming && (
                                <div className="flex flex-wrap gap-2 px-12 py-2">
                                    {suggestions.map((s, i) => (
                                        <button 
                                            key={i}
                                            onClick={() => { setInput(s); sendMessage(); setSuggestions([]); }}
                                            className="px-3 py-1.5 rounded-full text-[11px] font-mono border transition-all hover:bg-white/5 active:scale-95"
                                            style={{ borderColor: 'var(--border)', color: 'var(--text-dim)' }}
                                        >
                                            {s}
                                        </button>
                                    ))}
                                </div>
                            )}
                            {streamMsg && (
                                <div>
                                    {showThinking ? (
                                        <div className="flex gap-3 px-4 py-2 items-center">
                                            <div
                                                className="w-6 h-6 rounded-full flex-shrink-0 flex items-center justify-center text-[10px] font-mono font-bold"
                                                style={{ background: `${getHarness(harness).color}22`, color: getHarness(harness).color, border: `1px solid ${getHarness(harness).color}44` }}
                                            >
                                                {getHarness(harness).short.slice(0, 1)}
                                            </div>
                                            <div className="flex items-center gap-1.5">
                                                <span className="text-[11px] font-mono" style={{ color: 'var(--text-dim)' }}>{getHarness(harness).name} is thinking</span>
                                                <span className="flex gap-1 ml-1">
                                                    <span className="thinking-dot" style={{ background: getHarness(harness).color }} />
                                                    <span className="thinking-dot" style={{ background: getHarness(harness).color }} />
                                                    <span className="thinking-dot" style={{ background: getHarness(harness).color }} />
                                                </span>
                                            </div>
                                        </div>
                                    ) : (
                                        <MessageBubble msg={streamMsg} isStreaming />
                                    )}
                                </div>
                            )}
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
                <div className="max-w-3xl mx-auto relative">
                    {/* Command Palette */}
                    {commandQuery !== '' && filteredCommands.length > 0 && (
                        <div className="absolute bottom-full left-0 mb-2 w-64 rounded-xl overflow-hidden shadow-2xl z-[70]" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>
                            <div className="p-1 px-3 py-2 text-[9px] font-mono uppercase opacity-50 border-b" style={{ borderColor: 'var(--border)' }}>Commands</div>
                            {filteredCommands.map((c, i) => (
                                <button 
                                    key={c.id}
                                    onClick={() => { setInput(`/${c.name} `); setCommandQuery(''); }}
                                    className="w-full text-left px-3 py-2 flex flex-col hover:bg-white/5 transition-colors"
                                    style={{ background: i === selectedCommandIdx ? 'var(--bg-surface)' : 'transparent' }}
                                >
                                    <div className="flex items-center justify-between">
                                        <span className="text-xs font-mono font-bold" style={{ color: i === selectedCommandIdx ? 'var(--accent-green)' : 'var(--text-primary)' }}>/{c.name}</span>
                                        {c.server && <span className="text-[8px] opacity-40 uppercase">Server</span>}
                                    </div>
                                    <span className="text-[10px] font-mono opacity-60 truncate">{c.desc}</span>
                                </button>
                            ))}
                        </div>
                    )}

                    <div className="flex flex-col rounded-xl" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>
                        <textarea
                            ref={textareaRef}
                            value={input}
                            onChange={handleInputChange}
                            onKeyDown={handleKeyDown}
                            onPaste={handlePaste}
                            placeholder={wsReady ? 'Message…' : 'Reconnecting…'}
                            disabled={false}
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
                    <input
                        ref={fileInputRef}
                        type="file"
                        className="hidden"
                        onChange={handleFileSelect}
                        accept="image/*,.pdf,.doc,.docx,.txt,.csv,.json,.md,.ts,.js,.py,.sh,.yaml,.yml"
                    />
                            <div className="flex items-center gap-2">
                                <HarnessPicker value={harness} onChange={setHarness} />
                                <button
                                    onClick={() => fileInputRef.current?.click()}
                                    disabled={isUploading}
                                    className="p-1 rounded hover:bg-white/10 text-[10px] font-mono transition-colors"
                                    style={{ color: 'var(--text-dim)' }}
                                    title="Attach file"
                                >
                                    📎
                                </button>
                                {sessionTotals.cost > 0 && (
                                    <div className="text-[9px] font-mono" style={{ color: 'var(--text-dim)' }}>
                                        {sessionTotals.inputTokens + sessionTotals.outputTokens > 0 && (
                                            <span title={`${sessionTotals.inputTokens} in / ${sessionTotals.outputTokens} out`}>
                                                Session: {((sessionTotals.inputTokens + sessionTotals.outputTokens)/1000).toFixed(1)}K tok
                                            </span>
                                        )}
                                        <span className="mx-1.5 opacity-30">·</span>
                                        <span style={{ color: 'var(--accent-green)', opacity: 0.8 }}>${sessionTotals.cost.toFixed(2)}</span>
                                    </div>
                                )}
                                <button
                                    onClick={() => { const next = !soundEnabled; setSoundEnabled(next); localStorage.setItem('hq-chat-sound', next ? 'on' : 'off') }}
                                    className="p-1 rounded hover:bg-white/10 text-[10px] font-mono"
                                    style={{ color: 'var(--text-dim)', opacity: soundEnabled ? 1 : 0.4 }}
                                    title={soundEnabled ? 'Sound on (click to mute)' : 'Sound off (click to enable)'}
                                >
                                    {soundEnabled ? '🔔' : '🔕'}
                                </button>
                                {isUploading && (
                                    <span className="text-[9px] font-mono animate-pulse" style={{ color: 'var(--accent-amber)' }}>Uploading…</span>
                                )}
                            </div>

                            <button
                                onClick={sendMessage}
                                disabled={!wsReady || !input.trim()}
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
