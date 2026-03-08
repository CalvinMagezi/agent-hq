import { createFileRoute } from '@tanstack/react-router'
import React, { useState, useEffect, useCallback } from 'react'
import { getPinnedNotes, getNoteTree, getNote } from '~/server/notes'
import type { NoteTreeNode, PinnedNote } from '~/server/notes'
import { MarkdownViewer } from '~/components/MarkdownViewer'
import { PdfViewer } from '~/components/PdfViewer'
import { ImageViewer } from '~/components/ImageViewer'
import { CodeViewer } from '~/components/CodeViewer'

export const Route = createFileRoute('/')({
  validateSearch: (s: Record<string, unknown>) => ({
    file: typeof s.file === 'string' ? s.file : undefined,
  }),
  component: VaultBrowser,
})

// ─── helpers ────────────────────────────────────────────────────────────────

function fileIcon(name: string) {
  if (name.endsWith('.md')) return '📄'
  if (name.endsWith('.pdf')) return '📕'
  if (name.match(/\.(png|jpe?g|gif|webp|svg)$/i)) return '🖼'
  if (name.endsWith('.json')) return '{}'
  if (name.match(/\.(ts|tsx|js|jsx)$/)) return '⟨/⟩'
  if (name.match(/\.(sh|yaml|yml)$/)) return '⚙'
  return '📄'
}

function relTime(iso?: string) {
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
  onSelect,
  selected,
}: {
  node: NoteTreeNode
  depth?: number
  onSelect: (p: string) => void
  selected: string | null
}) {
  const [open, setOpen] = useState(depth === 0)
  if (node.type === 'dir') {
    return (
      <div>
        <button
          onClick={() => setOpen((v) => !v)}
          className="w-full text-left py-1 px-2 text-xs font-mono font-semibold flex items-center gap-1 hover:bg-white/5 transition-colors"
          style={{ paddingLeft: `${8 + depth * 12}px`, color: 'var(--text-dim)' }}
        >
          <span className="opacity-60">{open ? '▾' : '▸'}</span>
          <span className="truncate">{node.name}</span>
        </button>
        {open && node.children?.map((c) => (
          <TreeNode key={c.path} node={c} depth={depth + 1} onSelect={onSelect} selected={selected} />
        ))}
      </div>
    )
  }
  const isSelected = selected === node.path
  return (
    <button
      onClick={() => onSelect(node.path)}
      className="w-full text-left py-1 px-2 text-xs font-mono flex items-center gap-1.5 transition-colors"
      style={{
        paddingLeft: `${8 + depth * 12}px`,
        background: isSelected ? 'rgba(255,255,255,0.07)' : 'transparent',
        color: isSelected ? 'var(--text-primary)' : 'var(--text-dim)',
        borderLeft: isSelected ? '2px solid var(--accent-amber)' : '2px solid transparent',
      }}
    >
      <span className="opacity-60 flex-shrink-0">{fileIcon(node.name)}</span>
      <span className="truncate">{node.name}</span>
    </button>
  )
}

// ─── Pinned card ─────────────────────────────────────────────────────────────

function PinnedCard({ note, onSelect, isSelected }: { note: PinnedNote; onSelect: (p: string) => void; isSelected: boolean }) {
  return (
    <button
      onClick={() => onSelect(note.path)}
      className="w-full text-left px-3 py-2.5 rounded-lg transition-colors flex flex-col gap-1"
      style={{
        background: isSelected ? 'rgba(255,179,0,0.1)' : 'var(--bg-elevated)',
        border: `1px solid ${isSelected ? 'rgba(255,179,0,0.3)' : 'var(--border)'}`,
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-mono font-bold truncate" style={{ color: isSelected ? 'var(--accent-amber)' : 'var(--text-primary)' }}>
          {note.title}
        </span>
        <span className="text-[10px] flex-shrink-0 font-mono" style={{ color: 'var(--text-dim)' }}>
          {relTime(note.updatedAt)}
        </span>
      </div>
      {note.preview && (
        <p className="text-[11px] font-mono line-clamp-2 leading-relaxed" style={{ color: 'var(--text-dim)' }}>
          {note.preview}
        </p>
      )}
      {note.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-0.5">
          {note.tags.slice(0, 3).map((t) => (
            <span key={t} className="text-[9px] px-1.5 py-0.5 rounded font-mono" style={{ background: 'rgba(255,179,0,0.1)', color: 'var(--accent-amber)' }}>
              #{t}
            </span>
          ))}
        </div>
      )}
    </button>
  )
}

// ─── Content viewer ──────────────────────────────────────────────────────────

function ContentViewer({ selected, content, loading }: { selected: string | null; content: string; loading: boolean }) {
  if (!selected) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3" style={{ color: 'var(--text-dim)' }}>
        <div className="text-5xl opacity-30">◫</div>
        <p className="text-xs font-mono tracking-widest uppercase opacity-50">Select a note to read</p>
        <p className="text-[11px] font-mono opacity-30">Cmd+K to search</p>
      </div>
    )
  }
  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <span className="text-xs font-mono animate-pulse" style={{ color: 'var(--accent-amber)' }}>Loading...</span>
      </div>
    )
  }
  const ext = selected.split('.').pop()?.toLowerCase() ?? ''
  if (selected.endsWith('.pdf')) return <PdfViewer path={selected} />
  if (/^(png|jpe?g|gif|webp|svg)$/.test(ext)) return <ImageViewer path={selected} />
  if (selected.endsWith('.md')) return <MarkdownViewer content={content} activePath={selected} />
  return <CodeViewer content={content} path={selected} />
}

