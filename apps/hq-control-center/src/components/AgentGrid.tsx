import { useHQStore } from '~/store/hqStore'
import { AgentSprite } from './AgentSprite'
import type { SpriteStatus } from './AgentSprite'

interface Agent {
  id: string
  name: string
  status: SpriteStatus
  lastHeartbeat?: string
  currentJobId?: string
  model?: string
}

const DAEMON_AGENT: Agent = {
  id: 'daemon',
  name: 'Daemon',
  status: 'active', // Daemon is always listed as active (it generates DAEMON-STATUS.md)
}

export function AgentGrid() {
  const relays = useHQStore((s) => s.relays)
  const workers = useHQStore((s) => s.workers)
  const daemonTasks = useHQStore((s) => s.daemonTasks)

  // Daemon status: error if any task has errors
  const daemonStatus: SpriteStatus = daemonTasks.some((t) => t.status === 'error')
    ? 'error'
    : daemonTasks.length > 0
      ? 'active'
      : 'idle'

  const allAgents: Agent[] = [
    { ...DAEMON_AGENT, status: daemonStatus },
    ...workers.map((w) => ({
      ...w,
      status: w.status as SpriteStatus,
    })),
    ...relays.map((r) => ({
      ...r,
      status: r.status as SpriteStatus,
    })),
  ]

  if (allAgents.length === 0) {
    return (
      <div
        className="hq-panel p-6 text-center"
        style={{ color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', fontSize: 12 }}
      >
        No agents detected
      </div>
    )
  }

  return (
    <div className="flex flex-wrap gap-4">
      {allAgents.map((agent) => (
        <AgentSprite
          key={agent.id}
          id={agent.id}
          name={agent.name}
          status={agent.status}
          lastHeartbeat={agent.lastHeartbeat}
          currentJobId={agent.currentJobId}
          model={agent.model}
        />
      ))}
    </div>
  )
}
