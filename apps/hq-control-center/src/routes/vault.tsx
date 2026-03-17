import { createFileRoute, Outlet, useLocation, Link } from '@tanstack/react-router'
import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { getPinnedNotes, getNoteTree, togglePinNote } from '~/server/notes'
import type { NoteTreeNode, PinnedNote } from '~/server/notes'
import { useHQStore } from '~/store/hqStore'
// ChatPanel is now rendered globally in __root.tsx

export const Route = createFileRoute('/vault')({
    component: VaultLayout,
})

// ─── helpers ────────────────────────────────────────────────────────────────

export function fileIcon(name: string) {
    if (name.endsWith('.md')) return '📄'
    if (name.endsWith('.pdf')) return '📕'
    if (name.match(/\.(png|jpe?g|gif|webp|svg)$/i)) return '🖼'
    if (name.endsWith('.json')) return '{}'
    if (name.match(/\.(ts|tsx|js|jsx)$/)) return '⟨/⟩'
    if (name.match(/\.(sh|yaml|yml)$/)) return '⚙'
    if (name.endsWith('.docx')) return '📝'
    if (name.endsWith('.xlsx') || name.endsWith('.xls')) return '📊'
    if (name.endsWith('.pptx')) return '📽'
    if (name.match(/\.html?$/)) return '🌐'
    return '📄'
}

export function relTime(iso?: string) {
    if (!iso) return ''
    const diff = Date.now() - new Date(iso).getTime()
    const m = Math.floor(diff / 60000)
    if (m < 1) return 'just now'
    if (m < 60) return `${m}m ago`
    const h = Math.floor(m / 60)
    if (h < 24) return `${h}h ago`
    return `${Math.floor(h / 24)}d ago`
}

// ─── Tree node ───────────────────────────────────────────────────────────────

function TreeNode({
    node,
    depth = 0,
    selected,
    expandedPaths,
    onToggle,
    onFileClick,
}: {
    node: NoteTreeNode
    depth?: number
    selected: string | null
    expandedPaths: Set<string>
    onToggle: (path: string, isOpen: boolean) => void
    onFileClick: () => void
}) {
    const isOpen = expandedPaths.has(node.path)

    if (node.type === 'dir') {
        return (
            <div>
                <button
                    onClick={() => onToggle(node.path, !isOpen)}
                    className="w-full text-left py-1.5 px-2.5 text-xs font-mono font-semibold flex items-center gap-1.5 transition-all rounded-lg mx-1"
                    style={{
                        paddingLeft: `${10 + depth * 14}px`,
                        color: 'var(--text-dim)',
                        background: 'transparent',
                    }}
                    onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'rgba(255,255,255,0.03)'
                    }}
                    onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'transparent'
                    }}
                >
                    <span
                        className="text-[9px] transition-transform duration-200 opacity-40"
                        style={{ transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}
                    >
                        ▶
                    </span>
                    <span className="truncate">{node.name}</span>
                    {node.children && (
                        <span className="text-[9px] opacity-30 ml-auto pr-1">{node.children.length}</span>
                    )}
                </button>
                {isOpen && (
                    <div className="relative">
                        {/* Indent guide line */}
                        <div
                            className="absolute top-0 bottom-0 w-px"
                            style={{
                                left: `${16 + depth * 14}px`,
                                background: 'rgba(255,255,255,0.04)',
                            }}
                        />
                        {node.children?.map((c) => (
                            <TreeNode
                                key={c.path}
                                node={c}
                                depth={depth + 1}
                                expandedPaths={expandedPaths}
                                onToggle={onToggle}
                                selected={selected}
                                onFileClick={onFileClick}
                            />
                        ))}
                    </div>
                )}
            </div>
        )
    }

    const isSelected = selected === node.path
    return (
        <Link
            to="/vault/$"
            params={{ _splat: node.path }}
            onClick={onFileClick}
            className="w-full text-left py-1.5 px-2.5 text-xs font-mono flex items-center gap-1.5 transition-all block rounded-lg mx-1"
            style={{
                paddingLeft: `${10 + depth * 14}px`,
                background: isSelected ? 'rgba(255, 179, 0, 0.08)' : 'transparent',
                color: isSelected ? 'var(--accent-amber)' : 'var(--text-dim)',
                borderLeft: isSelected ? '2px solid var(--accent-amber)' : '2px solid transparent',
            }}
            onMouseEnter={(e) => {
                if (!isSelected) e.currentTarget.style.background = 'rgba(255,255,255,0.03)'
            }}
            onMouseLeave={(e) => {
                if (!isSelected) e.currentTarget.style.background = 'transparent'
            }}
        >
            <span className="opacity-50 flex-shrink-0 text-[11px]">{fileIcon(node.name)}</span>
            <span className="truncate">{node.name.replace(/\.md$/, '')}</span>
        </Link>
    )
}

