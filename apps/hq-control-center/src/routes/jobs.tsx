import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { getJobs, getJobLogs } from '~/server/jobs'
import type { Job } from '~/server/jobs'

export const Route = createFileRoute('/jobs')({
  loader: () => getJobs(),
  component: JobsView,
})

const STATUS_COLOR: Record<Job['status'], string> = {
  running: 'var(--accent-green)',
  done: 'var(--accent-blue)',
  failed: 'var(--accent-red)',
  pending: 'var(--text-dim)',
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

function JobsView() {
  const { jobs } = Route.useLoaderData()
  const [selectedJob, setSelectedJob] = useState<Job | null>(null)
  const [logs, setLogs] = useState<string>('')
  const [loadingLogs, setLoadingLogs] = useState(false)

  const loadLogs = async (job: Job) => {
    setSelectedJob(job)
    setLoadingLogs(true)
    try {
      const result = await getJobLogs({ data: job.jobId })
      setLogs(result.content)
    } finally {
      setLoadingLogs(false)
    }
  }

  return (
    <div className="p-3 md:p-5 h-full overflow-y-auto dot-grid">
      <div className="max-w-[1400px] mx-auto">
        <p className="hq-section-title">Job Queue</p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 h-full">
          {/* Job list */}
          <div className="hq-panel overflow-hidden flex flex-col">
            <div
              className="px-4 py-2 border-b text-xs tracking-wider"
              style={{ borderColor: 'var(--border)', color: 'var(--text-dim)' }}
            >
              {jobs.length} jobs
            </div>
            <div className="flex-1 overflow-y-auto">
              {jobs.length === 0 ? (
                <div className="p-8 text-center" style={{ color: 'var(--text-dim)' }}>
                  <div className="text-2xl mb-2">⚙️</div>
                  <div className="text-xs tracking-wider">No jobs found</div>
                </div>
              ) : (
                jobs.map((job) => (
                  <button
                    key={job.jobId}
                    onClick={() => loadLogs(job)}
                    className="w-full text-left px-4 py-3 border-b transition-colors"
                    style={{
                      borderColor: 'var(--border)',
                      background:
                        selectedJob?.jobId === job.jobId
                          ? 'var(--bg-elevated)'
                          : 'transparent',
                    }}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className={STATUS_BADGE[job.status]}>{job.status}</span>
                      <span
                        className="text-xs truncate flex-1"
                        style={{ color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}
                      >
                        {job.jobId.slice(-12)}
                      </span>
                      <span className="text-xs" style={{ color: 'var(--text-dim)' }}>
                        {timeAgo(job.createdAt)}
                      </span>
                    </div>
                    <div
                      className="text-xs truncate"
                      style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}
                    >
                      {job.instruction || job.type}
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* Log viewer */}
          <div className="hq-panel flex flex-col overflow-hidden">
            <div
              className="px-4 py-2 border-b text-xs tracking-wider flex items-center justify-between"
              style={{ borderColor: 'var(--border)', color: 'var(--text-dim)' }}
            >
              <span>LOG VIEWER</span>
              {selectedJob && (
                <span style={{ color: STATUS_COLOR[selectedJob.status] }}>
                  {selectedJob.jobId.slice(-12)}
                </span>
              )}
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {!selectedJob ? (
                <div
                  className="text-xs"
                  style={{ color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}
                >
                  Select a job to view logs
                </div>
              ) : loadingLogs ? (
                <div
                  className="text-xs animate-pulse"
                  style={{ color: 'var(--accent-green)', fontFamily: 'var(--font-mono)' }}
                >
                  Loading logs...
                </div>
              ) : (
                <pre
                  className="text-xs whitespace-pre-wrap leading-relaxed"
                  style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}
                >
                  {logs}
                </pre>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
