import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { searchNotes } from '~/server/notes'
import { useHQStore } from '~/store/hqStore'

interface SearchHit {
  notePath: string
  title: string
  notebook: string
  snippet: string
  tags: string[]
  relevance: number
  matchType: 'keyword' | 'semantic' | 'hybrid'
}

export function SearchOverlay() {
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchHit[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [searchMode, setSearchMode] = useState<'fts' | 'fallback' | null>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const navigate = useNavigate()
  const wsConnected = useHQStore((s) => s.wsConnected)

  // Open/close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); setIsOpen((v) => !v) }
      if (e.key === 'Escape') setIsOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Focus + reset on open
  useEffect(() => {
    if (isOpen) { inputRef.current?.focus(); setQuery(''); setResults([]) }
  }, [isOpen])

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIndex((i) => (i + 1) % Math.max(results.length, 1)) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIndex((i) => (i - 1 + results.length) % Math.max(results.length, 1)) }
      else if (e.key === 'Enter' && results[selectedIndex]) { openResult(results[selectedIndex]) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, results, selectedIndex])

  const openResult = useCallback((hit: SearchHit) => {
    setIsOpen(false)
    navigate({ to: '/', search: { file: hit.notePath } })
  }, [navigate])

  // Search — try FTS via ws-server first, fall back to server fn
  useEffect(() => {
    const q = query.trim()
    if (!q) { setResults([]); setSearchMode(null); return }

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setIsLoading(true)
    setSelectedIndex(0)

    const run = async () => {
      // 1. Try FTS via ws-server (fast SQLite FTS5, ~1ms)
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
              setSearchMode('fts')
              setIsLoading(false)
              return
            }
          }
        } catch (e: any) {
          if (e.name === 'AbortError') return
          // ws-server offline or error — fall through to server fn
        }
      }

      // 2. Fallback: server fn grep search (always available)
      try {
        const data = await searchNotes({ data: q })
        if (!controller.signal.aborted) {
          setResults(data.results)
          setSearchMode('fallback')
        }
      } catch { /* ignore */ }
      finally { if (!controller.signal.aborted) setIsLoading(false) }
    }

    const timer = setTimeout(run, 200)
    return () => { clearTimeout(timer); controller.abort() }
  }, [query, wsConnected])

  if (!isOpen) return null

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
        onClick={() => setIsOpen(false)}
      />

      {/* Panel */}
      <div
        className="fixed z-50 top-[10vh] left-1/2 -translate-x-1/2 w-full max-w-2xl rounded-xl shadow-2xl overflow-hidden flex flex-col"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', maxHeight: '70vh' }}
      >
        {/* Input row */}
        <div className="flex items-center gap-3 px-4 py-3 border-b" style={{ borderColor: 'var(--border)' }}>
          <span className="text-base" style={{ color: 'var(--text-dim)' }}>⌕</span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search vault..."
            className="flex-1 bg-transparent outline-none text-base font-mono"
            style={{ color: 'var(--text-primary)' }}
          />
          {isLoading && (
            <div className="w-4 h-4 rounded-full border-2 border-t-transparent animate-spin" style={{ borderColor: 'var(--accent-amber)', borderTopColor: 'transparent' }} />
          )}
          {!isLoading && searchMode && (
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded" style={{
              color: searchMode === 'fts' ? 'var(--accent-green)' : 'var(--accent-amber)',
              background: searchMode === 'fts' ? 'rgba(0,255,136,0.1)' : 'rgba(255,179,0,0.1)',
            }}>
              {searchMode === 'fts' ? 'FTS' : 'grep'}
            </span>
          )}
          <button onClick={() => setIsOpen(false)} style={{ color: 'var(--text-dim)' }}>
            <span className="text-sm font-mono">✕</span>
          </button>
        </div>

        {/* Results */}
        <div className="flex-1 overflow-y-auto">
          {query && !isLoading && results.length === 0 && (
            <div className="px-6 py-12 text-center text-sm font-mono" style={{ color: 'var(--text-dim)' }}>
              No results for "{query}"
            </div>
          )}

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
                <p
                  className="text-xs font-mono line-clamp-2 leading-relaxed"
                  style={{ color: 'var(--text-dim)' }}
                  dangerouslySetInnerHTML={{ __html: hit.snippet.replace(
                    new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'),
                    '<mark style="background:rgba(255,179,0,0.25);color:var(--accent-amber);border-radius:2px">$1</mark>'
                  )}}
                />
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
        </div>

        {/* Footer hints */}
        <div
          className="px-4 py-2 flex items-center justify-between border-t text-[10px] font-mono"
          style={{ borderColor: 'var(--border)', color: 'var(--text-dim)' }}
        >
          <span>{results.length > 0 ? `${results.length} results` : 'Type to search'}</span>
          <div className="flex items-center gap-3">
            <span><kbd className="px-1 rounded" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>↑↓</kbd> navigate</span>
            <span><kbd className="px-1 rounded" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>↵</kbd> open</span>
            <span><kbd className="px-1 rounded" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>Esc</kbd> close</span>
          </div>
        </div>
      </div>
    </>
  )
}
