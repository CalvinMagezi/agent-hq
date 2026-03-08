import { useHQStore } from '../store/hqStore'
import type { Job } from '../server/jobs'
import { motion } from 'framer-motion'

interface Props {
    jobs: Job[]
}

const STATUS_COLORS: Record<Job['status'], string> = {
    running: 'bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,0.8)]',
    done: 'bg-emerald-500',
    failed: 'bg-rose-500',
    pending: 'bg-amber-500',
}

export function JobTimeline({ jobs }: Props) {
    const setSelectedJobId = useHQStore(s => s.setSelectedJobId)

    // sort chronological for timeline left to right
    const sorted = [...jobs].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())

    // Limit to last 100 for performance and visual clarity
    const displayJobs = sorted.slice(-100)

    return (
        <div className="hq-panel p-4 overflow-hidden mb-4">
            <div className="flex justify-between items-center mb-2">
                <h2 className="text-[10px] text-slate-500 font-mono uppercase tracking-wider mb-0">Job History Timeline</h2>
                <span className="text-xs text-slate-500 font-mono tracking-widest">{Math.min(jobs.length, 100)} Recent</span>
            </div>
            <div className="relative w-full h-16 flex items-center overflow-x-auto overflow-y-hidden 
        [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-thumb]:bg-slate-700 [&::-webkit-scrollbar-track]:bg-transparent pb-3">
                {/* Horizontal Line background */}
                <div className="absolute top-1/2 left-0 right-0 h-0.5 bg-slate-800 -translate-y-1/2 z-0 opacity-50" />

                <div className="flex items-center gap-3 px-4 z-10 min-w-max h-full">
                    {displayJobs.map(job => (
                        <motion.div
                            key={job.jobId}
                            whileHover={{ scale: 1.6 }}
                            className={`w-3 h-3 rounded-full cursor-pointer shrink-0 border border-slate-900 ${STATUS_COLORS[job.status]}`}
                            title={`${new Date(job.createdAt).toLocaleTimeString()} - ${job.status}: ${job.instruction || job.type}`}
                            onClick={() => setSelectedJobId(job.jobId)}
                        />
                    ))}
                    {displayJobs.length === 0 && (
                        <span className="text-xs text-slate-500 font-mono bg-slate-900/80 px-2 relative z-10">No recent jobs</span>
                    )}
                </div>
            </div>
        </div>
    )
}