// ─── Pinned card (glass) ────────────────────────────────────────────────────

export function PinnedCard({ note, isSelected, onClick, onUnpin }: { note: PinnedNote; isSelected: boolean; onClick?: () => void; onUnpin?: (path: string) => void }) {
    const folder = note.path.includes('/') ? note.path.split('/').slice(0, -1).join('/') : null

    return (
        <div className="relative group w-full">
            <Link
                to="/vault/$"
                params={{ _splat: note.path }}
                onClick={onClick}
                className="flex flex-col gap-1.5 px-3 py-2.5 rounded-xl transition-all w-full glass-card"
                style={{
                    borderColor: isSelected ? 'rgba(255,179,0,0.25)' : undefined,
                    boxShadow: isSelected ? '0 0 20px rgba(255,179,0,0.08), inset 0 1px 0 var(--glass-shine)' : undefined,
                }}
            >
                {/* Title row */}
                <div className="flex items-start justify-between gap-2">
                    <span
                        className="text-[12px] font-mono font-bold leading-snug flex-1"
                        style={{
                            color: isSelected ? 'var(--accent-amber)' : 'var(--text-primary)',
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden',
                        }}
                    >
                        {note.title}
                    </span>
                    <span className="text-[9px] font-mono shrink-0 mt-0.5" style={{ color: 'var(--text-dim)' }}>
                        {relTime(note.updatedAt)}
                    </span>
                </div>

                {/* Preview text */}
                {note.preview && (
                    <p
                        className="text-[10px] leading-relaxed"
                        style={{
                            color: 'var(--text-dim)',
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden',
                        }}
                    >
                        {note.preview}
                    </p>
                )}

                {/* Footer: folder path + tags */}
                <div className="flex items-center gap-1.5 flex-wrap">
                    {folder && (
                        <span
                            className="text-[9px] font-mono px-1.5 py-0.5 rounded-md"
                            style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--text-dim)' }}
                        >
                            {folder}
                        </span>
                    )}
                    {note.tags?.slice(0, 3).map(tag => (
                        <span
                            key={tag}
                            className="text-[9px] font-mono px-1.5 py-0.5 rounded-md glass-tag"
                            style={{ color: 'var(--accent-green)' }}
                        >
                            #{tag}
                        </span>
                    ))}
                </div>
            </Link>
            {onUnpin && (
                <button
                    onClick={(e) => { e.stopPropagation(); onUnpin(note.path) }}
                    title="Unpin"
                    className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-all w-5 h-5 flex items-center justify-center rounded-full text-[9px] font-bold"
                    style={{
                        background: 'rgba(0,0,0,0.5)',
                        backdropFilter: 'blur(8px)',
                        WebkitBackdropFilter: 'blur(8px)',
                        color: 'var(--text-dim)',
                        border: '1px solid rgba(255,255,255,0.1)',
                    }}
                >
                    ✕
                </button>
            )}
        </div>
    )
}

// ─── Main Layout ─────────────────────────────────────────────────────────────

type Section = 'Notebooks' | '_system' | '_logs'

