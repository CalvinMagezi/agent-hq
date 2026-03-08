import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react' // eslint-disable-line @typescript-eslint/no-unused-vars
import { createNote } from '~/server/notes'

export const Route = createFileRoute('/share')({
  validateSearch: (search: Record<string, unknown>) => ({
    title: String(search.title ?? ''),
    text: String(search.text ?? ''),
    url: String(search.url ?? ''),
  }),
  component: SharePage,
})

function SharePage() {
  const { title, text, url } = Route.useSearch()
  const [status, setStatus] = useState<'saving' | 'done' | 'error'>('saving')
  const [notePath, setNotePath] = useState('')

  useEffect(() => {
    const noteTitle = title || (url ? new URL(url).hostname : 'Shared Note')

    const lines: string[] = []
    if (text) lines.push(text)
    if (url) lines.push(`\n**Source:** ${url}`)

    const content = `---\ntags: [inbox, shared]\npinned: false\n---\n\n${lines.join('\n')}`

    createNote({ data: { title: noteTitle, content } })
      .then((res) => {
        setNotePath(res.path)
        setStatus('done')
        setTimeout(() => { window.location.href = '/notes' }, 2000)
      })
      .catch(() => setStatus('error'))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className="flex flex-col items-center justify-center h-full gap-6 p-8"
      style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}
    >
      {status === 'saving' && (
        <>
          <div className="w-10 h-10 rounded-full border-2 border-t-transparent animate-spin" style={{ borderColor: 'var(--accent-green)', borderTopColor: 'transparent' }} />
          <p className="font-mono text-sm" style={{ color: 'var(--text-dim)' }}>Saving to vault...</p>
        </>
      )}

      {status === 'done' && (
        <>
          <div className="text-4xl">✅</div>
          <div className="text-center">
            <p className="font-bold mb-1">Saved to Vault</p>
            <p className="text-xs font-mono" style={{ color: 'var(--text-dim)' }}>{notePath}</p>
          </div>
          <p className="text-xs" style={{ color: 'var(--text-dim)' }}>Redirecting to notes…</p>
        </>
      )}

      {status === 'error' && (
        <>
          <div className="text-4xl">❌</div>
          <p className="font-bold">Failed to save</p>
          <button
            onClick={() => { window.location.href = '/' }}
            className="px-4 py-2 rounded-lg text-sm font-mono"
            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
          >
            Go Home
          </button>
        </>
      )}
    </div>
  )
}
