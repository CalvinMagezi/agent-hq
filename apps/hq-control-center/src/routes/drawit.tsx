/**
 * /drawit — DrawIt canvas page.
 *
 * First-party consumer of the Chamuka DrawIt SDK inside the HQ Control Center.
 * Sidebar lists all .drawit files from the vault. Main area renders the selected
 * diagram on a live interactive canvas with zoom/export controls.
 */

import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { useState, useCallback, useEffect } from 'react'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { VAULT_PATH } from '~/server/vault'
import { getNote } from '~/server/notes'
import { DiagramViewer } from '~/components/DiagramViewer'
import type { ChamukaInstance } from '~/components/DiagramViewer'

// ─── Server function: list all .drawit files in the vault ────────────────────

interface DrawitFile {
  name: string
  path: string   // relative to vault root
  folder: string
  mtime: string
}

export const getDrawitFiles = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{ files: DrawitFile[] }> => {
    const files: DrawitFile[] = []

    const walk = (dir: string) => {
      if (files.length > 500) return
      let entries: fs.Dirent[]
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name.startsWith('_embeddings')) continue
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(fullPath)
        } else if (entry.name.endsWith('.drawit')) {
          const rel = path.relative(VAULT_PATH, fullPath)
          const parts = rel.split(path.sep)
          const folder = parts.length > 1 ? parts.slice(0, -1).join('/') : ''
          try {
            const stat = fs.statSync(fullPath)
            files.push({ name: entry.name.replace(/\.drawit$/, ''), path: rel, folder, mtime: stat.mtime.toISOString() })
          } catch { /* skip */ }
        }
      }
    }

    walk(VAULT_PATH)
    files.sort((a, b) => b.mtime.localeCompare(a.mtime))
    return { files }
  }
)

// ─── Route ───────────────────────────────────────────────────────────────────

export const Route = createFileRoute('/drawit')({
  component: DrawitPage,
  loader: async () => {
    const { files } = await getDrawitFiles()
    return { files }
  },
})

// ─── Toolbar ─────────────────────────────────────────────────────────────────

