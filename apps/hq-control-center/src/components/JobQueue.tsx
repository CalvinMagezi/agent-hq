import type { Job } from '~/server/jobs'
import { useHQStore } from '~/store/hqStore'

interface Props {
  jobs: Job[]
}

const STATUS_BADGE: Record<Job['status'], string> = {
  running: 'badge badge-running',
  done: 'badge badge-done',
  failed: 'badge badge-failed',
  pending: 'badge badge-pending',
}

function timeAgo(iso: string) {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export function JobQueue({ jobs }: Props) {
  const setSelectedJobId = useHQStore(s => s.setSelectedJobId)
  const recent = jobs.slice(0, 12)

  return (
    <div className="hq-panel flex flex-col h-full overflow-hidden">
      <div
        className="flex items-center justify-between px-4 py-2 border-b"
        style={{ borderColor: 'var(--border)' }}
      >
        <span className="hq-section-title mb-0">Job Queue</span>
        <span className="text-xs" style={{ color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
          {jobs.filter((j) => j.status === 'running').length} running
        </span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {recent.length === 0 ? (
          <div className="p-6 text-center" style={{ color: 'var(--text-dim)' }}>
            <div className="text-2xl mb-2">✓</div>
            <div className="text-xs tracking-wider">Queue is empty</div>
          </div>
        ) : (
          recent.map((job) => (
            <div
              key={job.jobId}
              onClick={() => setSelectedJobId(job.jobId)}
              className="px-4 py-2 border-b flex items-start gap-3 cursor-pointer hover:bg-white/5 transition-colors"
              style={{ borderColor: 'var(--border)' }}
            >
              <span className={STATUS_BADGE[job.status]}>{job.status}</span>
              <div className="flex-1 min-w-0">
                <div
                  className="text-xs truncate"
                  style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}
                >
                  {job.instruction || job.type}
                </div>
                <div
                  className="text-xs mt-0.5"
                  style={{ color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}
                >
                  {job.jobId.slice(-10)}
                </div>
              </div>
              <span
                className="text-xs flex-shrink-0"
                style={{ color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}
              >
                {timeAgo(job.createdAt)}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
