import { createServerFn } from '@tanstack/react-start'
import * as fs from 'node:fs'
import * as path from 'node:path'
import matter from 'gray-matter'
import { VAULT_PATH } from './vault'

export interface PinnedNote {
  title: string
  path: string
  preview: string
  tags: string[]
  updatedAt?: string
}

export interface NoteTreeNode {
  name: string
  path: string
  type: 'dir' | 'file'
  children?: NoteTreeNode[]
}

export const getPinnedNotes = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{ notes: PinnedNote[] }> => {
    const notes: PinnedNote[] = []
    const notebooksDir = path.join(VAULT_PATH, 'Notebooks')
    if (!fs.existsSync(notebooksDir)) return { notes }

    const walk = (dir: string) => {
      if (notes.length >= 50) return // cap scan at 50 pinned notes
      let entries: fs.Dirent[]
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(fullPath)
        } else if (entry.name.endsWith('.md')) {
          try {
            const raw = fs.readFileSync(fullPath, 'utf-8')
            const { data, content } = matter(raw)
            if (data.pinned === true || data.pinned === 'true') {
              const stat = fs.statSync(fullPath)
              const preview = content.replace(/^#+\s+.*/gm, '').replace(/\[\[.*?\]\]/g, '').trim().slice(0, 180)
              notes.push({
                title: data.title ?? entry.name.replace(/\.md$/, ''),
                path: path.relative(VAULT_PATH, fullPath),
                preview,
                tags: Array.isArray(data.tags) ? data.tags : [],
                updatedAt: stat.mtime.toISOString(),
              })
            }
          } catch { /* skip unreadable files */ }
        }
      }
    }

    walk(notebooksDir)
    notes.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
    return { notes }
  }
)

export interface RecentFile {
  path: string
  title: string
  preview: string
  tags: string[]
  mtime: string
  size: number
}

export const getRecentFiles = createServerFn({ method: 'GET' })
  .handler(async (): Promise<{ files: RecentFile[] }> => {
    const files: RecentFile[] = []
    const ROOTS = ['Notebooks', '_system', '_logs']

    const walk = (dir: string) => {
      if (files.length >= 2000) return // Cap scan at 2000 files
      let entries: fs.Dirent[]
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }

      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '_embeddings') continue

        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(fullPath)
        } else if (entry.name.endsWith('.md')) {
          try {
            const stat = fs.statSync(fullPath)
            const raw = fs.readFileSync(fullPath, 'utf-8')
            const { data, content } = matter(raw)

            const preview = content.replace(/^#+\s+.*/gm, '').replace(/\[\[.*?\]\]/g, '').trim().slice(0, 150)

            files.push({
              path: path.relative(VAULT_PATH, fullPath),
              title: data.title ?? entry.name.replace(/\.md$/, ''),
              preview,
              tags: Array.isArray(data.tags) ? data.tags : [],
              mtime: stat.mtime.toISOString(),
              size: stat.size
            })
          } catch { /* skip unreadable files */ }
        }
      }
    }

    for (const root of ROOTS) {
      const rootDir = path.join(VAULT_PATH, root)
      if (fs.existsSync(rootDir)) walk(rootDir)
    }

    files.sort((a, b) => b.mtime.localeCompare(a.mtime))
    return { files: files.slice(0, 20) }
  })

export interface SearchHit {
  notePath: string
  title: string
  notebook: string
  snippet: string
  tags: string[]
  relevance: number
  matchType: 'keyword'
}

export const searchNotes = createServerFn({ method: 'GET' })
  .inputValidator((q: string) => q)
  .handler(async ({ data: query }): Promise<{ results: SearchHit[] }> => {
    if (!query.trim()) return { results: [] }

    const results: SearchHit[] = []
    const q = query.toLowerCase()
    const ROOTS = ['Notebooks', '_system', '_logs']
    const MAX_RESULTS = 30
    const MAX_CONTENT_BYTES = 8 * 1024

    const walk = (dir: string, notebook: string) => {
      if (results.length >= MAX_RESULTS) return
      let entries: fs.Dirent[]
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        if (results.length >= MAX_RESULTS) break
        if (entry.name.startsWith('.')) continue
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) { walk(fullPath, notebook); continue }
        const ext = path.extname(entry.name).toLowerCase()
        const isText = ['.md', '.txt', '.ts', '.js', '.json', '.yaml', '.yml', '.sh', '.csv'].includes(ext)
        if (!isText) continue

        const relPath = path.relative(VAULT_PATH, fullPath)
        let relevance = 0
        let snippet = ''
        let title = entry.name.replace(/\.md$/, '')
        let tags: string[] = []

        if (entry.name.toLowerCase().includes(q)) relevance += 10

        try {
          const stat = fs.statSync(fullPath)
          if (stat.size <= 500 * 1024) {
            const fd = fs.openSync(fullPath, 'r')
            const buf = Buffer.alloc(Math.min(stat.size, MAX_CONTENT_BYTES))
            const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0)
            fs.closeSync(fd)
            const head = buf.toString('utf-8', 0, bytesRead)

            if (ext === '.md') {
              const fmMatch = head.match(/^---\n([\s\S]*?)\n---/)
              if (fmMatch) {
                const fm = fmMatch[1]
                const titleMatch = fm.match(/^title:\s*(.+)$/m)
                if (titleMatch) title = titleMatch[1].trim().replace(/^['"]|['"]$/g, '')
                const tagsMatch = fm.match(/^tags:\s*\[([^\]]*)\]/m)
                if (tagsMatch) tags = tagsMatch[1].split(',').map(t => t.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
              }
            }

            const lower = head.toLowerCase()
            const idx = lower.indexOf(q)
            if (idx !== -1) {
              relevance += 5
              const start = Math.max(0, idx - 60)
              const end = Math.min(head.length, idx + q.length + 120)
              snippet = head.slice(start, end).replace(/\n+/g, ' ').trim()
              if (start > 0) snippet = '...' + snippet
              if (end < head.length) snippet += '...'
            }
          }
        } catch { continue }

        if (relevance > 0) {
          results.push({ notePath: relPath, title, notebook, snippet, tags, relevance, matchType: 'keyword' })
        }
      }
    }

    for (const root of ROOTS) {
      const rootDir = path.join(VAULT_PATH, root)
      if (fs.existsSync(rootDir)) walk(rootDir, root)
    }

    results.sort((a, b) => b.relevance - a.relevance)
    return { results }
  })

