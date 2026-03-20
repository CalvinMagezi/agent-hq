import { useEffect, useState, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useHQStore } from '~/store/hqStore'
import { getJobLogs } from '~/server/jobs'

export function JobDrawer() {
    const { selectedJobId, setSelectedJobId, jobs } = useHQStore()
    const job = jobs.find(j => j.jobId === selectedJobId)

    const [logs, setLogs] = useState<string>('')
    const [loading, setLoading] = useState(false)
    const logEndRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (!selectedJobId) return
        let active = true

        const fetchLogs = async () => {
            setLoading(true)
            try {
                const res = await getJobLogs({ data: selectedJobId })
                if (active) setLogs(res.content)
            } catch (e) {
                if (active) setLogs('Failed to load logs.')
            } finally {
                if (active) setLoading(false)
            }
        }

        fetchLogs()

        const isRunning = job?.status === 'running'
        let timer: NodeJS.Timeout | undefined
        if (isRunning) {
            timer = setInterval(fetchLogs, 5000)
        }

        return () => {
            active = false
            if (timer) clearInterval(timer)
        }
    }, [selectedJobId, job?.status])

    useEffect(() => {
        if (logEndRef.current) {
            logEndRef.current.scrollIntoView({ behavior: 'smooth' })
        }
    }, [logs])

    return (
        <AnimatePresence>
            {selectedJobId && job && (
                <>
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 z-40 backdrop-blur-sm"
                        style={{ background: 'rgba(0,0,0,0.5)' }}
                        onClick={() => setSelectedJobId(null)}
                    />
                    <motion.div
                        initial={{ y: '100%' }}
                        animate={{ y: 0 }}
                        exit={{ y: '100%' }}
                        transition={{ type: 'spring', damping: 25, stiffness: 200 }}
                        className="fixed bottom-0 left-0 right-0 h-[85dvh] border-t z-50 rounded-t-xl flex flex-col mx-auto max-w-4xl"
                        style={{ background: 'var(--bg-surface)', borderColor: 'var(--border)' }}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="p-4 border-b flex justify-between items-center rounded-t-xl flex-shrink-0" style={{ borderColor: 'var(--border)', background: 'var(--bg-elevated)' }}>
                            <div>
                                <h2 className="text-sm font-mono font-bold" style={{ color: 'var(--text-primary)' }}>Job: {job.jobId}</h2>
                                <div className="flex gap-2 mt-2">
                                    <span className={`badge badge-${job.status}`}>{job.status}</span>
                                    <span className="badge badge-pending">Type: {job.type}</span>
                                    <span className="badge badge-pending">Priority: {job.priority}</span>
                                </div>
                            </div>
                            <button
                                onClick={() => setSelectedJobId(null)}
                                className="p-2 transition-colors font-mono font-bold text-lg hover:opacity-100 opacity-60 flex-shrink-0"
                                style={{ color: 'var(--text-dim)' }}
                            >
                                ✕
                            </button>
                        </div>

                        <div className="p-4 border-b flex-shrink-0" style={{ borderColor: 'var(--border)' }}>
                            <h3 className="text-xs font-mono tracking-widest uppercase mb-2" style={{ color: 'var(--text-dim)' }}>Instruction</h3>
                            <p className="text-sm font-mono whitespace-pre-wrap" style={{ color: 'var(--text-primary)' }}>{job.instruction}</p>
                        </div>

                        <div className="flex-1 overflow-auto p-4 relative" style={{ background: '#0a0a0f' }}>
                            <h3 className="text-xs font-mono tracking-widest uppercase mb-2 sticky top-0 p-1 z-10" style={{ background: 'rgba(10,10,15,0.9)', color: 'var(--text-dim)' }}>Execution Log</h3>
                            {loading && !logs && (
                                <div className="text-xs font-mono animate-pulse" style={{ color: 'var(--text-dim)' }}>Loading logs...</div>
                            )}
                            <pre className="text-[11px] font-mono whitespace-pre-wrap leading-relaxed pb-8" style={{ color: 'var(--accent-green)' }}>
                                {logs}
                            </pre>
                            <div ref={logEndRef} className="h-4" />
                        </div>
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    )
}