// ─── Main component ──────────────────────────────────────────────────────────

type Section = 'Notebooks' | '_system' | '_logs'

function VaultBrowser() {
  const { file: fileParam } = Route.useSearch()

  const [pinned, setPinned] = useState<PinnedNote[]>([])
  const [tree, setTree] = useState<NoteTreeNode | null>(null)
  const [section, setSection] = useState<Section>('Notebooks')
  const [treeLoading, setTreeLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(fileParam ?? null)
  const [content, setContent] = useState('')
  const [contentLoading, setContentLoading] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)

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

  const openNote = useCallback(async (notePath: string) => {
    setSelected(notePath)
    setSidebarOpen(false)
    const ext = notePath.split('.').pop()?.toLowerCase() ?? ''
    const isMedia = /^(pdf|png|jpe?g|gif|webp|svg)$/.test(ext)
    if (isMedia) { setContent(''); return }
    setContentLoading(true)
    try {
      const res = await getNote({ data: notePath })
      setContent(res.content)
    } finally {
      setContentLoading(false)
    }
  }, [])

  // Open file from URL search param
  useEffect(() => {
    if (fileParam) openNote(fileParam)
  }, [fileParam])

  // Client-side tree filter
  const filteredTree = React.useMemo(() => {
    if (!tree || !query) return tree
    const filter = (node: NoteTreeNode): NoteTreeNode | null => {
      if (node.type === 'file') return node.name.toLowerCase().includes(query.toLowerCase()) ? node : null
      const children = node.children?.map(filter).filter(Boolean) as NoteTreeNode[]
      return children?.length ? { ...node, children } : node.name.toLowerCase().includes(query.toLowerCase()) ? node : null
    }
    return filter(tree)
  }, [tree, query])

  const selectedFilename = selected?.split('/').pop()

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

      {/* Pinned notes — always visible, no filter */}
      {pinned.length > 0 && !query && (
        <div className="flex-shrink-0 px-3 pb-3">
          <div className="text-[9px] font-mono tracking-widest uppercase mb-2 flex items-center gap-1.5" style={{ color: 'var(--accent-amber)' }}>
            <span>📌</span> Pinned
          </div>
          <div className="flex flex-col gap-1.5">
            {pinned.map((n) => (
              <PinnedCard key={n.path} note={n} onSelect={openNote} isSelected={selected === n.path} />
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
          <TreeNode node={filteredTree} onSelect={openNote} selected={selected} />
        ) : (
          <div className="text-center py-6 text-xs font-mono" style={{ color: 'var(--text-dim)' }}>No files found</div>
        )}
      </div>
    </div>
  )

  return (
    <div className="h-full flex flex-col">
      {/* Mobile top bar */}
      <div
        className="sm:hidden flex-shrink-0 flex items-center gap-2 px-3 py-2 border-b"
        style={{ background: 'var(--bg-surface)', borderColor: 'var(--border)' }}
      >
        <button
          onClick={() => setSidebarOpen(true)}
          className="p-1.5 rounded text-xs font-mono flex-shrink-0"
          style={{ background: 'var(--bg-elevated)', color: 'var(--text-dim)', border: '1px solid var(--border)' }}
        >
          ☰
        </button>
        <span className="text-xs font-mono truncate flex-1" style={{ color: selectedFilename ? 'var(--text-dim)' : 'var(--text-dim)', opacity: selectedFilename ? 1 : 0.4 }}>
          {selectedFilename ?? 'Select a note'}
        </span>
        <button
          onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))}
          className="p-1.5 rounded text-xs font-mono flex-shrink-0"
          style={{ background: 'var(--bg-elevated)', color: 'var(--text-dim)', border: '1px solid var(--border)' }}
          title="Search (Cmd+K)"
        >
          ⌕
        </button>
      </div>

      <div className="flex-1 flex min-h-0 relative">
        {/* Mobile overlay */}
        {sidebarOpen && (
          <div className="sm:hidden fixed inset-0 z-40 bg-black/60" onClick={() => setSidebarOpen(false)} />
        )}

        {/* Sidebar */}
        <aside
          className={`
            fixed sm:relative inset-y-0 left-0 z-50
            w-72 sm:w-72 flex-shrink-0 border-r
            transition-transform duration-200
            ${sidebarOpen ? 'translate-x-0' : '-translate-x-full sm:translate-x-0'}
          `}
          style={{ background: 'var(--bg-surface)', borderColor: 'var(--border)' }}
        >
          {/* Mobile close */}
          <div className="sm:hidden flex justify-end p-2 border-b flex-shrink-0" style={{ borderColor: 'var(--border)' }}>
            <button onClick={() => setSidebarOpen(false)} className="text-xs font-mono px-2 py-1 rounded" style={{ color: 'var(--text-dim)', background: 'var(--bg-elevated)' }}>
              ✕ Close
            </button>
          </div>
          {sidebar}
        </aside>

        {/* Content */}
        <main className="flex-1 overflow-y-auto p-4 sm:p-6 min-w-0" style={{ background: 'var(--bg-base)' }}>
          <div className="max-w-[860px] mx-auto h-full">
            <ContentViewer selected={selected} content={content} loading={contentLoading} />
          </div>
        </main>
      </div>
    </div>
  )
}