export const getNoteTree = createServerFn({ method: 'GET' })
  .inputValidator((root?: string) => root ?? 'Notebooks')
  .handler(async ({ data: root }): Promise<{ tree: NoteTreeNode }> => {
    const rootDir = path.join(VAULT_PATH, root)
    const tree: NoteTreeNode = { name: root, path: root, type: 'dir', children: [] }

    const buildTree = (dir: string, node: NoteTreeNode) => {
      if (!fs.existsSync(dir)) return
      const entries = fs.readdirSync(dir, { withFileTypes: true })

      // Sort directories first, then alphabetically
      const sortedEntries = entries.sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1
        if (!a.isDirectory() && b.isDirectory()) return 1
        return a.name.localeCompare(b.name)
      })

      for (const entry of sortedEntries) {
        if (entry.name.startsWith('.')) continue
        const fullPath = path.join(dir, entry.name)
        const relativePath = path.relative(VAULT_PATH, fullPath)

        if (entry.isDirectory()) {
          const child: NoteTreeNode = { name: entry.name, path: relativePath, type: 'dir', children: [] }
          node.children!.push(child)
          buildTree(fullPath, child)
        } else {
          node.children!.push({ name: entry.name, path: relativePath, type: 'file' })
        }
      }
    }

    buildTree(rootDir, tree)
    return { tree }
  })

export const getNote = createServerFn({ method: 'GET' })
  .inputValidator((notePath: string) => notePath)
  .handler(async ({ data: notePath }): Promise<{ content: string }> => {
    const fullPath = path.resolve(VAULT_PATH, notePath)
    const resolvedVault = path.resolve(VAULT_PATH)
    if ((!fullPath.startsWith(resolvedVault + path.sep) && fullPath !== resolvedVault) || !fs.existsSync(fullPath)) return { content: '' }

    // Try reading as text if file is small enough
    const stat = fs.statSync(fullPath)
    if (stat.isDirectory()) return { content: '' }

    const ext = path.extname(fullPath).toLowerCase()
    const isText = ['.md', '.json', '.ts', '.js', '.sh', '.yaml', '.yml', '.env', '.txt', '.csv', '.log'].includes(ext)

    if (!isText && stat.size > 1024 * 1024) return { content: '' } // Don't even try reading large non-text as string

    if (stat.size > 500 * 1024) {
      // Large file: read first 500KB
      const fd = fs.openSync(fullPath, 'r')
      const buffer = Buffer.alloc(500 * 1024)
      const bytesRead = fs.readSync(fd, buffer, 0, 500 * 1024, 0)
      fs.closeSync(fd)
      return { content: buffer.toString('utf-8', 0, bytesRead) + '\n\n...[TRUNCATED: File exceeds 500KB]...' }
    }

    try {
      return { content: fs.readFileSync(fullPath, 'utf-8') }
    } catch {
      return { content: '' }
    }
  })

interface TogglePinParams {
  path: string
  pinned: boolean
}

export const togglePinNote = createServerFn({ method: 'POST' })
  .inputValidator((d: TogglePinParams) => d)
  .handler(async ({ data }): Promise<{ success: boolean }> => {
    const fullPath = path.resolve(VAULT_PATH, data.path)
    const resolvedVault = path.resolve(VAULT_PATH)
    if (!fullPath.startsWith(resolvedVault + path.sep)) return { success: false }
    if (!fs.existsSync(fullPath) || !fullPath.endsWith('.md')) return { success: false }

    const raw = fs.readFileSync(fullPath, 'utf-8')
    const parsed = matter(raw)
    parsed.data.pinned = data.pinned
    if (!parsed.data.updatedAt) parsed.data.updatedAt = new Date().toISOString()
    const updated = matter.stringify(parsed.content, parsed.data)
    fs.writeFileSync(fullPath, updated, 'utf-8')
    return { success: true }
  })

interface CreateNoteParams {
  title: string
  content: string
}

export const createNote = createServerFn({ method: 'POST' })
  .inputValidator((d: CreateNoteParams) => d)
  .handler(async ({ data }): Promise<{ success: boolean; path: string }> => {
    const inboxDir = path.join(VAULT_PATH, 'Notebooks/Inbox')
    if (!fs.existsSync(inboxDir)) {
      fs.mkdirSync(inboxDir, { recursive: true })
    }

    const safeTitle = data.title.replace(/[^a-z0-9 _-]/ig, '').trim() || 'Untitled'
    let filename = `${safeTitle}.md`
    let fullPath = path.join(inboxDir, filename)

    let i = 1
    while (fs.existsSync(fullPath)) {
      filename = `${safeTitle} ${i}.md`
      fullPath = path.join(inboxDir, filename)
      i++
    }

    fs.writeFileSync(fullPath, data.content, 'utf-8')
    return { success: true, path: `Notebooks/Inbox/${filename}` }
  })
