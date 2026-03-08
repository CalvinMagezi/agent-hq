import { createFileRoute } from '@tanstack/react-router'
import React, { useState, useEffect } from 'react'
import { getNoteTree, getNote } from '~/server/notes'
import type { NoteTreeNode } from '~/server/notes'
import { MarkdownViewer } from '~/components/MarkdownViewer'
import { PdfViewer } from '~/components/PdfViewer'
import { ImageViewer } from '~/components/ImageViewer'
import { CodeViewer } from '~/components/CodeViewer'

export const Route = createFileRoute('/notes')({
  validateSearch: (search: Record<string, unknown>) => ({
    file: typeof search.file === 'string' ? search.file : undefined,
  }),
  component: NotesView,
})

function getFileIcon(filename: string) {
  if (filename.endsWith('.md')) return '📄'
  if (filename.endsWith('.pdf')) return '📕'
  if (filename.match(/\.(png|jpe?g|gif|webp|svg)$/i)) return '🖼'
  if (filename.endsWith('.json')) return '{}'
  if (filename.match(/\.(ts|js|sh|yaml|yml)$/)) return '⟨/⟩'
  return '📄'
}

function TreeNode({
  node,
  depth = 0,
  onSelect,
  selected,
}: {
  node: NoteTreeNode
  depth?: number
  onSelect: (path: string) => void
  selected: string | null
}) {
  const [open, setOpen] = useState(depth < 1)

  if (node.type === 'file') {
    return (
      <button
        onClick={() => onSelect(node.path)}
        className="w-full text-left py-1 px-2 rounded text-xs truncate transition-colors flex items-center gap-2"
        style={{
          paddingLeft: `${(depth + 1) * 12}px`,
          color: selected === node.path ? 'var(--accent-amber)' : 'var(--text-dim)',
          background: selected === node.path ? 'rgba(255, 179, 0, 0.08)' : 'transparent',
          fontFamily: 'var(--font-mono)',
        }}
      >
        <span className="opacity-70">{getFileIcon(node.name)}</span>
        <span className="truncate">{node.name.replace(/\.[^/.]+$/, "")}</span>
      </button>
    )
  }

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left py-1 px-2 text-xs font-semibold tracking-wider"
        style={{
          paddingLeft: `${depth * 12}px`,
          color: 'var(--text-primary)',
          fontFamily: 'var(--font-mono)',
        }}
      >
        {open ? '▾' : '▸'} {node.name}
      </button>
      {open && node.children?.map((child) => (
        <TreeNode
          key={child.path}
          node={child}
          depth={depth + 1}
          onSelect={onSelect}
          selected={selected}
        />
      ))}
    </div>
  )
}

