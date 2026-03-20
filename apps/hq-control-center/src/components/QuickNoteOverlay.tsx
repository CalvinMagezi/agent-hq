import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Save, FileText } from 'lucide-react'
import { useRouter } from '@tanstack/react-router'
import { createNote, createNoteInFolder, getFolderList } from '../server/notes'

export function QuickNoteOverlay() {
    const [open, setOpen] = useState(false)
    const [title, setTitle] = useState('')
    const [content, setContent] = useState('')
    const [folder, setFolder] = useState('Notebooks/Inbox')
    const [folders, setFolders] = useState<string[]>(['Notebooks/Inbox'])
    const [saving, setSaving] = useState(false)
    const router = useRouter()

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            // Cmd+N or Ctrl+N to open
            if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
                e.preventDefault()
                setOpen(true)
            }
            if (e.key === 'Escape') setOpen(false)
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [])

    // Load folder list when overlay opens
    useEffect(() => {
        if (open) {
            getFolderList().then((res) => setFolders(res.folders))
        }
    }, [open])

    const handleSave = async () => {
        if (!title && !content) return
        setSaving(true)
        try {
            if (folder === 'Notebooks/Inbox') {
                await createNote({ data: { title, content } })
            } else {
                await createNoteInFolder({ data: { folder, title, content } })
            }
            setOpen(false)
            setTitle('')
            setContent('')
            setFolder('Notebooks/Inbox')
            router.invalidate()
        } catch (err) {
            console.error('Failed to create note', err)
        } finally {
            setSaving(false)
        }
    }

    return (
        <AnimatePresence>
            {open && (
                <>
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
                        onClick={() => setOpen(false)}
                    />
                    <motion.div
                        initial={{ opacity: 0, scale: 0.95, y: 20 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95, y: 20 }}
                        className="fixed z-50 w-full max-w-xl bg-slate-900 border border-slate-700/50 rounded-xl shadow-2xl overflow-hidden flex flex-col"
                        style={{
                            top: '50%',
                            left: '50%',
                            transform: 'translate(-50%, -50%)',
                            maxHeight: '80vh'
                        }}
                    >
                        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800 bg-slate-900/50">
                            <div className="flex items-center gap-2 text-slate-300">
                                <FileText className="w-4 h-4 text-emerald-500" />
                                <span className="text-sm font-semibold tracking-wide">Quick Note</span>
                            </div>
                            <button onClick={() => setOpen(false)} className="text-slate-500 hover:text-slate-300 transition-colors">
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        <div className="p-4 flex flex-col gap-4 flex-1 overflow-y-auto">
                            <div>
                                <input
                                    autoFocus
                                    type="text"
                                    placeholder="Note Title"
                                    value={title}
                                    onChange={e => setTitle(e.target.value)}
                                    className="w-full bg-slate-950/50 border border-slate-800 rounded-lg px-4 py-3 text-slate-200 outline-none focus:border-emerald-500/50 transition-colors font-medium"
                                />
                            </div>

                            {/* Folder picker */}
                            <div>
                                <select
                                    value={folder}
                                    onChange={e => setFolder(e.target.value)}
                                    className="w-full bg-slate-950/50 border border-slate-800 rounded-lg px-4 py-2.5 text-xs text-slate-400 outline-none focus:border-emerald-500/50 transition-colors font-mono"
                                >
                                    {folders.map(f => (
                                        <option key={f} value={f}>{f}</option>
                                    ))}
                                </select>
                            </div>

                            <div className="flex-1 min-h-[200px]">
                                <textarea
                                    placeholder="Start typing your note..."
                                    value={content}
                                    onChange={e => setContent(e.target.value)}
                                    className="w-full h-full min-h-[200px] bg-slate-950/50 border border-slate-800 rounded-lg px-4 py-3 text-sm text-slate-300 outline-none focus:border-emerald-500/50 transition-colors resize-none font-mono"
                                    onKeyDown={e => {
                                        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                                            e.preventDefault()
                                            handleSave()
                                        }
                                    }}
                                />
                            </div>
                        </div>

                        <div className="flex items-center justify-between px-4 py-3 border-t border-slate-800 bg-slate-900/50">
                            <div className="text-xs text-slate-500 font-mono flex items-center gap-2">
                                Save with <kbd className="bg-slate-800 px-1.5 rounded border border-slate-700">Cmd+Enter</kbd>
                            </div>
                            <button
                                onClick={handleSave}
                                disabled={saving || (!title && !content)}
                                className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                            >
                                {saving ? 'Saving...' : (
                                    <>
                                        <Save className="w-4 h-4" /> Save
                                    </>
                                )}
                            </button>
                        </div>
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    )
}
