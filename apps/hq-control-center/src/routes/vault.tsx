import { createFileRoute, Outlet, useLocation, Link } from '@tanstack/react-router'
import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { getPinnedNotes, getNoteTree } from '~/server/notes'
import type { NoteTreeNode, PinnedNote } from '~/server/notes'
import { useHQStore } from '~/store/hqStore'
import { ChatPanel } from '~/components/ChatPanel'

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
                    className="w-full text-left py-1 px-2 text-xs font-mono font-semibold flex items-center gap-1 hover:bg-white/5 transition-colors"
                    style={{ paddingLeft: `${8 + depth * 12}px`, color: 'var(--text-dim)' }}
                >
                    <span className="opacity-60">{isOpen ? '▾' : '▸'}</span>
                    <span className="truncate">{node.name}</span>
                </button>
                {isOpen && node.children?.map((c) => (
                    <TreeNode key={c.path} node={c} depth={depth + 1} expandedPaths={expandedPaths} onToggle={onToggle} selected={selected} onFileClick={onFileClick} />
                ))}
            </div>
        )
    }
    const isSelected = selected === node.path
    return (
        <Link
            to="/vault/$"
            params={{ _splat: node.path }}
            onClick={onFileClick}
            className="w-full text-left py-1 px-2 text-xs font-mono flex items-center gap-1.5 transition-colors block"
            style={{
                paddingLeft: `${8 + depth * 12}px`,
                background: isSelected ? 'rgba(255,255,255,0.07)' : 'transparent',
                color: isSelected ? 'var(--text-primary)' : 'var(--text-dim)',
                borderLeft: isSelected ? '2px solid var(--accent-amber)' : '2px solid transparent',
            }}
        >
            <span className="opacity-60 flex-shrink-0">{fileIcon(node.name)}</span>
            <span className="truncate">{node.name}</span>
        </Link>
    )
}

// ─── Pinned card ─────────────────────────────────────────────────────────────

export function PinnedCard({ note, isSelected, onClick }: { note: PinnedNote; isSelected: boolean; onClick?: () => void }) {
    return (
        <Link
            to="/vault/$"
            params={{ _splat: note.path }}
            onClick={onClick}
            className="w-full text-left px-3 py-2.5 rounded-lg transition-colors flex flex-col gap-1 block"
            style={{
                background: isSelected ? 'rgba(255,179,0,0.1)' : 'var(--bg-elevated)',
                border: `1px solid ${isSelected ? 'rgba(255,179,0,0.3)' : 'var(--border)'}`,
            }}
        >
            <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-mono font-bold truncate" style={{ color: isSelected ? 'var(--accent-amber)' : 'var(--text-primary)' }}>
                    {note.title}
                </span>
                <span className="text-[9px] flex-shrink-0 font-mono" style={{ color: 'var(--text-dim)' }}>
                    {relTime(note.updatedAt)}
                </span>
            </div>
            {note.preview && (
                <p className="text-[10px] font-mono line-clamp-2 leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                    {note.preview}
                </p>
            )}
            {note.tags.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-0.5">
                    {note.tags.slice(0, 3).map((t) => (
                        <span key={t} className="text-[9px] px-1 py-0.5 rounded font-mono" style={{ background: 'rgba(255,179,0,0.1)', color: 'var(--accent-amber)' }}>
                            #{t}
                        </span>
                    ))}
                </div>
            )}
        </Link>
    )
}

// ─── Main Layout ─────────────────────────────────────────────────────────────

type Section = 'Notebooks' | '_system' | '_logs'

