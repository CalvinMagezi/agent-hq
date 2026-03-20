import React, { useState, useCallback } from 'react'
import type { AgentSummary } from '../server/teams'
import { AgentCard } from './AgentCard'

interface Stage {
  stageId: string
  pattern: 'sequential' | 'parallel' | 'gated'
  agents: string[]
  description: string
}

interface TeamBuilderProps {
  agents: AgentSummary[]
  onSave: (team: any) => void
  onLaunch: (team: any, instruction: string) => void
}

const inputStyle = {
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border)',
  color: 'var(--text-primary)',
  fontFamily: 'var(--font-mono)',
  borderRadius: 8,
  padding: '8px 12px',
  fontSize: 12,
  width: '100%',
  outline: 'none',
}

const PATTERN_COLORS: Record<string, string> = {
  sequential: '#4488ff',
  parallel: '#00ff88',
  gated: '#ffb300',
}

export function TeamBuilder({ agents, onSave, onLaunch }: TeamBuilderProps) {
  const [teamName, setTeamName] = useState('')
  const [teamDisplayName, setTeamDisplayName] = useState('')
  const [stages, setStages] = useState<Stage[]>([
    { stageId: 'stage-1', pattern: 'sequential', agents: [], description: 'Stage 1' },
  ])
  const [filterVertical, setFilterVertical] = useState<string>('all')
  const [draggingAgent, setDraggingAgent] = useState<string | null>(null)
  const [instruction, setInstruction] = useState('')
  const [showLaunch, setShowLaunch] = useState(false)

  const verticals = ['all', 'engineering', 'qa', 'research', 'content', 'ops']

  const filteredAgents = filterVertical === 'all'
    ? agents
    : agents.filter(a => a.vertical === filterVertical)

  const addStage = () => {
    setStages(prev => [...prev, {
      stageId: `stage-${prev.length + 1}`,
      pattern: 'sequential',
      agents: [],
      description: `Stage ${prev.length + 1}`,
    }])
  }

  const dropAgentOnStage = useCallback((stageId: string) => {
    if (!draggingAgent) return
    setStages(prev =>
      prev.map(s =>
        s.stageId === stageId && !s.agents.includes(draggingAgent)
          ? { ...s, agents: [...s.agents, draggingAgent] }
          : s
      )
    )
    setDraggingAgent(null)
  }, [draggingAgent])

  const removeAgentFromStage = (stageId: string, agentName: string) => {
    setStages(prev =>
      prev.map(s =>
        s.stageId === stageId
          ? { ...s, agents: s.agents.filter(a => a !== agentName) }
          : s
      )
    )
  }

  const updateStagePattern = (stageId: string, pattern: Stage['pattern']) => {
    setStages(prev => prev.map(s => s.stageId === stageId ? { ...s, pattern } : s))
  }

  const buildManifest = () => ({
    name: teamName,
    displayName: teamDisplayName || teamName,
    version: '1.0.0',
    description: `Custom team: ${teamDisplayName || teamName}`,
    estimatedDurationMins: stages.length * 15,
    tags: ['custom'],
    stages: stages.filter(s => s.agents.length > 0).map(s => ({
      stageId: s.stageId,
      description: s.description,
      pattern: s.pattern,
      agents: s.agents,
      taskIds: s.agents.map(a => `${s.stageId}-${a}`),
    })),
  })

  const canSave = teamName.trim() && stages.some(s => s.agents.length > 0)

  return (
    <div className="flex gap-4 min-h-0" style={{ height: '100%' }}>
      {/* Agent sidebar */}
      <div
        className="w-56 flex-shrink-0 flex flex-col rounded-xl overflow-hidden"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
      >
        <div className="px-3 py-3 border-b flex-shrink-0" style={{ borderColor: 'var(--border)' }}>
          <div className="text-[10px] font-mono uppercase tracking-widest mb-2" style={{ color: 'var(--text-dim)' }}>
            Agent Library
          </div>
          <div className="flex flex-wrap gap-1">
            {verticals.map(v => (
              <button
                key={v}
                onClick={() => setFilterVertical(v)}
                className="px-2 py-0.5 rounded text-[9px] font-mono uppercase tracking-wide transition-colors"
                style={{
                  background: filterVertical === v ? 'rgba(68,136,255,0.15)' : 'var(--bg-elevated)',
                  color: filterVertical === v ? 'var(--accent-blue)' : 'var(--text-dim)',
                  border: `1px solid ${filterVertical === v ? 'rgba(68,136,255,0.3)' : 'var(--border)'}`,
                }}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1.5">
          {filteredAgents.map(agent => (
            <AgentCard key={agent.name} agent={agent} compact onDragStart={setDraggingAgent} />
          ))}
        </div>
      </div>

      {/* Stage canvas */}
      <div className="flex-1 min-w-0 flex flex-col gap-3 overflow-y-auto">
        {/* Team name fields */}
        <div className="flex gap-2">
          <input
            style={inputStyle}
            placeholder="Team ID (kebab-case)"
            value={teamName}
            onChange={e => setTeamName(e.target.value)}
          />
          <input
            style={inputStyle}
            placeholder="Display Name"
            value={teamDisplayName}
            onChange={e => setTeamDisplayName(e.target.value)}
          />
        </div>

        {/* Stages */}
        <div className="flex flex-col gap-3">
          {stages.map((stage, idx) => (
            <div
              key={stage.stageId}
              onDragOver={e => e.preventDefault()}
              onDrop={() => dropAgentOnStage(stage.stageId)}
              className="rounded-xl p-3 flex flex-col gap-2 transition-all"
              style={{
                background: 'var(--bg-surface)',
                border: `1px solid ${PATTERN_COLORS[stage.pattern]}44`,
                borderLeft: `4px solid ${PATTERN_COLORS[stage.pattern]}`,
              }}
            >
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-mono font-bold" style={{ color: 'var(--text-dim)' }}>
                  {idx + 1}
                </span>
                <input
                  value={stage.description}
                  onChange={e => setStages(prev =>
                    prev.map(s => s.stageId === stage.stageId ? { ...s, description: e.target.value } : s)
                  )}
                  className="flex-1 text-xs font-mono outline-none"
                  style={{ background: 'transparent', color: 'var(--text-primary)', border: 'none' }}
                />
                <select
                  value={stage.pattern}
                  onChange={e => updateStagePattern(stage.stageId, e.target.value as Stage['pattern'])}
                  className="text-[10px] font-mono px-2 py-1 rounded"
                  style={{
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border)',
                    color: PATTERN_COLORS[stage.pattern],
                    outline: 'none',
                  }}
                >
                  <option value="sequential">Sequential</option>
                  <option value="parallel">Parallel</option>
                  <option value="gated">Gated</option>
                </select>
              </div>

              <div className="min-h-[48px] flex flex-wrap gap-1.5 items-start">
                {stage.agents.length === 0 && (
                  <span className="text-[10px] font-mono italic self-center" style={{ color: 'var(--text-dim)' }}>
                    Drop agents here
                  </span>
                )}
                {stage.agents.map(agentName => {
                  const a = agents.find(x => x.name === agentName)
                  return (
                    <span
                      key={agentName}
                      className="flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-mono"
                      style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                    >
                      {a?.displayName ?? agentName}
                      <button
                        onClick={() => removeAgentFromStage(stage.stageId, agentName)}
                        className="ml-1 w-3.5 h-3.5 rounded-full flex items-center justify-center text-[9px] transition-colors hover:bg-white/10"
                        style={{ color: 'var(--text-dim)' }}
                      >
                        ✕
                      </button>
                    </span>
                  )
                })}
              </div>
            </div>
          ))}

          <button
            onClick={addStage}
            className="py-2.5 rounded-xl text-xs font-mono font-bold transition-colors"
            style={{
              background: 'transparent',
              border: '1px dashed var(--border)',
              color: 'var(--text-dim)',
            }}
          >
            + Add Stage
          </button>
        </div>

        {/* Actions */}
        <div className="flex gap-2 pt-1">
          <button
            onClick={() => onSave(buildManifest())}
            disabled={!canSave}
            className="flex-1 py-3 rounded-xl text-xs font-mono font-bold transition-colors"
            style={{
              background: canSave ? 'rgba(0,255,136,0.12)' : 'var(--bg-elevated)',
              color: canSave ? 'var(--accent-green)' : 'var(--text-dim)',
              border: `1px solid ${canSave ? 'rgba(0,255,136,0.25)' : 'var(--border)'}`,
              cursor: canSave ? 'pointer' : 'not-allowed',
              minHeight: 44,
            }}
          >
            Save Team
          </button>
          <button
            onClick={() => setShowLaunch(true)}
            disabled={!teamName.trim()}
            className="flex-1 py-3 rounded-xl text-xs font-mono font-bold transition-colors"
            style={{
              background: teamName.trim() ? 'rgba(68,136,255,0.12)' : 'var(--bg-elevated)',
              color: teamName.trim() ? 'var(--accent-blue)' : 'var(--text-dim)',
              border: `1px solid ${teamName.trim() ? 'rgba(68,136,255,0.3)' : 'var(--border)'}`,
              cursor: teamName.trim() ? 'pointer' : 'not-allowed',
              minHeight: 44,
            }}
          >
            Launch ↗
          </button>
        </div>

        {/* Launch instruction modal */}
        {showLaunch && (
          <div
            className="rounded-xl p-4 flex flex-col gap-3"
            style={{ background: 'var(--bg-surface)', border: '1px solid rgba(68,136,255,0.3)' }}
          >
            <div className="text-xs font-mono font-bold" style={{ color: 'var(--accent-blue)' }}>
              Task instruction for {teamDisplayName || teamName}
            </div>
            <textarea
              placeholder="Describe the task for this team to work on..."
              value={instruction}
              onChange={e => setInstruction(e.target.value)}
              rows={4}
              className="w-full resize-none outline-none text-xs font-mono p-3 rounded-lg"
              style={{
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border)',
                color: 'var(--text-primary)',
              }}
            />
            <div className="flex gap-2">
              <button
                onClick={() => { onLaunch(buildManifest(), instruction); setShowLaunch(false) }}
                disabled={!instruction.trim()}
                className="flex-1 py-2.5 rounded-lg text-xs font-mono font-bold"
                style={{
                  background: instruction.trim() ? 'rgba(68,136,255,0.15)' : 'var(--bg-elevated)',
                  color: instruction.trim() ? 'var(--accent-blue)' : 'var(--text-dim)',
                  border: `1px solid ${instruction.trim() ? 'rgba(68,136,255,0.3)' : 'var(--border)'}`,
                  minHeight: 44,
                }}
              >
                Launch Workflow
              </button>
              <button
                onClick={() => setShowLaunch(false)}
                className="px-4 py-2.5 rounded-lg text-xs font-mono"
                style={{ background: 'var(--bg-elevated)', color: 'var(--text-dim)', border: '1px solid var(--border)', minHeight: 44 }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
