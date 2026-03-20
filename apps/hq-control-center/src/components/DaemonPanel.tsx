import type { DaemonTask } from '~/server/daemon'

interface Props {
  tasks: DaemonTask[]
}

const STATUS_ICON: Record<DaemonTask['status'], string> = {
  ok: '✓',
  warn: '⚠',
  error: '✗',
}

const STATUS_COLOR: Record<DaemonTask['status'], string> = {
  ok: 'var(--accent-green)',
  warn: 'var(--accent-amber)',
  error: 'var(--accent-red)',
}

function timeAgo(iso: string) {
  if (!iso || iso === '-' || iso === 'never') return iso || '—'
  try {
    const diff = Date.now() - new Date(iso).getTime()
    const m = Math.floor(diff / 60000)
    if (m < 1) return 'just now'
    if (m < 60) return `${m}m ago`
    const h = Math.floor(m / 60)
    if (h < 24) return `${h}h ago`
    return `${Math.floor(h / 24)}d ago`
  } catch {
    return iso
  }
}

export function DaemonPanel({ tasks }: Props) {
  return (
    <div className="hq-panel p-4 h-full overflow-hidden flex flex-col">
      <div className="hq-section-title">Daemon Tasks</div>
      <div className="flex-1 overflow-y-auto space-y-0.5">
        {tasks.length === 0 ? (
          <div className="text-xs py-4 text-center" style={{ color: 'var(--text-dim)' }}>
            No daemon status found
          </div>
        ) : (
          tasks.map((task, i) => (
            <div
              key={i}
              className="flex items-center gap-2 py-1.5 px-2 rounded-sm"
              style={{
                background: task.status === 'error' ? 'rgba(255,68,68,0.06)' : 'transparent',
              }}
            >
              <span
                className="w-4 text-center flex-shrink-0 font-bold"
                style={{ fontSize: 11, color: STATUS_COLOR[task.status] }}
              >
                {STATUS_ICON[task.status]}
              </span>
              <span
                className="flex-1 text-xs truncate"
                style={{
                  color: task.status === 'error' ? 'var(--accent-red)' : 'var(--text-primary)',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                {task.task}
              </span>
              <span className="text-xs flex-shrink-0" style={{ color: 'var(--text-dim)', fontSize: 10 }}>
                {timeAgo(task.lastRun)}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
