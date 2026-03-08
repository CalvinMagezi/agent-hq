import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { getNote, togglePinNote } from '~/server/notes'
import { MarkdownViewer } from '~/components/MarkdownViewer'
import { PdfViewer } from '~/components/PdfViewer'
import { ImageViewer } from '~/components/ImageViewer'
import { CodeViewer } from '~/components/CodeViewer'
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
                <div className="max-w-[860px] mx-auto p-4 sm:p-6 pb-24 h-full overflow-x-hidden">
                    {viewer}
                </div>
            </div>
        </div>
    )
}
