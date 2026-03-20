import { useEffect, useState, useRef } from 'react'
import { marked } from 'marked'
import { createHighlighter } from 'shiki'
import { SelectionToolbar } from './SelectionToolbar'
import { useHQStore } from '~/store/hqStore'

// Initialize shiki once at module level — trimmed to most common vault languages
const highlighterPromise: Promise<any> = createHighlighter({
    themes: ['vitesse-dark'],
    langs: ['javascript', 'typescript', 'tsx', 'json', 'bash', 'yaml', 'markdown', 'python'],
})

// Configure marked renderer once at module level (not per-component-render)
let markedConfigured = false
async function ensureMarkedConfigured() {
    if (markedConfigured) return
    markedConfigured = true
    const highlighter = await highlighterPromise
    marked.use({
        renderer: {
            code(token: any) {
                const langLabel = token.lang || ''
                const escaped = JSON.stringify(token.text)
                let highlighted: string
                try {
                    highlighted = highlighter.codeToHtml(token.text, { lang: token.lang || 'text', theme: 'vitesse-dark' })
                } catch {
                    highlighted = `<pre><code>${token.text}</code></pre>`
                }
                return `<div class="code-block-wrapper">${langLabel ? `<div class="code-block-header">${langLabel}</div>` : ''}<button class="code-copy-btn" onclick="navigator.clipboard.writeText(${escaped}).then(function(){this.textContent='Copied!';var b=this;setTimeout(function(){b.textContent='Copy'},1500)}.bind(this))">Copy</button>${highlighted}</div>`
            },
            heading(token: any) {
                return `<h${token.depth} class="md-heading md-h${token.depth}">${token.text}</h${token.depth}>`
            },
            blockquote(token: any) {
                return `<blockquote class="md-blockquote">${token.text}</blockquote>`
            },
            link(token: any) {
                return `<a href="${token.href}" class="md-link" target="_blank" rel="noopener noreferrer">${token.text}</a>`
            },
            table(token: any) {
                const headerCells = token.header.map((cell: any) =>
                    `<th class="md-th">${cell.text}</th>`
                ).join('')
                const rows = token.rows.map((row: any, i: number) =>
                    `<tr class="${i % 2 === 0 ? 'md-tr-even' : 'md-tr-odd'}">${
                        row.map((cell: any) => `<td class="md-td">${cell.text}</td>`).join('')
                    }</tr>`
                ).join('')
                return `<div class="md-table-wrap"><table class="md-table"><thead><tr>${headerCells}</tr></thead><tbody>${rows}</tbody></table></div>`
            }
        }
    })
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

            // 2. Ensure marked renderer is configured (only runs once globally)
            await ensureMarkedConfigured()

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