function VaultLayout() {
    const location = useLocation()

    const isVaultRoot = location.pathname === '/vault' || location.pathname === '/vault/'
    const activePath = isVaultRoot ? null : decodeURIComponent(location.pathname.replace(/^\/vault\//, ''))

    const [tree, setTree] = useState<NoteTreeNode | null>(null)

    const derivedSection = useMemo<Section>(() => {
        if (activePath?.startsWith('_system/')) return '_system'
        if (activePath?.startsWith('_logs/')) return '_logs'
        return 'Notebooks'
    }, [activePath])

    const [section, setSection] = useState<Section>(derivedSection)
    const [treeLoading, setTreeLoading] = useState(true)
    const [query, setQuery] = useState('')
    const [sidebarOpen, setSidebarOpen] = useState(false)
    const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())

    const { pinnedNotes: pinned, setPinnedNotes, pinnedVersion, bumpPinnedVersion } = useHQStore()
    const [pinnedExpanded, setPinnedExpanded] = useState(false)

    const closeSidebar = useCallback(() => {
        setSidebarOpen(false)
    }, [])

    useEffect(() => {
        if (derivedSection !== section && activePath) {
            setSection(derivedSection)
        }
    }, [derivedSection, activePath])

    useEffect(() => {
        getPinnedNotes().then((res) => setPinnedNotes(res.notes))
    }, [pinnedVersion])

    const handleUnpin = useCallback(async (notePath: string) => {
        await togglePinNote({ data: { path: notePath, pinned: false } })
        bumpPinnedVersion()
    }, [bumpPinnedVersion])

    useEffect(() => {
        setTreeLoading(true)
        getNoteTree({ data: section }).then((res) => {
            setTree(res.tree)
            setTreeLoading(false)
        })
    }, [section])

    useEffect(() => {
        if (activePath) {
            const parts = activePath.split('/')
            const newExpanded = new Set(expandedPaths)
            const isSystemOrLogs = parts[0] === '_system' || parts[0] === '_logs'
            newExpanded.add(section)
            let currentPath = section === 'Notebooks' && !isSystemOrLogs ? '' : parts[0] + '/'
            for (let i = (isSystemOrLogs ? 1 : 0); i < parts.length - 1; i++) {
                currentPath += (currentPath && !currentPath.endsWith('/') ? '/' : '') + parts[i]
                newExpanded.add(currentPath)
            }
            setExpandedPaths(newExpanded)
        } else if (tree) {
            setExpandedPaths(new Set([tree.path]))
        }
    }, [activePath, section, tree])

    const toggleNode = useCallback((path: string, isOpen: boolean) => {
        setExpandedPaths(prev => {
            const next = new Set(prev)
            if (isOpen) next.add(path)
            else next.delete(path)
            return next
        })
    }, [])

    const filteredTree = useMemo(() => {
        if (!tree || !query) return tree
        const filter = (node: NoteTreeNode): NoteTreeNode | null => {
            if (node.type === 'file') return node.name.toLowerCase().includes(query.toLowerCase()) ? node : null
            const children = node.children?.map(filter).filter(Boolean) as NoteTreeNode[]
            return children?.length ? { ...node, children } : node.name.toLowerCase().includes(query.toLowerCase()) ? node : null
        }
        return filter(tree)
    }, [tree, query])

    useEffect(() => {
        if (query && filteredTree) {
            const allPaths = new Set<string>()
            const collect = (node: NoteTreeNode) => {
                if (node.type === 'dir') {
                    allPaths.add(node.path)
                    node.children?.forEach(collect)
                }
            }
            collect(filteredTree)
            setExpandedPaths(allPaths)
        }
    }, [query, filteredTree])

    const selectedFilename = activePath?.split('/').pop()

    // ── Sidebar content ─────────────────────────────────────────────────────
    const sidebar = (
        <div className="flex flex-col h-full min-h-0">
            {/* Search — glass input */}
            <div className="px-3 pt-4 pb-3 flex-shrink-0">
                <div className="relative">
                    <span
                        className="absolute left-3 top-1/2 -translate-y-1/2 text-xs pointer-events-none"
                        style={{ color: 'var(--text-dim)', opacity: 0.5 }}
                    >
                        ⌕
                    </span>
                    <input
                        type="text"
                        placeholder="Filter files..."
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        className="w-full text-xs pl-8 pr-3 py-2.5 rounded-xl outline-none glass-input"
                        style={{
                            color: 'var(--text-primary)',
                            fontFamily: 'var(--font-mono)',
                        }}
                    />
                    {query && (
                        <button
                            onClick={() => setQuery('')}
                            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] px-1.5 py-0.5 rounded-md transition-colors"
                            style={{ color: 'var(--text-dim)', background: 'rgba(255,255,255,0.06)' }}
                        >
                            ✕
                        </button>
                    )}
                </div>
            </div>

            {/* Pinned notes — collapsible, max 2 shown by default */}
            {pinned.length > 0 && !query && (
                <div className="flex-shrink-0 pb-1 px-3">
                    <button
                        onClick={() => setPinnedExpanded(!pinnedExpanded)}
                        className="flex items-center gap-2 mb-1.5 w-full text-left group"
                    >
                        <span
                            className="text-[8px] transition-transform duration-200"
                            style={{
                                color: 'var(--accent-amber)',
                                transform: pinnedExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                            }}
                        >
                            ▶
                        </span>
                        <span className="text-[9px] font-mono tracking-widest uppercase font-bold" style={{ color: 'var(--accent-amber)' }}>
                            Pinned
                        </span>
                        <div className="flex-1 h-px" style={{ background: 'rgba(255,179,0,0.1)' }} />
                        <span className="text-[9px] font-mono" style={{ color: 'var(--text-dim)', opacity: 0.5 }}>{pinned.length}</span>
                    </button>
                    {pinnedExpanded && (
                        <div className="flex flex-col gap-1.5 max-h-[30vh] overflow-y-auto pb-1">
                            {pinned.map((n, i) => (
                                <div key={n.path} className="stagger-item" style={{ animationDelay: `${i * 50}ms` }}>
                                    <PinnedCard note={n} isSelected={activePath === n.path} onClick={closeSidebar} onUnpin={handleUnpin} />
                                </div>
                            ))}
                        </div>
                    )}
                    {/* Compact pinned list when collapsed — just titles */}
                    {!pinnedExpanded && (
                        <div className="flex flex-col gap-0.5">
                            {pinned.slice(0, 3).map((n) => (
                                <Link
                                    key={n.path}
                                    to="/vault/$"
                                    params={{ _splat: n.path }}
                                    onClick={closeSidebar}
                                    className="text-[11px] font-mono truncate py-1 px-2 rounded-lg transition-all block"
                                    style={{
                                        color: activePath === n.path ? 'var(--accent-amber)' : 'var(--text-dim)',
                                        background: activePath === n.path ? 'rgba(255,179,0,0.08)' : 'transparent',
                                    }}
                                    onMouseEnter={(e) => { if (activePath !== n.path) e.currentTarget.style.background = 'rgba(255,255,255,0.03)' }}
                                    onMouseLeave={(e) => { if (activePath !== n.path) e.currentTarget.style.background = 'transparent' }}
                                >
                                    {n.title}
                                </Link>
                            ))}
                            {pinned.length > 3 && (
                                <button
                                    onClick={() => setPinnedExpanded(true)}
                                    className="text-[9px] font-mono py-0.5 px-2 text-left transition-colors"
                                    style={{ color: 'var(--text-dim)', opacity: 0.5 }}
                                >
                                    +{pinned.length - 3} more
                                </button>
                            )}
                        </div>
                    )}
                </div>
            )}

            {/* Section tabs — glass pill switcher */}
            <div className="flex-shrink-0 px-3 py-2">
                <div
                    className="flex rounded-xl p-0.5"
                    style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.04)' }}
                >
                    {(['Notebooks', '_system', '_logs'] as Section[]).map((s) => (
                        <button
                            key={s}
                            onClick={() => setSection(s)}
                            className="flex-1 py-1.5 text-[9px] tracking-wider uppercase font-mono font-bold transition-all rounded-lg"
                            style={{
                                color: section === s ? 'var(--accent-amber)' : 'var(--text-dim)',
                                background: section === s ? 'rgba(255,179,0,0.08)' : 'transparent',
                                boxShadow: section === s ? '0 0 12px rgba(255,179,0,0.05)' : 'none',
                            }}
                        >
                            {s.replace('_', '')}
                        </button>
                    ))}
                </div>
            </div>

            {/* Tree */}
            <div className="flex-1 overflow-y-auto py-1 px-1">
                {treeLoading ? (
                    <div className="text-center py-8">
                        <div className="inline-flex gap-1">
                            {[0, 1, 2].map((i) => (
                                <div
                                    key={i}
                                    className="thinking-dot"
                                    style={{
                                        background: 'var(--accent-green)',
                                        animationDelay: `${i * 0.15}s`,
                                    }}
                                />
                            ))}
                        </div>
                    </div>
                ) : filteredTree ? (
                    <TreeNode node={filteredTree} expandedPaths={expandedPaths} onToggle={toggleNode} selected={activePath} onFileClick={closeSidebar} />
                ) : (
                    <div className="text-center py-8 text-xs font-mono" style={{ color: 'var(--text-dim)' }}>
                        No files found
                    </div>
                )}
            </div>

            {/* Sidebar footer — subtle branding */}
            <div
                className="flex-shrink-0 px-4 py-2.5 text-[9px] font-mono flex items-center justify-between"
                style={{
                    borderTop: '1px solid rgba(255,255,255,0.04)',
                    color: 'var(--text-dim)',
                    opacity: 0.5,
                }}
            >
                <span>Vault Explorer</span>
                <span>{tree ? countFiles(tree) : '...'} files</span>
            </div>
        </div>
    )

    return (
        <div className="h-full flex flex-col overflow-hidden">
            {/* Mobile top bar — glass */}
            <div
                className="md:hidden flex-shrink-0 flex items-center gap-3 px-3 py-2.5 glass-light relative"
                style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}
            >
                <button
                    onClick={() => setSidebarOpen(true)}
                    className="p-2 rounded-lg text-xs font-mono flex-shrink-0 transition-all active:scale-95"
                    style={{
                        background: 'rgba(255,255,255,0.05)',
                        color: 'var(--text-dim)',
                        border: '1px solid rgba(255,255,255,0.08)',
                    }}
                >
                    <span className="flex flex-col gap-[3px] w-3.5">
                        <span className="block h-[1.5px] rounded-full" style={{ background: 'var(--text-dim)' }} />
                        <span className="block h-[1.5px] rounded-full w-[70%]" style={{ background: 'var(--text-dim)' }} />
                        <span className="block h-[1.5px] rounded-full" style={{ background: 'var(--text-dim)' }} />
                    </span>
                </button>
                <div className="flex-1 min-w-0">
                    <span
                        className="text-xs font-mono font-bold truncate block"
                        style={{ color: selectedFilename ? 'var(--text-primary)' : 'var(--text-dim)' }}
                    >
                        {selectedFilename?.replace(/\.md$/, '') ?? 'Vault'}
                    </span>
                    {activePath && (
                        <span className="text-[9px] font-mono truncate block" style={{ color: 'var(--text-dim)', opacity: 0.5 }}>
                            {activePath.split('/').slice(0, -1).join('/')}
                        </span>
                    )}
                </div>
                {/* Mobile search trigger */}
                <button
                    onClick={() => setSidebarOpen(true)}
                    className="p-2 rounded-lg text-xs font-mono flex-shrink-0 transition-all active:scale-95"
                    style={{
                        background: 'rgba(255,255,255,0.05)',
                        color: 'var(--text-dim)',
                        border: '1px solid rgba(255,255,255,0.08)',
                    }}
                >
                    ⌕
                </button>
            </div>

            <div className="flex-1 flex min-h-0 relative">
                {/* Mobile overlay — frosted backdrop */}
                {sidebarOpen && (
                    <div
                        className="md:hidden fixed inset-0 z-40 sidebar-overlay-animate"
                        style={{
                            background: 'rgba(0, 0, 0, 0.5)',
                            backdropFilter: 'blur(4px)',
                            WebkitBackdropFilter: 'blur(4px)',
                        }}
                        onClick={() => setSidebarOpen(false)}
                    />
                )}

                {/* Sidebar — glass panel */}
                <aside
                    className={`
                        fixed md:relative top-0 left-0 z-50
                        w-[280px] md:w-72 flex-shrink-0
                        transition-transform duration-300
                        vault-sidebar
                        ${sidebarOpen ? 'translate-x-0 sidebar-animate-in' : '-translate-x-full md:translate-x-0'}
                    `}
                    style={{
                        background: 'var(--bg-solid-surface)',
                        borderRight: '1px solid rgba(255,255,255,0.06)',
                    }}
                >
                    {/* Desktop: glass effect via backdrop-filter */}
                    <div className="hidden md:block absolute inset-0 glass-heavy rounded-none pointer-events-none" style={{ border: 'none' }} />

                    {/* Full-height flex container — header + sidebar content */}
                    <div className="flex flex-col h-full overflow-hidden">
                        {/* Mobile drawer header */}
                        <div
                            className="md:hidden flex items-center justify-between px-4 py-3 flex-shrink-0 relative"
                            style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}
                        >
                            <div className="flex items-center gap-2">
                                <div
                                    className="w-2 h-2 rounded-full"
                                    style={{ background: 'var(--accent-green)', boxShadow: '0 0 8px rgba(0,255,136,0.4)' }}
                                />
                                <span className="text-xs font-mono font-bold tracking-wider uppercase" style={{ color: 'var(--text-primary)' }}>
                                    Vault Explorer
                                </span>
                            </div>
                            <button
                                onClick={() => setSidebarOpen(false)}
                                className="p-1.5 rounded-lg text-xs font-mono transition-all active:scale-95"
                                style={{
                                    color: 'var(--text-dim)',
                                    background: 'rgba(255,255,255,0.05)',
                                    border: '1px solid rgba(255,255,255,0.08)',
                                }}
                            >
                                ✕
                            </button>
                        </div>

                        {/* Sidebar content — fills remaining space */}
                        {sidebar}
                    </div>
                </aside>

                {/* Content Outlet */}
                <main
                    className="flex-1 overflow-y-auto overflow-x-hidden min-w-0 flex flex-col relative"
                    style={{ background: 'transparent' }}
                >
                    <Outlet />
                </main>
            </div>
        </div>
    )
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function countFiles(node: NoteTreeNode): number {
    if (node.type === 'file') return 1
    return node.children?.reduce((acc, c) => acc + countFiles(c), 0) ?? 0
}