function VaultLayout() {
    const location = useLocation()

    // Extract path from URL to determine active file
    const isVaultRoot = location.pathname === '/vault' || location.pathname === '/vault/'
    const activePath = isVaultRoot ? null : decodeURIComponent(location.pathname.replace(/^\/vault\//, ''))

    const [pinned, setPinned] = useState<PinnedNote[]>([])
    const [tree, setTree] = useState<NoteTreeNode | null>(null)

    // Auto-derive section from activePath
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

    const { chatPanelOpen, setChatPanelOpen } = useHQStore()

    // Close sidebar on navigation (mobile)
    const closeSidebar = useCallback(() => {
        setSidebarOpen(false)
    }, [])

    // Update section if URL changes
    useEffect(() => {
        if (derivedSection !== section && activePath) {
            setSection(derivedSection)
        }
    }, [derivedSection, activePath])

    // Load pinned notes once
    useEffect(() => {
        getPinnedNotes().then((res) => setPinned(res.notes))
    }, [])

    // Load tree when section changes
    useEffect(() => {
        setTreeLoading(true)
        getNoteTree({ data: section }).then((res) => {
            setTree(res.tree)
            setTreeLoading(false)
        })
    }, [section])

    // Auto-expand paths when activePath changes
    useEffect(() => {
        if (activePath) {
            const parts = activePath.split('/')
            const newExpanded = new Set(expandedPaths)

            const isSystemOrLogs = parts[0] === '_system' || parts[0] === '_logs'

            newExpanded.add(section) // add root
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

    // Client-side tree filter
    const filteredTree = useMemo(() => {
        if (!tree || !query) return tree
        const filter = (node: NoteTreeNode): NoteTreeNode | null => {
            if (node.type === 'file') return node.name.toLowerCase().includes(query.toLowerCase()) ? node : null
            const children = node.children?.map(filter).filter(Boolean) as NoteTreeNode[]
            return children?.length ? { ...node, children } : node.name.toLowerCase().includes(query.toLowerCase()) ? node : null
        }
        return filter(tree)
    }, [tree, query])

    // Force expand all when filtering
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
            {/* Search */}
            <div className="px-3 pt-3 pb-2 flex-shrink-0">
                <input
                    type="text"
                    placeholder="Filter files..."
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    className="w-full text-xs px-3 py-2 rounded-lg outline-none"
                    style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}
                />
            </div>

            {/* Pinned notes — collapsible */}
            {pinned.length > 0 && !query && (
                <div className="flex-shrink-0 px-3 pb-3">
                    <div className="text-[9px] font-mono tracking-widest uppercase mb-2 flex items-center justify-between" style={{ color: 'var(--accent-amber)' }}>
                        <span className="flex items-center gap-1.5"><span>📌</span> Pinned</span>
                    </div>
                    <div className="flex flex-col gap-1.5">
                        {pinned.map((n) => (
                            <PinnedCard key={n.path} note={n} isSelected={activePath === n.path} onClick={closeSidebar} />
                        ))}
                    </div>
                </div>
            )}

            {/* Divider + section tabs */}
            <div className="flex-shrink-0 border-t" style={{ borderColor: 'var(--border)' }}>
                <div className="flex">
                    {(['Notebooks', '_system', '_logs'] as Section[]).map((s) => (
                        <button
                            key={s}
                            onClick={() => setSection(s)}
                            className="flex-1 py-2 text-[9px] tracking-wider uppercase font-mono font-bold transition-colors"
                            style={{
                                color: section === s ? 'var(--accent-amber)' : 'var(--text-dim)',
                                borderBottom: section === s ? '2px solid var(--accent-amber)' : '2px solid transparent',
                                background: section === s ? 'rgba(255,179,0,0.04)' : 'transparent',
                            }}
                        >
                            {s.replace('_', '')}
                        </button>
                    ))}
                </div>
            </div>

            {/* Tree */}
            <div className="flex-1 overflow-y-auto py-1">
                {treeLoading ? (
                    <div className="text-center py-6 text-xs font-mono animate-pulse" style={{ color: 'var(--text-dim)' }}>Loading...</div>
                ) : filteredTree ? (
                    <TreeNode node={filteredTree} expandedPaths={expandedPaths} onToggle={toggleNode} selected={activePath} onFileClick={closeSidebar} />
                ) : (
                    <div className="text-center py-6 text-xs font-mono" style={{ color: 'var(--text-dim)' }}>No files found</div>
                )}
            </div>
        </div>
    )

    return (
        <div className="h-full flex flex-col overflow-hidden">
            {/* Mobile top bar */}
            <div
                className="md:hidden flex-shrink-0 flex items-center gap-2 px-3 py-2 border-b"
                style={{ background: 'var(--bg-surface)', borderColor: 'var(--border)' }}
            >
                <button
                    onClick={() => setSidebarOpen(true)}
                    className="p-1.5 rounded text-xs font-mono flex-shrink-0"
                    style={{ background: 'var(--bg-elevated)', color: 'var(--text-dim)', border: '1px solid var(--border)' }}
                >
                    ☰
                </button>
                <span className="text-xs font-mono truncate flex-1" style={{ color: 'var(--text-dim)', opacity: selectedFilename ? 1 : 0.4 }}>
                    {selectedFilename ?? 'Vault Home'}
                </span>
                <button
                    onClick={() => setChatPanelOpen(!chatPanelOpen)}
                    className="p-1.5 rounded text-xs font-mono flex-shrink-0"
                    style={{ background: chatPanelOpen ? 'var(--accent-blue)' : 'var(--bg-elevated)', color: chatPanelOpen ? '#000' : 'var(--text-dim)', border: '1px solid var(--border)' }}
                >
                    💬
                </button>
            </div>

            <div className="flex-1 flex min-h-0 relative">
                {/* Mobile overlay */}
                {sidebarOpen && (
                    <div className="md:hidden fixed inset-0 z-40 bg-black/60" onClick={() => setSidebarOpen(false)} />
                )}

                {/* Sidebar */}
                <aside
                    className={`
                        fixed md:relative inset-y-0 left-0 z-50
                        w-72 flex-shrink-0 border-r
                        transition-transform duration-200
                        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
                    `}
                    style={{ background: 'var(--bg-surface)', borderColor: 'var(--border)' }}
                >
                    {/* Mobile close */}
                    <div className="md:hidden flex justify-end p-2 border-b flex-shrink-0" style={{ borderColor: 'var(--border)' }}>
                        <button onClick={() => setSidebarOpen(false)} className="text-xs font-mono px-2 py-1 rounded" style={{ color: 'var(--text-dim)', background: 'var(--bg-elevated)' }}>
                            ✕ Close
                        </button>
                    </div>
                    {sidebar}
                </aside>

                {/* Content Outlet */}
                <main
                    className="flex-1 overflow-y-auto overflow-x-hidden min-w-0 flex flex-col relative"
                    style={{ background: 'var(--bg-base)' }}
                >
                    <Outlet />

                    {/* FAB when chat panel is closed */}
                    {!chatPanelOpen && (
                        <button
                            onClick={() => setChatPanelOpen(true)}
                            className="fixed bottom-6 right-6 w-12 h-12 rounded-full flex items-center justify-center shadow-2xl transition-transform hover:scale-105 z-40 md:absolute"
                            style={{ background: 'var(--accent-blue)', color: '#000' }}
                        >
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
                        </button>
                    )}
                </main>

                {/* Chat Panel — slides in from right */}
                {chatPanelOpen && (
                    <aside
                        className="fixed md:relative inset-y-0 right-0 z-50 w-full md:w-[380px] lg:w-[400px] flex-shrink-0 border-l"
                        style={{ background: 'var(--bg-surface)', borderColor: 'var(--border)' }}
                    >
                        <ChatPanel onClose={() => setChatPanelOpen(false)} />
                    </aside>
                )}
            </div>
        </div>
    )
}