function NotesView() {
  const { file: fileParam } = Route.useSearch()
  const [tree, setTree] = useState<NoteTreeNode | null>(null)
  const [selected, setSelected] = useState<string | null>(fileParam ?? null)
  const [content, setContent] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [treeLoading, setTreeLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [activeRoot, setActiveRoot] = useState<'Notebooks' | '_system' | '_logs'>('Notebooks')
  const [sidebarOpen, setSidebarOpen] = useState(false)

  // Auto-load note when navigated from search overlay
  useEffect(() => {
    if (fileParam) loadNote(fileParam)
  }, [fileParam])

  useEffect(() => {
    setTreeLoading(true)
    getNoteTree({ data: activeRoot }).then(res => {
      setTree(res.tree)
      setTreeLoading(false)
    })
  }, [activeRoot])

  const loadNote = async (notePath: string) => {
    setSelected(notePath)
    setSidebarOpen(false) // close drawer on mobile after selection

    const ext = notePath.split('.').pop()?.toLowerCase() || ''
    const isMedia = ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)
    if (isMedia) {
      setContent('')
      return
    }

    setLoading(true)
    try {
      const result = await getNote({ data: notePath })
      setContent(result.content)
    } finally {
      setLoading(false)
    }
  }

  // Filter tree client-side
  const filteredTree = React.useMemo(() => {
    if (!tree) return null
    if (!query) return tree

    const filterNode = (node: NoteTreeNode): NoteTreeNode | null => {
      if (node.type === 'file') {
        return node.name.toLowerCase().includes(query.toLowerCase()) ? node : null
      }
      const children = node.children?.map(filterNode).filter(Boolean) as NoteTreeNode[]
      if (children && children.length > 0) {
        return { ...node, children }
      }
      return node.name.toLowerCase().includes(query.toLowerCase()) ? node : null
    }

    return filterNode(tree)
  }, [tree, query])

  const sidebarContent = (
    <>
      {/* Section Tabs */}
      <div className="flex border-b flex-shrink-0" style={{ borderColor: 'var(--border)' }}>
        {(['Notebooks', '_system', '_logs'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveRoot(tab)}
            className="flex-1 py-2 text-[10px] tracking-wider uppercase font-mono font-bold transition-colors"
            style={{
              color: activeRoot === tab ? 'var(--accent-amber)' : 'var(--text-dim)',
              borderBottom: activeRoot === tab ? '2px solid var(--accent-amber)' : '2px solid transparent',
              background: activeRoot === tab ? 'rgba(255, 179, 0, 0.05)' : 'transparent',
            }}
          >
            {tab.replace('_', '')}
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="px-2 py-2 flex-shrink-0">
        <input
          type="text"
          placeholder="Filter files..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full text-xs px-3 py-2 rounded outline-none"
          style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            color: 'var(--text-primary)',
            fontFamily: 'var(--font-mono)',
          }}
        />
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {treeLoading ? (
          <div className="text-center py-4 text-xs font-mono opacity-50" style={{ color: 'var(--text-dim)' }}>Loading tree...</div>
        ) : filteredTree ? (
          <TreeNode node={filteredTree} onSelect={loadNote} selected={selected} />
        ) : (
          <div className="text-center py-4 text-xs font-mono opacity-50" style={{ color: 'var(--text-dim)' }}>No files found</div>
        )}
      </div>
    </>
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
          className="p-1.5 rounded text-xs font-mono"
          style={{ background: 'var(--bg-elevated)', color: 'var(--text-dim)', border: '1px solid var(--border)' }}
        >
          ☰ Files
        </button>
        {selected && (
          <span className="text-xs font-mono truncate flex-1" style={{ color: 'var(--text-dim)' }}>
            {selected.split('/').pop()}
          </span>
        )}
      </div>

      <div className="flex-1 flex min-h-0 relative">
        {/* Mobile drawer overlay */}
        {sidebarOpen && (
          <div
            className="sm:hidden fixed inset-0 z-40 bg-black/60"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        {/* Sidebar — always visible on sm+, drawer on mobile */}
        <aside
          className={`
            fixed sm:relative inset-y-0 left-0 z-50
            w-72 sm:w-64 flex-shrink-0 border-r flex flex-col
            transition-transform duration-200
            ${sidebarOpen ? 'translate-x-0' : '-translate-x-full sm:translate-x-0'}
          `}
          style={{ background: 'var(--bg-surface)', borderColor: 'var(--border)' }}
        >
          {/* Mobile close button */}
          <div className="sm:hidden flex justify-end p-2 border-b flex-shrink-0" style={{ borderColor: 'var(--border)' }}>
            <button
              onClick={() => setSidebarOpen(false)}
              className="text-xs font-mono px-2 py-1 rounded"
              style={{ color: 'var(--text-dim)', background: 'var(--bg-elevated)' }}
            >
              ✕ Close
            </button>
          </div>
          {sidebarContent}
        </aside>

        {/* Note content */}
        <main
          className="flex-1 overflow-y-auto p-4 sm:p-6"
          style={{ background: 'var(--bg-base)' }}
        >
          {!selected ? (
            <div
              className="flex flex-col items-center justify-center h-full"
              style={{ color: 'var(--text-dim)' }}
            >
              <div className="text-4xl mb-3">📝</div>
              <div className="text-xs tracking-wider">Select a note to read</div>
            </div>
          ) : loading ? (
            <div
              className="text-xs animate-pulse"
              style={{ color: 'var(--accent-amber)', fontFamily: 'var(--font-mono)' }}
            >
              Loading...
            </div>
          ) : (
            <article className="max-w-[800px] w-full mx-auto h-full">
              {selected.toLowerCase().endsWith('.pdf') ? (
                <PdfViewer path={selected} />
              ) : selected.match(/\.(png|jpe?g|gif|webp|svg)$/i) ? (
                <ImageViewer path={selected} />
              ) : selected.toLowerCase().endsWith('.md') ? (
                <MarkdownViewer content={content} activePath={selected} />
              ) : (
                <CodeViewer content={content} path={selected} />
              )}
            </article>
          )}
        </main>
      </div>
    </div>
  )
}
