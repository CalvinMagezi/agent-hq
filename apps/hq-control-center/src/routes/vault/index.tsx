import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useState, useEffect, useRef, useCallback } from 'react'
import { getRecentFiles, getPinnedNotes } from '~/server/notes'
import type { RecentFile, PinnedNote } from '~/server/notes'
import { useHQStore } from '~/store/hqStore'
import { fileIcon, relTime, PinnedCard } from '../vault'

export const Route = createFileRoute('/vault/')({
    component: VaultHome,
    loader: async () => {
        const [recentResult, pinnedResult] = await Promise.all([
            getRecentFiles(),
            getPinnedNotes(),
        ])
        return {
            recentFiles: recentResult.files,
            pinnedNotes: pinnedResult.notes,
        }
    },
})

// ─── Inline search ──────────────────────────────────────────────────────────

interface SearchHit {
    notePath: string
    title: string
    notebook: string
    snippet: string
    tags: string[]
    relevance: number
    matchType: string
}

function InlineSearch() {
    const [query, setQuery] = useState('')
    const [results, setResults] = useState<SearchHit[]>([])
    const [isLoading, setIsLoading] = useState(false)
    const [selectedIndex, setSelectedIndex] = useState(0)
    const inputRef = useRef<HTMLInputElement>(null)
    const abortRef = useRef<AbortController | null>(null)
    const navigate = useNavigate()
    const wsConnected = useHQStore((s) => s.wsConnected)

    const openResult = useCallback((hit: SearchHit) => {
        setQuery('')
        setResults([])
        navigate({ to: '/vault/$', params: { _splat: hit.notePath } })
    }, [navigate])

    // Keyboard navigation
    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault()
            setSelectedIndex((i) => (i + 1) % Math.max(results.length, 1))
        } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setSelectedIndex((i) => (i - 1 + results.length) % Math.max(results.length, 1))
        } else if (e.key === 'Enter' && results[selectedIndex]) {
            e.preventDefault()
            openResult(results[selectedIndex])
        } else if (e.key === 'Escape') {
            setQuery('')
            setResults([])
            inputRef.current?.blur()
        }
    }, [results, selectedIndex, openResult])

    // Search with debounce
    useEffect(() => {
        const q = query.trim()
        if (!q) { setResults([]); return }

        abortRef.current?.abort()
        const controller = new AbortController()
        abortRef.current = controller
        setIsLoading(true)
        setSelectedIndex(0)

        const timer = setTimeout(async () => {
            // Try FTS via ws-server first
            if (wsConnected) {
                try {
                    const res = await fetch(
                        `${window.location.origin}/search?q=${encodeURIComponent(q)}`,
                        { signal: controller.signal }
                    )
                    if (res.ok) {
                        const data = await res.json()
                        if (!controller.signal.aborted) {
                            setResults(data.results ?? [])
                            setIsLoading(false)
                            return
                        }
                    }
                } catch (e: any) {
                    if (e.name === 'AbortError') return
                }
            }

            // Fallback would go here but FTS covers most cases
            if (!controller.signal.aborted) {
                setIsLoading(false)
            }
        }, 200)

        return () => { clearTimeout(timer); controller.abort() }
    }, [query, wsConnected])

    return (
        <div className="relative w-full">
            <div
                className="flex items-center gap-3 px-4 py-3 rounded-xl transition-all"
                style={{
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border)',
                    boxShadow: query ? '0 0 0 1px var(--accent-green), 0 4px 20px rgba(0,255,136,0.06)' : 'none',
                }}
            >
                <span className="text-base flex-shrink-0" style={{ color: 'var(--text-dim)' }}>⌕</span>
                <input
                    ref={inputRef}
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Search vault..."
                    className="flex-1 bg-transparent outline-none text-sm font-mono"
                    style={{ color: 'var(--text-primary)' }}
                />
                {isLoading && (
                    <div className="w-4 h-4 rounded-full border-2 border-t-transparent animate-spin flex-shrink-0" style={{ borderColor: 'var(--accent-amber)', borderTopColor: 'transparent' }} />
                )}
                <kbd className="hidden sm:inline text-[10px] px-1.5 py-0.5 rounded font-mono flex-shrink-0" style={{ background: 'var(--bg-base)', border: '1px solid var(--border)', color: 'var(--text-dim)' }}>
                    ⌘K
                </kbd>
            </div>

            {/* Inline results dropdown */}
            {query && results.length > 0 && (
                <div
                    className="absolute z-40 top-full left-0 right-0 mt-2 rounded-xl overflow-hidden shadow-2xl max-h-[50vh] overflow-y-auto"
                    style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
                >
                    {results.map((hit, idx) => (
                        <button
                            key={hit.notePath}
                            onClick={() => openResult(hit)}
                            className="w-full text-left px-4 py-3 flex flex-col gap-1 border-b transition-colors"
                            style={{
                                borderColor: 'var(--border)',
                                background: idx === selectedIndex ? 'rgba(255,255,255,0.05)' : 'transparent',
                                borderLeft: idx === selectedIndex ? '2px solid var(--accent-amber)' : '2px solid transparent',
                            }}
                        >
                            <div className="flex items-center justify-between gap-3">
                                <span className="text-sm font-mono font-bold truncate" style={{ color: 'var(--text-primary)' }}>
                                    {hit.title}
                                </span>
                                <span className="text-[10px] font-mono flex-shrink-0" style={{ color: 'var(--text-dim)' }}>
                                    {hit.notebook}
                                </span>
                            </div>
                            {hit.snippet && (
                                <p className="text-xs font-mono line-clamp-2 leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                                    {hit.snippet}
                                </p>
                            )}
                            {hit.tags.length > 0 && (
                                <div className="flex gap-1">
                                    {hit.tags.slice(0, 4).map((t) => (
                                        <span key={t} className="text-[9px] px-1.5 py-0.5 rounded font-mono" style={{ background: 'var(--bg-elevated)', color: 'var(--text-dim)' }}>
                                            #{t}
                                        </span>
                                    ))}
                                </div>
                            )}
                        </button>
                    ))}
                    <div className="px-4 py-2 flex items-center justify-between text-[10px] font-mono" style={{ color: 'var(--text-dim)' }}>
                        <span>{results.length} results</span>
                        <div className="flex items-center gap-3">
                            <span><kbd className="px-1 rounded" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>↑↓</kbd> navigate</span>
                            <span><kbd className="px-1 rounded" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>↵</kbd> open</span>
                        </div>
                    </div>
                </div>
            )}

            {query && !isLoading && results.length === 0 && (
                <div
                    className="absolute z-40 top-full left-0 right-0 mt-2 rounded-xl overflow-hidden shadow-2xl"
                    style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
                >
                    <div className="px-6 py-8 text-center text-sm font-mono" style={{ color: 'var(--text-dim)' }}>
                        No results for "{query}"
                    </div>
                </div>
            )}
        </div>
    )
}

