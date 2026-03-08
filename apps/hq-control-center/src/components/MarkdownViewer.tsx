import { useEffect, useState, useRef } from 'react'
import { marked } from 'marked'
import { createHighlighter } from 'shiki'
import { SelectionToolbar } from './SelectionToolbar'
import { useHQStore } from '~/store/hqStore'

// Initialize shiki cache outside component
let highlighterPromise: Promise<any> | null = null

function getHighlighter() {
    if (!highlighterPromise) {
        highlighterPromise = createHighlighter({
            themes: ['vitesse-dark'],
            langs: ['javascript', 'typescript', 'tsx', 'jsx', 'json', 'bash', 'yaml', 'markdown', 'html', 'css', 'python', 'go', 'rust', 'sh']
        })
    }
    return highlighterPromise
}

export function MarkdownViewer({ content, activePath }: { content: string; activePath?: string }) {
    const [html, setHtml] = useState<string>('')
    const [frontmatter, setFrontmatter] = useState<Record<string, any>>({})
    const [metaOpen, setMetaOpen] = useState(false)
    const containerRef = useRef<HTMLDivElement>(null)
    const { setChatPanelOpen, setChatContext } = useHQStore()

    const handleSendSelection = (text: string) => {
        setChatPanelOpen(true)
        setChatContext({
            type: 'selection',
            path: activePath || 'Vault Text',
            content: text
        })
    }

    useEffect(() => {
        let active = true

        async function processContent() {
            // 1. Extract frontmatter
            let md = content || ''
            let fm: Record<string, any> = {}

            const fmMatch = md.match(/^---\n([\s\S]*?)\n---\n/)
            if (fmMatch) {
                md = md.slice(fmMatch[0].length)
                const lines = fmMatch[1].split('\n')
                lines.forEach(line => {
                    const colonIdx = line.indexOf(':')
                    if (colonIdx > 0) {
                        const key = line.slice(0, colonIdx).trim()
                        const val = line.slice(colonIdx + 1).trim()
                        fm[key] = val
                    }
                })
            }
            setFrontmatter(fm)

            // 2. Setup Marked
            const highlighter = await getHighlighter()

            marked.use({
                renderer: {
                    code(token: any) {
                        try {
                            return highlighter.codeToHtml(token.text, { lang: token.lang || 'text', theme: 'vitesse-dark' })
                        } catch (e) {
                            return `<pre><code>${token.text}</code></pre>`
                        }
                    },
                    heading(token: any) {
                        return `<h${token.depth} class="md-heading md-h${token.depth}">${token.text}</h${token.depth}>`
                    },
                    blockquote(token: any) {
                        return `<blockquote class="md-blockquote">${token.text}</blockquote>`
                    },
                    link(token: any) {
                        return `<a href="${token.href}" class="md-link" target="_blank" rel="noopener noreferrer">${token.text}</a>`
                    }
                }
            })

            // 3. Process Wikilinks [[...]]
            md = md.replace(/\[\[([^\]]+)\]\]/g, (match, p1) => {
                return `<span class="md-wikilink">${p1}</span>`
            })

            const result = await marked.parse(md)
            if (active) setHtml(result)
        }

        processContent()
        return () => { active = false }
    }, [content])

    return (
        <div className="markdown-viewer relative" key={activePath} ref={containerRef}>
            <SelectionToolbar containerRef={containerRef} onSendAction={handleSendSelection} />
            {Object.keys(frontmatter).length > 0 && (
                <div className="mb-6 rounded" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>
                    <button
                        onClick={() => setMetaOpen(!metaOpen)}
                        className="w-full text-left px-3 py-2 text-xs font-mono font-bold flex justify-between items-center"
                        style={{ color: 'var(--text-dim)', cursor: 'pointer' }}
                    >
                        <span>📄 METADATA</span>
                        <span>{metaOpen ? '▾' : '▸'}</span>
                    </button>

                    {metaOpen && (
                        <div className="px-3 pb-3 text-xs font-mono border-t" style={{ borderColor: 'var(--border)' }}>
                            <div className="grid grid-cols-1 gap-1 pt-2">
                                {Object.entries(frontmatter).map(([k, v]) => (
                                    <div key={k} className="flex">
                                        <span className="w-24 opacity-60" style={{ color: 'var(--accent-blue)' }}>{k}</span>
                                        <span className="truncate" style={{ color: 'var(--text-primary)' }}>{v as React.ReactNode}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}

            <div
                className="md-content"
                dangerouslySetInnerHTML={{ __html: html }}
            />
        </div>
    )
}
