import React, { useState } from 'react'
import type { AgentSummary } from '../server/teams'

interface AgentCardProps {
  agent: AgentSummary
  onDragStart?: (agentName: string) => void
  compact?: boolean
}

const VERTICAL_COLORS: Record<string, string> = {
  engineering: '#3b82f6',
  qa: '#f59e0b',
  research: '#8b5cf6',
  content: '#06b6d4',
  ops: '#ef4444',
}

const HARNESS_ICONS: Record<string, string> = {
  'claude-code': '🤖',
  opencode: '⚡',
  'gemini-cli': '♊',
  any: '🔀',
}

export function AgentCard({ agent, onDragStart, compact = false }: AgentCardProps) {
  const [expanded, setExpanded] = useState(false)
  const color = VERTICAL_COLORS[agent.vertical] ?? '#6b7280'
  const harnessIcon = HARNESS_ICONS[agent.preferredHarness] ?? '🤖'
  const successRate = agent.performanceProfile?.targetSuccessRate

  return (
    <div
      draggable={!!onDragStart}
      onDragStart={() => onDragStart?.(agent.name)}
      onClick={() => !compact && setExpanded(e => !e)}
      title={agent.name}
      className={`rounded-lg p-3 transition-all cursor-default ${compact ? '' : 'cursor-pointer hover:opacity-90'}`}
      style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderLeft: `4px solid ${color}`,
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-base leading-none flex-shrink-0">{harnessIcon}</span>
          <span className="text-xs font-mono font-bold truncate" style={{ color: 'var(--text-primary)' }}>
            {agent.displayName}
          </span>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {successRate !== undefined && (
            <span
              className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded"
              style={{
                background: successRate >= 0.85 ? '#22c55e22' : successRate >= 0.7 ? '#f59e0b22' : '#ef444422',
                color: successRate >= 0.85 ? '#22c55e' : successRate >= 0.7 ? '#f59e0b' : '#ef4444',
              }}
            >
              {Math.round(successRate * 100)}%
            </span>
          )}
          {agent.defaultsTo && (
            <span
              className="text-[9px] font-mono px-1.5 py-0.5 rounded uppercase tracking-wide"
              style={{ background: 'rgba(255,255,255,0.06)', color: 'var(--text-dim)' }}
            >
              {agent.defaultsTo}
            </span>
          )}
        </div>
      </div>

      {!compact && (
        <div className="flex items-center gap-2 mt-2">
          <span
            className="text-[9px] font-mono px-1.5 py-0.5 rounded uppercase tracking-wide font-bold"
            style={{ background: color + '22', color }}
          >
            {agent.vertical}
          </span>
          <span className="text-[10px] font-mono" style={{ color: 'var(--text-dim)' }}>
            {agent.baseRole}
          </span>
        </div>
      )}

      {!compact && expanded && agent.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {agent.tags.slice(0, 5).map(tag => (
            <span
              key={tag}
              className="text-[9px] font-mono px-1.5 py-0.5 rounded"
              style={{ background: 'rgba(0,255,136,0.08)', color: 'var(--accent-green)' }}
            >
              #{tag}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