// ─── Recent file card ───────────────────────────────────────────────────────

function RecentFileCard({ file }: { file: RecentFile }) {
    const folder = file.path.split('/').slice(0, -1).join('/')

    return (
        <Link
            to="/vault/$"
            params={{ _splat: file.path }}
            className="block hq-panel p-3.5 transition-all hover:border-amber-500/30 group"
            style={{ borderColor: 'var(--border)' }}
        >
            <div className="flex items-start justify-between gap-2 mb-1.5">
                <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm flex-shrink-0 opacity-60">{fileIcon(file.path)}</span>
                    <span className="text-[12px] font-mono font-bold truncate group-hover:text-amber-400 transition-colors" style={{ color: 'var(--text-primary)' }}>
                        {file.title}
                    </span>
                </div>
                <span className="text-[9px] font-mono flex-shrink-0 mt-0.5" style={{ color: 'var(--text-dim)' }}>
                    {relTime(file.mtime)}
                </span>
            </div>

            <div className="text-[9px] font-mono mb-1.5 truncate" style={{ color: 'var(--text-dim)', opacity: 0.6 }}>
                {folder}
            </div>

            {file.preview && (
                <p className="text-[11px] font-mono line-clamp-2 leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                    {file.preview}
                </p>
            )}

            {file.tags.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                    {file.tags.slice(0, 3).map((t) => (
                        <span key={t} className="text-[8px] px-1.5 py-0.5 rounded font-mono" style={{ background: 'rgba(255,179,0,0.08)', color: 'var(--accent-amber)' }}>
                            #{t}
                        </span>
                    ))}
                </div>
            )}
        </Link>
    )
}

// ─── Main VaultHome ─────────────────────────────────────────────────────────

function VaultHome() {
    const { recentFiles, pinnedNotes } = Route.useLoaderData()

    return (
        <div className="h-full overflow-y-auto">
            <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
                {/* Header */}
                <div className="text-center mb-8">
                    <h2 className="text-lg font-bold tracking-[0.25em] uppercase mb-1" style={{ color: 'var(--text-primary)' }}>
                        Vault
                    </h2>
                    <p className="text-xs font-mono" style={{ color: 'var(--text-dim)' }}>
                        Search, browse, and explore your knowledge base
                    </p>
                </div>

                {/* Search */}
                <div className="mb-10">
                    <InlineSearch />
                </div>

                {/* Pinned Notes */}
                {pinnedNotes.length > 0 && (
                    <section className="mb-10">
                        <div className="flex items-center gap-2 mb-4">
                            <span className="text-[10px] font-mono tracking-widest uppercase font-bold" style={{ color: 'var(--accent-amber)' }}>
                                📌 Pinned
                            </span>
                            <div className="flex-1 h-px" style={{ background: 'var(--border)' }} />
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            {pinnedNotes.map((note) => (
                                <PinnedCard key={note.path} note={note} isSelected={false} />
                            ))}
                        </div>
                    </section>
                )}

                {/* Recent Files */}
                {recentFiles.length > 0 && (
                    <section className="mb-10">
                        <div className="flex items-center gap-2 mb-4">
                            <span className="text-[10px] font-mono tracking-widest uppercase font-bold" style={{ color: 'var(--accent-green)' }}>
                                Recently Modified
                            </span>
                            <div className="flex-1 h-px" style={{ background: 'var(--border)' }} />
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                            {recentFiles.map((file) => (
                                <RecentFileCard key={file.path} file={file} />
                            ))}
                        </div>
                    </section>
                )}

                {/* Footer hint */}
                <div className="text-center pt-4 pb-8">
                    <p className="text-[10px] font-mono" style={{ color: 'var(--text-dim)', opacity: 0.5 }}>
                        Press <kbd className="px-1.5 py-0.5 rounded mx-0.5" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>⌘K</kbd> for global search anywhere
                    </p>
                </div>
            </div>
        </div>
    )
}
