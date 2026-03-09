import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { marked } from 'marked'
import { getNote, togglePinNote } from '~/server/notes'
import { MarkdownViewer } from '~/components/MarkdownViewer'
import { PdfViewer } from '~/components/PdfViewer'
import { ImageViewer } from '~/components/ImageViewer'
import { CodeViewer } from '~/components/CodeViewer'
import { DiagramViewer } from '~/components/DiagramViewer'
import { useHQStore } from '~/store/hqStore'

export const Route = createFileRoute('/vault/$')({
    component: VaultFileView,
    loader: async ({ params }) => {
        const filePath = params._splat || ''

        // We only want to block for text/markdown files.
        // For large/binary files, getNote will return empty content anyway, 
        // and the respective viewers load it via streaming/href.
        const { content } = await getNote({ data: filePath })
        return { filePath, content }
    },
})

function VaultFileView() {
    const { filePath, content } = Route.useLoaderData()
    const { setChatPanelOpen, setChatContext, chatPanelOpen, bumpPinnedVersion } = useHQStore()

    const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
    const isMd = ext === 'md'

    // Parse pinned state from frontmatter in content
    const initialPinned = isMd && /^---[\s\S]*?^pinned:\s*true/m.test(content)
    const [isPinned, setIsPinned] = useState(initialPinned)
    const [pinning, setPinning] = useState(false)

    const handleTogglePin = async () => {
        setPinning(true)
        try {
            await togglePinNote({ data: { path: filePath, pinned: !isPinned } })
            setIsPinned(!isPinned)
            bumpPinnedVersion()
        } finally {
            setPinning(false)
        }
    }

    const handleDownloadPDF = async () => {
        const filename = filePath.split('/').pop()?.replace(/\.md$/, '') ?? 'note'

        // Strip YAML frontmatter before rendering
        const body = content.replace(/^---[\s\S]*?---\n?/, '')
        const html = await marked.parse(body)

        const win = window.open('', '_blank', 'width=900,height=700')
        if (!win) return

        win.document.write(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${filename}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 14px;
    line-height: 1.7;
    color: #1a1a2e;
    max-width: 760px;
    margin: 0 auto;
    padding: 48px 40px;
  }
  h1 { font-size: 26px; font-weight: 700; margin: 0 0 24px; border-bottom: 2px solid #e2e8f0; padding-bottom: 12px; }
  h2 { font-size: 20px; font-weight: 600; margin: 32px 0 12px; }
  h3 { font-size: 16px; font-weight: 600; margin: 24px 0 8px; }
  p { margin: 0 0 16px; }
  a { color: #3b82f6; }
  code {
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 12px;
    background: #f1f5f9;
    padding: 2px 6px;
    border-radius: 4px;
  }
  pre {
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 6px;
    padding: 16px;
    overflow-x: auto;
    margin: 0 0 16px;
  }
  pre code { background: none; padding: 0; font-size: 12px; }
  blockquote {
    border-left: 3px solid #94a3b8;
    margin: 0 0 16px;
    padding: 4px 0 4px 16px;
    color: #64748b;
  }
  table { width: 100%; border-collapse: collapse; margin: 0 0 16px; font-size: 13px; }
  th, td { border: 1px solid #e2e8f0; padding: 8px 12px; text-align: left; }
  th { background: #f8fafc; font-weight: 600; }
  ul, ol { margin: 0 0 16px; padding-left: 24px; }
  li { margin-bottom: 4px; }
  hr { border: none; border-top: 1px solid #e2e8f0; margin: 24px 0; }
  .meta { font-size: 11px; color: #94a3b8; margin-bottom: 32px; }
  @media print {
    body { padding: 0; max-width: 100%; }
    a { color: #1a1a2e; text-decoration: none; }
  }
</style>
</head>
<body>
<h1>${filename}</h1>
<p class="meta">${filePath} · ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</p>
${html}
<script>window.onload = () => { window.print(); }<\/script>
</body>
</html>`)
        win.document.close()
    }

    const handleSendToChat = () => {
        setChatPanelOpen(true)
        setChatContext({
            type: 'file',
            path: filePath,
            content: content ? content.slice(0, 2000) + (content.length > 2000 ? '...\n\n[TRUNCATED]' : '') : undefined
        })
    }

    // File rendering
    let viewer
    if (filePath.endsWith('.pdf')) {
        viewer = <PdfViewer path={filePath} />
    } else if (/^(png|jpe?g|gif|webp|svg)$/.test(ext)) {
        viewer = <ImageViewer path={filePath} />
    } else if (ext === 'md') {
        viewer = <MarkdownViewer content={content} activePath={filePath} />
    } else if (ext === 'drawit') {
        viewer = <DiagramViewer content={content} />
    } else {
        viewer = <CodeViewer content={content} path={filePath} />
    }

    const filename = filePath.split('/').pop()

    return (
        <div className="h-full flex flex-col relative">
            {/* File Header Bar */}
            <div
                className="flex items-center justify-between px-4 py-2 border-b flex-shrink-0 sticky top-0 z-10"
                style={{ background: 'var(--bg-surface)', borderColor: 'var(--border)' }}
            >
                <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[10px] font-mono opacity-50 truncate hidden sm:inline">
                        {filePath.split('/').slice(0, -1).join('/')}/
                    </span>
                    <span className="text-sm font-mono font-bold truncate" style={{ color: 'var(--text-primary)' }}>
                        {filename}
                    </span>
                </div>

                <div className="flex items-center gap-2 pl-4 flex-shrink-0">
                    <button
                        onClick={() => {
                            navigator.clipboard.writeText(filePath)
                        }}
                        className="px-2 py-1 rounded text-[10px] font-mono transition-colors hover:bg-white/10"
                        style={{ color: 'var(--text-dim)' }}
                        title="Copy path"
                    >
                        Copy path
                    </button>
                    {isMd && (
                        <button
                            onClick={handleTogglePin}
                            disabled={pinning}
                            className="px-2 py-1 rounded text-[10px] font-mono transition-colors hover:bg-white/10 flex items-center gap-1"
                            style={{ color: isPinned ? 'var(--accent-amber)' : 'var(--text-dim)' }}
                            title={isPinned ? 'Unpin note' : 'Pin note'}
                        >
                            📌 {isPinned ? 'Pinned' : 'Pin'}
                        </button>
                    )}
                    {isMd && (
                        <button
                            onClick={handleDownloadPDF}
                            className="px-2 py-1 rounded text-[10px] font-mono transition-colors hover:bg-white/10 flex items-center gap-1"
                            style={{ color: 'var(--text-dim)' }}
                            title="Download as PDF"
                        >
                            ↓ PDF
                        </button>
                    )}
                    <button
                        onClick={handleSendToChat}
                        className="px-3 py-1.5 rounded-full text-xs font-mono font-bold flex items-center gap-1.5 transition-colors"
                        style={{
                            background: chatPanelOpen ? 'var(--bg-elevated)' : 'var(--accent-blue)',
                            color: chatPanelOpen ? 'var(--text-primary)' : '#000',
                            border: chatPanelOpen ? '1px solid var(--border)' : 'none'
                        }}
                    >
                        <span className="opacity-70">💬</span> Send to Chat
                    </button>
                </div>
            </div>

            {/* Content Area */}
            <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden w-full">
                {ext === 'drawit' ? (
                    // Diagrams need full canvas space — no max-width or prose padding
                    <div className="w-full h-full p-2">
                        {viewer}
                    </div>
                ) : (
                    <div className="max-w-[860px] mx-auto p-4 sm:p-6 pb-24 h-full overflow-x-hidden">
                        {viewer}
                    </div>
                )}
            </div>
        </div>
    )
}
