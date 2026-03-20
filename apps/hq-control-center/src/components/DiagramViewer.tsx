/**
 * DiagramViewer — renders a .drawit file using the Chamuka DrawIt canvas.
 *
 * Loads the prebuilt chamuka-drawit browser bundle (public/chamuka-drawit.min.js)
 * and mounts an interactive Diagram in readonly mode. Follows the same approach
 * as the VS Code DrawIt extension's webview.
 *
 * Supports both file formats:
 *  - Standard JSON export: { elements: [...], metadata, version }
 *  - NDJSON: one JSON object per line (AI-generated)
 */

import { useEffect, useRef, useState } from 'react'

declare global {
  interface Window {
    ChamukaDrawIt?: {
      Diagram: new (container: HTMLElement, options?: Record<string, unknown>) => ChamukaInstance
      GridRulerPlugin: new (options?: Record<string, unknown>) => unknown
    }
  }
}

interface ChamukaInstance {
  elements: {
    addNode: (props: Record<string, unknown>) => { id: string }
    addEdge: (props: Record<string, unknown>) => { id: string }
  }
  addPlugin: (plugin: unknown) => void
  viewport: { zoomToFit: (padding?: number) => void }
  dispose?: () => void
}

/** Parse .drawit content — handles NDJSON and standard JSON export formats */
function parseDrawitContent(content: string): Array<Record<string, unknown>> {
  const trimmed = content.trim()
  if (!trimmed) return []

  const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean)

  // NDJSON detection: multiple lines, each valid JSON object
  if (lines.length > 1) {
    const objs: Array<Record<string, unknown>> = []
    let allJson = true
    for (const line of lines) {
      try {
        const obj = JSON.parse(line)
        if (obj && typeof obj === 'object') objs.push(obj as Record<string, unknown>)
      } catch {
        allJson = false
        break
      }
    }
    if (allJson && objs.length > 0) {
      // Skip metadata line (no type field or type is 'metadata')
      return objs.filter((o) => o.type === 'node' || o.type === 'edge')
    }
  }

  // Standard JSON export
  try {
    const parsed = JSON.parse(trimmed) as {
      elements?: Array<Record<string, unknown>>
      nodes?: Array<Record<string, unknown>>
      edges?: Array<Record<string, unknown>>
    }

    if (Array.isArray(parsed.elements)) return parsed.elements
    // Fallback: flat arrays of nodes + edges
    const nodes = Array.isArray(parsed.nodes) ? parsed.nodes : []
    const edges = Array.isArray(parsed.edges) ? parsed.edges : []
    return [...nodes, ...edges]
  } catch {
    return []
  }
}

/** Load the chamuka browser bundle as a script tag — singleton */
function loadBundle(): Promise<void> {
  if (window.ChamukaDrawIt) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const existing = document.getElementById('chamuka-drawit-bundle')
    if (existing) {
      existing.addEventListener('load', () => resolve())
      existing.addEventListener('error', reject)
      return
    }
    const script = document.createElement('script')
    script.id = 'chamuka-drawit-bundle'
    script.src = '/chamuka-drawit.min.js'
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Failed to load chamuka-drawit.min.js'))
    document.head.appendChild(script)
  })
}

export type { ChamukaInstance }

interface DiagramViewerProps {
  content: string
  readonly?: boolean
  /** Called once the diagram is initialised — gives access to the instance for toolbar controls */
  onDiagram?: (diagram: ChamukaInstance | null) => void
}

export function DiagramViewer({ content, readonly = true, onDiagram }: DiagramViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const diagramRef = useRef<ChamukaInstance | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error' | 'empty'>('loading')
  const [errorMsg, setErrorMsg] = useState('')

  useEffect(() => {
    let active = true

    async function init() {
      try {
        await loadBundle()
        if (!active || !containerRef.current) return

        const { Diagram, GridRulerPlugin } = window.ChamukaDrawIt!
        const container = containerRef.current

        const diagram = new Diagram(container, {
          readonly,
          width: container.clientWidth || 800,
          height: container.clientHeight || 600,
          background: '#0a0f1e',
        })

        // GridRulerPlugin takes optional config (not the diagram instance)
        // addPlugin is the correct public API on Diagram
        try { diagram.addPlugin(new GridRulerPlugin()) } catch { /* optional plugin */ }

        // Diagram has its own built-in ResizeObserver — no need for a custom one
        diagramRef.current = diagram

        // Parse and load elements
        const elements = parseDrawitContent(content)
        if (elements.length === 0) {
          onDiagram?.(diagram)
          setStatus('empty')
          return
        }

        const nodes = elements.filter((e) => e.type === 'node')
        const edges = elements.filter((e) => e.type === 'edge')

        for (const node of nodes) {
          try { diagram.elements.addNode(node) } catch { /* skip invalid */ }
        }
        for (const edge of edges) {
          try { diagram.elements.addEdge(edge) } catch { /* skip invalid */ }
        }

        try { diagram.viewport.zoomToFit(40) } catch { /* not critical */ }

        if (active) {
          onDiagram?.(diagram)
          setStatus('ready')
        }
      } catch (err) {
        if (active) {
          setErrorMsg(err instanceof Error ? err.message : 'Failed to load diagram')
          setStatus('error')
        }
      }
    }

    init()

    return () => {
      active = false
      try { diagramRef.current?.dispose?.() } catch { /* ignore */ }
      diagramRef.current = null
      onDiagram?.(null)
    }
  }, [content, readonly])

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        minHeight: 0,
        position: 'relative',
        background: 'var(--bg-surface)',
        overflow: 'hidden',
      }}
    >
      <div
        ref={containerRef}
        style={{ position: 'absolute', inset: 0 }}
      />

      {status === 'loading' && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--bg-surface)',
            color: 'var(--text-dim)',
            fontFamily: 'monospace',
            fontSize: '12px',
          }}
        >
          Loading diagram...
        </div>
      )}

      {status === 'empty' && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-dim)',
            fontFamily: 'monospace',
            fontSize: '12px',
          }}
        >
          Empty diagram
        </div>
      )}

      {status === 'error' && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexDirection: 'column',
            gap: '8px',
            color: 'var(--accent-red, #ef4444)',
            fontFamily: 'monospace',
            fontSize: '12px',
            padding: '24px',
            textAlign: 'center',
          }}
        >
          <span>Failed to render diagram</span>
          {errorMsg && (
            <span style={{ opacity: 0.6, fontSize: '11px' }}>{errorMsg}</span>
          )}
        </div>
      )}
    </div>
  )
}