function Toolbar({
  filename,
  diagram,
  elementCount,
  onZoomFit,
  onToggleSidebar,
  sidebarOpen,
}: {
  filename: string | null
  diagram: ChamukaInstance | null
  elementCount: number
  onZoomFit: () => void
  onToggleSidebar: () => void
  sidebarOpen: boolean
}) {
  const [exporting, setExporting] = useState<'svg' | 'png' | null>(null)

  const handleExportSVG = async () => {
    if (!diagram) return
    setExporting('svg')
    try {
      // Access core Diagram export API — same pattern as the SDK example app
      const d = diagram as unknown as { export?: { exportSVG?: () => Promise<string> } }
      const svg = await d.export?.exportSVG?.()
      if (!svg) return
      const blob = new Blob([svg], { type: 'image/svg+xml' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${filename ?? 'diagram'}.svg`
      a.click()
      URL.revokeObjectURL(url)
    } catch { /* export not available in all configs */ }
    finally { setExporting(null) }
  }

  const handleExportPNG = async () => {
    if (!diagram) return
    setExporting('png')
    try {
      const d = diagram as unknown as { export?: { exportPNG?: () => Promise<string> } }
      const dataUrl = await d.export?.exportPNG?.()
      if (!dataUrl) return
      const a = document.createElement('a')
      a.href = dataUrl
      a.download = `${filename ?? 'diagram'}.png`
      a.click()
    } catch { /* export not available */ }
    finally { setExporting(null) }
  }

  const dim: React.CSSProperties = { color: 'var(--text-dim)', fontFamily: 'monospace', fontSize: '11px' }
  const btnBase: React.CSSProperties = {
    padding: '8px 12px', borderRadius: '6px', fontSize: '11px', fontFamily: 'monospace',
    cursor: 'pointer', border: '1px solid var(--border)', background: 'var(--bg-elevated)',
    color: 'var(--text-secondary)', transition: 'background 0.15s',
    minHeight: '36px', minWidth: '44px',
  }

  return (
    <div
      className="flex items-center justify-between px-3 py-2 border-b flex-shrink-0"
      style={{ background: 'var(--bg-surface)', borderColor: 'var(--border)', minHeight: '44px' }}
    >
      {/* Left: hamburger (mobile) + filename + element count */}
      <div className="flex items-center gap-2 sm:gap-3 min-w-0">
        {/* Mobile sidebar toggle */}
        <button
          onClick={onToggleSidebar}
          className="sm:hidden flex-shrink-0 flex items-center justify-center rounded"
          style={{
            width: '36px', height: '36px',
            background: sidebarOpen ? 'rgba(255,179,0,0.12)' : 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            color: sidebarOpen ? 'var(--accent-amber)' : 'var(--text-dim)',
            cursor: 'pointer',
          }}
          title="Toggle file list"
        >
          ◈
        </button>
        <span className="hidden sm:inline" style={{ ...dim, opacity: 0.4 }}>◈</span>
        <span
          className="font-mono font-bold truncate text-sm"
          style={{ color: filename ? 'var(--text-primary)' : 'var(--text-dim)' }}
        >
          {filename ?? 'No file selected'}
        </span>
        {elementCount > 0 && (
          <span style={{ ...dim, opacity: 0.5 }}>{elementCount} elements</span>
        )}
      </div>

      {/* Right: controls */}
      <div className="flex items-center gap-2 flex-shrink-0">
        <button
          onClick={onZoomFit}
          disabled={!diagram}
          style={{ ...btnBase, opacity: diagram ? 1 : 0.4 }}
          title="Zoom to fit"
        >
          ⊞ Fit
        </button>
        <button
          onClick={handleExportSVG}
          disabled={!diagram || exporting !== null}
          className="hidden sm:block"
          style={{ ...btnBase, opacity: diagram ? 1 : 0.4 }}
          title="Export SVG"
        >
          {exporting === 'svg' ? '...' : 'SVG'}
        </button>
        <button
          onClick={handleExportPNG}
          disabled={!diagram || exporting !== null}
          className="hidden sm:block"
          style={{ ...btnBase, opacity: diagram ? 1 : 0.4 }}
          title="Export PNG"
        >
          {exporting === 'png' ? '...' : 'PNG'}
        </button>
      </div>
    </div>
  )
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────

function Sidebar({
  files,
  selected,
  onSelect,
  onClose,
}: {
  files: DrawitFile[]
  selected: string | null
  onSelect: (file: DrawitFile) => void
  onClose?: () => void
}) {
  const [query, setQuery] = useState('')

  const filtered = query
    ? files.filter((f) => f.name.toLowerCase().includes(query.toLowerCase()) || f.folder.toLowerCase().includes(query.toLowerCase()))
    : files

  // Group by folder
  const groups = filtered.reduce<Record<string, DrawitFile[]>>((acc, f) => {
    const key = f.folder || 'Root'
    ;(acc[key] ??= []).push(f)
    return acc
  }, {})

  return (
    <aside
      className="flex flex-col border-r flex-shrink-0"
      style={{ width: '220px', background: 'var(--bg-surface)', borderColor: 'var(--border)' }}
    >
      {/* Header */}
      <div className="px-3 pt-3 pb-2 flex-shrink-0 border-b" style={{ borderColor: 'var(--border)' }}>
        <div className="text-[9px] font-mono tracking-widest uppercase mb-2" style={{ color: 'var(--accent-amber)' }}>
          ◈ Diagrams
        </div>
        <input
          type="text"
          placeholder="Filter..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full text-xs px-2 py-1.5 rounded outline-none"
          style={{
            background: 'var(--bg-elevated)', border: '1px solid var(--border)',
            color: 'var(--text-primary)', fontFamily: 'monospace',
          }}
        />
      </div>

      {/* File list */}
      <div className="flex-1 overflow-y-auto py-1 pb-16 md:pb-1">
        {files.length === 0 ? (
          <div className="text-center py-8 text-xs font-mono px-3" style={{ color: 'var(--text-dim)' }}>
            No .drawit files found in vault
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-8 text-xs font-mono" style={{ color: 'var(--text-dim)' }}>
            No matches
          </div>
        ) : (
          Object.entries(groups).map(([folder, groupFiles]) => (
            <div key={folder}>
              <div
                className="px-3 py-1 text-[9px] font-mono tracking-widest uppercase truncate"
                style={{ color: 'var(--text-dim)', opacity: 0.5 }}
              >
                {folder}
              </div>
              {groupFiles.map((f) => {
                const isSelected = selected === f.path
                return (
                  <button
                    key={f.path}
                    onClick={() => { onSelect(f); onClose?.() }}
                    className="w-full text-left px-3 py-1.5 text-xs font-mono flex items-center gap-2 transition-colors"
                    style={{
                      background: isSelected ? 'rgba(255,179,0,0.1)' : 'transparent',
                      color: isSelected ? 'var(--accent-amber)' : 'var(--text-secondary)',
                      borderLeft: isSelected ? '2px solid var(--accent-amber)' : '2px solid transparent',
                    }}
                  >
                    <span style={{ opacity: 0.5, fontSize: '10px' }}>◈</span>
                    <span className="truncate">{f.name}</span>
                  </button>
                )
              })}
            </div>
          ))
        )}
      </div>

      {/* Footer: total count */}
      <div className="px-3 py-2 border-t flex-shrink-0" style={{ borderColor: 'var(--border)' }}>
        <span className="text-[10px] font-mono" style={{ color: 'var(--text-dim)', opacity: 0.5 }}>
          {files.length} file{files.length !== 1 ? 's' : ''}
        </span>
      </div>
    </aside>
  )
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState({ hasFiles }: { hasFiles: boolean }) {
  return (
    <div
      className="flex-1 flex flex-col items-center justify-center gap-4"
      style={{ color: 'var(--text-dim)' }}
    >
      <div style={{ fontSize: '40px', opacity: 0.3 }}>◈</div>
      <div className="text-center">
        <p className="text-sm font-mono font-bold mb-1" style={{ color: 'var(--text-secondary)' }}>
          {hasFiles ? 'Select a diagram' : 'No diagrams yet'}
        </p>
        <p className="text-xs font-mono" style={{ color: 'var(--text-dim)', opacity: 0.6 }}>
          {hasFiles
            ? 'Pick a .drawit file from the sidebar to view it here'
            : 'Create a .drawit file in your vault or run the DrawIt CLI'}
        </p>
      </div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

function DrawitPage() {
  const { files } = Route.useLoaderData()

  const [selectedFile, setSelectedFile] = useState<DrawitFile | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [diagram, setDiagram] = useState<ChamukaInstance | null>(null)
  const [elementCount, setElementCount] = useState(0)
  const [sidebarOpen, setSidebarOpen] = useState(false)

  // Close sidebar on resize to desktop
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 640px)')
    const handler = (e: MediaQueryListEvent) => { if (e.matches) setSidebarOpen(false) }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  const handleSelect = useCallback(async (file: DrawitFile) => {
    if (selectedFile?.path === file.path) return
    setSelectedFile(file)
    setContent(null)
    setDiagram(null)
    setElementCount(0)
    setLoading(true)
    try {
      const { content: raw } = await getNote({ data: file.path })
      setContent(raw ?? '')
    } catch {
      setContent('')
    } finally {
      setLoading(false)
    }
  }, [selectedFile])

  const handleDiagram = useCallback((d: ChamukaInstance | null) => {
    setDiagram(d)
    if (d && content) {
      // Count elements from parsed content for the toolbar
      const lines = content.trim().split('\n').filter(Boolean)
      let count = 0
      for (const line of lines) {
        try {
          const obj = JSON.parse(line) as { type?: string }
          if (obj.type === 'node' || obj.type === 'edge') count++
        } catch { /* skip */ }
      }
      if (count === 0) {
        try {
          const parsed = JSON.parse(content) as { elements?: unknown[] }
          count = parsed.elements?.length ?? 0
        } catch { /* skip */ }
      }
      setElementCount(count)
    }
  }, [content])

  const handleZoomFit = useCallback(() => {
    try { diagram?.viewport.zoomToFit(40) } catch { /* ignore */ }
  }, [diagram])

  return (
    <div className="h-full flex overflow-hidden" style={{ background: 'var(--bg-base)' }}>
      {/* Desktop sidebar — always visible on sm+ */}
      <div className="hidden sm:flex">
        <Sidebar files={files} selected={selectedFile?.path ?? null} onSelect={handleSelect} />
      </div>

      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <>
          {/* Backdrop */}
          <div
            className="sm:hidden fixed inset-0 z-40"
            style={{ background: 'rgba(0,0,0,0.55)' }}
            onClick={() => setSidebarOpen(false)}
          />
          {/* Drawer */}
          <div className="sm:hidden fixed inset-y-0 left-0 z-50 flex">
            <Sidebar
              files={files}
              selected={selectedFile?.path ?? null}
              onSelect={handleSelect}
              onClose={() => setSidebarOpen(false)}
            />
          </div>
        </>
      )}

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Toolbar */}
        <Toolbar
          filename={selectedFile?.name ?? null}
          diagram={diagram}
          elementCount={elementCount}
          onZoomFit={handleZoomFit}
          onToggleSidebar={() => setSidebarOpen((o) => !o)}
          sidebarOpen={sidebarOpen}
        />

        {/* Canvas area */}
        <div className="flex-1 min-h-0 relative">
          {loading && (
            <div
              className="absolute inset-0 flex items-center justify-center z-10"
              style={{ background: 'var(--bg-base)', color: 'var(--text-dim)', fontFamily: 'monospace', fontSize: '12px' }}
            >
              Loading...
            </div>
          )}

          {!loading && content === null && (
            <EmptyState hasFiles={files.length > 0} />
          )}

          {!loading && content !== null && (
            <DiagramViewer
              key={selectedFile?.path} // remount on file change
              content={content}
              readonly={false}
              onDiagram={handleDiagram}
            />
          )}
        </div>
      </div>
    </div>
  )
}
