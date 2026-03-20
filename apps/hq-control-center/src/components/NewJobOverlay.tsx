import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Play, Command } from 'lucide-react'
import { useRouter } from '@tanstack/react-router'
import { useHQStore } from '../store/hqStore'
import { createJob } from '../server/jobs'

export function NewJobOverlay() {
    const [open, setOpen] = useState(false)
    const [instruction, setInstruction] = useState('')
    const [type, setType] = useState('custom')
    const [priority, setPriority] = useState(50)
    const [submitting, setSubmitting] = useState(false)
    const router = useRouter()
    const setSelectedJobId = useHQStore(s => s.setSelectedJobId)

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            // Cmd+J or Ctrl+J to open New Job
            if ((e.metaKey || e.ctrlKey) && e.key === 'j') {
                e.preventDefault()
                setOpen(true)
            }
            if (e.key === 'Escape') setOpen(false)
        }
        const onCustomEvent = () => setOpen(true)

        window.addEventListener('keydown', onKeyDown)
        window.addEventListener('openNewJob', onCustomEvent)
        return () => {
            window.removeEventListener('keydown', onKeyDown)
            window.removeEventListener('openNewJob', onCustomEvent)
        }
    }, [])

    const handleSubmit = async () => {
        if (!instruction.trim()) return
        setSubmitting(true)
        try {
            const res = await createJob({ data: { instruction, type, priority } })
            setOpen(false)
            setInstruction('')
            setType('custom')
            setPriority(50)
            router.invalidate() // refresh job queue
            if (res.success) {
                // Auto-select the newly created job detail drawer
                setTimeout(() => setSelectedJobId(res.jobId), 100)
            }
        } catch (err) {
            console.error('Failed to create job', err)
        } finally {
            setSubmitting(false)
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
                        className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
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
                            maxHeight: '90vh'
                        }}
                    >
                        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800 bg-slate-900/50">
                            <div className="flex items-center gap-2 text-slate-300">
                                <Command className="w-4 h-4 text-indigo-400" />
                                <span className="text-sm font-semibold tracking-wide">Submit New Job</span>
                                <span className="text-xs text-slate-500 font-mono ml-2 border border-slate-700 rounded px-1.5 py-0.5">_fbmq/jobs</span>
                            </div>
                            <button onClick={() => setOpen(false)} className="text-slate-500 hover:text-slate-300 transition-colors">
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        <div className="p-4 flex flex-col gap-4 flex-1 overflow-y-auto">
                            <div className="flex gap-4">
                                <div className="flex flex-col flex-1 gap-1">
                                    <label className="text-[10px] text-slate-500 font-mono uppercase tracking-wider">Job Type</label>
                                    <select
                                        value={type}
                                        onChange={e => setType(e.target.value)}
                                        className="w-full bg-slate-950/50 border border-slate-800 rounded-lg px-3 py-2.5 text-slate-300 outline-none focus:border-indigo-500/50 transition-colors font-mono text-sm"
                                    >
                                        <option value="custom">custom</option>
                                        <option value="research">research</option>
                                        <option value="coding">coding</option>
                                        <option value="data_processing">data_processing</option>
                                    </select>
                                </div>
                                <div className="flex flex-col flex-1 gap-1">
                                    <label className="text-[10px] text-slate-500 font-mono uppercase tracking-wider">Priority (0-100)</label>
                                    <input
                                        type="number"
                                        min="0" max="100"
                                        value={priority}
                                        onChange={e => setPriority(parseInt(e.target.value) || 50)}
                                        className="w-full bg-slate-950/50 border border-slate-800 rounded-lg px-3 py-2 text-slate-300 outline-none focus:border-indigo-500/50 transition-colors font-mono text-sm"
                                    />
                                </div>
                            </div>

                            <div className="flex flex-col gap-1 flex-1 min-h-[200px]">
                                <label className="text-[10px] text-slate-500 font-mono uppercase tracking-wider">Instruction</label>
                                <textarea
                                    autoFocus
                                    placeholder="What should the agent do...?"
                                    value={instruction}
                                    onChange={e => setInstruction(e.target.value)}
                                    className="w-full h-full min-h-[200px] bg-slate-950/50 border border-slate-800 rounded-lg px-4 py-3 text-sm text-slate-300 outline-none focus:border-indigo-500/50 transition-colors resize-none font-mono"
                                    onKeyDown={e => {
                                        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                                            e.preventDefault()
                                            handleSubmit()
                                        }
                                    }}
                                />
                            </div>
                        </div>

                        <div className="flex items-center justify-between px-4 py-3 border-t border-slate-800 bg-slate-900/50">
                            <div className="text-xs text-slate-500 font-mono flex items-center gap-2">
                                Submit with <kbd className="bg-slate-800 px-1.5 rounded border border-slate-700">Cmd+Enter</kbd>
                            </div>
                            <button
                                onClick={handleSubmit}
                                disabled={submitting || !instruction.trim()}
                                className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors shadow-[0_0_10px_rgba(79,70,229,0.2)]"
                            >
                                {submitting ? 'Submitting...' : (
                                    <>
                                        <Play className="w-4 h-4 fill-white" /> Dispatch Job
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
