import React from 'react'

interface WorkflowRun {
  runId: string
  teamName: string
  status: string
  startedAt: string
  completedAt: string
  durationMs: number
  stagesCompleted: number
  totalStages: number
  gateResults?: Record<string, string>
}

interface TeamRunMonitorProps {
  workflows: WorkflowRun[]
  selectedRunId?: string
  onSelectRun?: (runId: string) => void
}

const STATUS_META: Record<string, { icon: string; color: string }> = {
  completed: { icon: '✅', color: '#22c55e' },
  blocked: { icon: '🚫', color: '#f59e0b' },
  failed: { icon: '❌', color: '#ef4444' },
  running: { icon: '⏳', color: '#4488ff' },
}

const GATE_META: Record<string, { icon: string; color: string }> = {
  PASS: { icon: '✅', color: '#22c55e' },
  NEEDS_WORK: { icon: '🔄', color: '#f59e0b' },
  BLOCKED: { icon: '🚫', color: '#ef4444' },
}

function formatDuration(ms: number) {
  if (!ms) return '—'
  return ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60000)}m`
}

export function TeamRunMonitor({ workflows, selectedRunId, onSelectRun }: TeamRunMonitorProps) {
  const selected = workflows.find(w => w.runId === selectedRunId)

  return (
    <div className="flex gap-4 min-h-0" style={{ height: '100%' }}>
      {/* Run list */}
      <div
        className="w-72 flex-shrink-0 flex flex-col rounded-xl overflow-hidden"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
      >
        <div
          className="px-4 py-3 flex-shrink-0 border-b text-[10px] font-mono tracking-widest uppercase font-bold"
          style={{ borderColor: 'var(--border)', color: 'var(--text-dim)' }}
        >
          Recent Runs ({workflows.length})
        </div>

        <div className="flex-1 overflow-y-auto">
          {workflows.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs font-mono" style={{ color: 'var(--text-dim)' }}>
              No workflow runs yet.<br />Launch a team to get started.
            </div>
          ) : (
            workflows.map(run => {
              const meta = STATUS_META[run.status] ?? { icon: '⏳', color: '#6b7280' }
              const isSelected = selectedRunId === run.runId
              return (
                <button
                  key={run.runId}
                  onClick={() => onSelectRun?.(run.runId)}
                  className="w-full text-left px-4 py-3 border-b transition-colors"
                  style={{
                    borderColor: 'var(--border)',
                    background: isSelected ? 'rgba(68,136,255,0.08)' : 'transparent',
                    borderLeft: isSelected ? '3px solid var(--accent-blue)' : '3px solid transparent',
                  }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-mono font-bold truncate" style={{ color: meta.color }}>
                      {meta.icon} {run.teamName}
                    </span>
                    <span className="text-[9px] font-mono flex-shrink-0" style={{ color: 'var(--text-dim)' }}>
                      {formatDuration(run.durationMs)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between mt-1">
                    <span className="text-[9px] font-mono" style={{ color: 'var(--text-dim)' }}>
                      {run.stagesCompleted}/{run.totalStages} stages
                    </span>
                    <span className="text-[9px] font-mono" style={{ color: 'var(--text-dim)' }}>
                      {run.startedAt ? new Date(run.startedAt).toLocaleDateString() : ''}
                    </span>
                  </div>
                </button>
              )
            })
          )}
        </div>
      </div>

      {/* Detail pane */}
      <div
        className="flex-1 min-w-0 rounded-xl p-5 flex flex-col gap-4"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
      >
        {!selected ? (
          <div className="flex items-center justify-center h-full text-xs font-mono" style={{ color: 'var(--text-dim)' }}>
            Select a run to view details
          </div>
        ) : (
          <>
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-sm font-mono font-bold" style={{ color: 'var(--text-primary)' }}>
                  {selected.teamName}
                </div>
                <div className="text-[10px] font-mono mt-0.5" style={{ color: 'var(--text-dim)' }}>
                  {selected.runId}
                </div>
              </div>
              <div className="flex items-center gap-3 flex-shrink-0">
                <span
                  className="text-xs font-mono font-bold px-2 py-1 rounded-lg"
                  style={{
                    background: (STATUS_META[selected.status]?.color ?? '#6b7280') + '22',
                    color: STATUS_META[selected.status]?.color ?? '#6b7280',
                  }}
                >
                  {STATUS_META[selected.status]?.icon} {selected.status}
                </span>
                <span className="text-xs font-mono" style={{ color: 'var(--text-dim)' }}>
                  {selected.durationMs ? formatDuration(selected.durationMs) : 'Running…'}
                </span>
              </div>
            </div>

            {/* Stage progress */}
            <div>
              <div className="text-[10px] font-mono uppercase tracking-widest mb-2" style={{ color: 'var(--text-dim)' }}>
                Stage Progress — {selected.stagesCompleted}/{selected.totalStages}
              </div>
              <div className="flex gap-1">
                {Array.from({ length: selected.totalStages }).map((_, i) => (
                  <div
                    key={i}
                    title={`Stage ${i + 1}`}
                    className="flex-1 h-2 rounded-full transition-colors"
                    style={{
                      background: i < selected.stagesCompleted
                        ? 'var(--accent-green)'
                        : i === selected.stagesCompleted && selected.status === 'running'
                          ? 'var(--accent-blue)'
                          : 'var(--border)',
                    }}
                  />
                ))}
              </div>
            </div>

            {/* Gate results */}
            {selected.gateResults && Object.keys(selected.gateResults).length > 0 && (
              <div>
                <div className="text-[10px] font-mono uppercase tracking-widest mb-2" style={{ color: 'var(--text-dim)' }}>
                  Gate Results
                </div>
                <div className="flex flex-col gap-1.5">
                  {Object.entries(selected.gateResults).map(([gateId, outcome]) => {
                    const gm = GATE_META[outcome] ?? { icon: '❓', color: '#6b7280' }
                    return (
                      <div
                        key={gateId}
                        className="flex items-center justify-between px-3 py-2 rounded-lg"
                        style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
                      >
                        <span className="text-xs font-mono" style={{ color: 'var(--text-primary)' }}>{gateId}</span>
                        <span className="text-xs font-mono font-bold" style={{ color: gm.color }}>
                          {gm.icon} {outcome}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
