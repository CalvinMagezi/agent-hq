import { motion, AnimatePresence } from 'framer-motion'
import { useState } from 'react'

export type SpriteStatus = 'active' | 'idle' | 'error'

interface Props {
  id: string
  name: string
  status: SpriteStatus
  lastHeartbeat?: string
  currentJobId?: string
  model?: string
}

const STATUS_COLOR: Record<SpriteStatus, string> = {
  active: 'var(--accent-green)',
  idle: 'var(--text-dim)',
  error: 'var(--accent-red)',
}

const GLYPHS: Record<string, React.ReactNode> = {
  daemon: (
    <path d="M12 15.5C13.933 15.5 15.5 13.933 15.5 12C15.5 10.067 13.933 8.5 12 8.5C10.067 8.5 8.5 10.067 8.5 12C8.5 13.933 10.067 15.5 12 15.5ZM19.5 12L22 13L21 16L18 16.5C17.5 18 16.5 19 15.5 20L15.5 23L12 24L8.5 23L8.5 20C7.5 19 6.5 18 6 16.5L3 16L2 13L4.5 12L2 11L3 8L6 7.5C6.5 6 7.5 5 8.5 4L8.5 1L12 0L15.5 1L15.5 4C16.5 5 17.5 6 18 7.5L21 8L22 11L19.5 12Z" fill="currentColor" />
  ),
  relay: (
    <path d="M12 4L14 8h-4l2-4zm-6 8c0 3.31 2.69 6 6 6s6-2.69 6-6-2.69-6-6-6-6 2.69-6 6zm10.5 0c0 2.48-2.02 4.5-4.5 4.5S7.5 14.48 7.5 12 9.52 7.5 12 7.5s4.5 2.02 4.5 4.5zM12 18v6M6 24h12" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  ),
  worker: (
    <path d="M12 2a3 3 0 100 6 3 3 0 000-6zm0 24a3 3 0 100-6 3 3 0 000 6zM5 14a3 3 0 100-6 3 3 0 000 6zm14 0a3 3 0 100-6 3 3 0 000 6zM12 8v10M6 13l6-3M18 13l-6-3M6 15l6 7M18 15l-6 7" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  )
}

function getGlyph(id: string) {
  if (id === 'daemon') return GLYPHS.daemon
  if (id.startsWith('relay')) return GLYPHS.relay
  return GLYPHS.worker
}

export function AgentSprite({ id, name, status, lastHeartbeat, currentJobId, model }: Props) {
  const [hovered, setHovered] = useState(false)

  const bounceVariants = {
    idle: { scale: [1, 1.05, 1], transition: { duration: 3, repeat: Infinity, ease: 'easeInOut' } },
    active: { y: [0, -4, 0], scale: [1, 1, 1], transition: { duration: 1.5, repeat: Infinity, ease: 'easeInOut' } },
    error: { x: [0, -3, 3, -3, 3, 0], transition: { duration: 0.5, repeat: Infinity, ease: 'easeInOut' } }
  }

  const spinVariants = {
    idle: { rotate: 0 },
    active: { rotate: 360, transition: { duration: 4, repeat: Infinity, ease: 'linear' } },
    error: { rotate: 0 }
  }

  const color = STATUS_COLOR[status]

  return (
    <div
      className="relative"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <motion.div
        layout
        className="flex flex-col items-center gap-2 p-3 rounded-lg cursor-default select-none relative z-10"
        style={{
          background: 'var(--bg-elevated)',
          border: `1px solid ${color}`,
          boxShadow: status === 'active' ? `0 0 16px ${color}40` : status === 'error' ? `0 0 16px ${color}40` : 'none',
          minWidth: 72,
        }}
        animate={{ borderColor: color }}
        transition={{ duration: 0.3 }}
      >
        {/* Magic flashing background on status change */}
        <motion.div
          key={status} // triggers on status change
          initial={{ opacity: 0.5, scale: 0.8 }}
          animate={{ opacity: 0, scale: 1.2 }}
          transition={{ duration: 0.8 }}
          className="absolute inset-0 rounded-lg pointer-events-none"
          style={{ background: color }}
        />

        {/* SVG character glyph */}
        <div className="relative w-12 h-12 flex items-center justify-center">
          <motion.svg
            width="32"
            height="32"
            viewBox="0 0 24 24"
            className="absolute z-10"
            style={{ color }}
            variants={bounceVariants}
            animate={status}
          >
            {getGlyph(id)}
          </motion.svg>

          {/* Active outer ring visual */}
          {status === 'active' && (
            <motion.svg
              width="48"
              height="48"
              viewBox="0 0 48 48"
              className="absolute inset-0 z-0"
              variants={spinVariants}
              animate={status}
              style={{ color, opacity: 0.4 }}
            >
              <circle cx="24" cy="24" r="22" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 4" />
            </motion.svg>
          )}
        </div>

        {/* Status indicator drop */}
        <div className={`status-dot ${status} mt-1`} style={{ background: color, boxShadow: `0 0 6px ${color}` }} />

        {/* Label */}
        <span
          className="text-center leading-tight mt-1"
          style={{
            fontSize: '9px',
            letterSpacing: '0.05em',
            color: status === 'idle' ? 'var(--text-dim)' : 'var(--text-primary)',
            fontFamily: 'var(--font-mono)',
            maxWidth: 64,
          }}
        >
          {name}
        </span>
      </motion.div>

      {/* Tooltip */}
      <AnimatePresence>
        {hovered && (
          <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95, y: 5 }}
            transition={{ duration: 0.15 }}
            className="absolute bottom-[calc(100%+8px)] left-1/2 -translate-x-1/2 w-48 p-3 rounded-lg z-50 text-xs font-mono border"
            style={{ background: 'var(--bg-surface)', borderColor: 'var(--border)', boxShadow: '0 4px 20px rgba(0,0,0,0.5)' }}
          >
            <div className="flex flex-col gap-2">
              <div className="flex justify-between border-b pb-1" style={{ borderColor: 'var(--border)' }}>
                <span style={{ color: 'var(--text-dim)' }}>Status</span>
                <span className={`badge badge-${status}`}>{status}</span>
              </div>
              {model && (
                <div className="flex justify-between">
                  <span style={{ color: 'var(--text-dim)' }}>Model</span>
                  <span className="truncate ml-2" style={{ color: 'var(--text-primary)' }}>{model}</span>
                </div>
              )}
              {currentJobId && (
                <div className="flex justify-between gap-2 overflow-hidden">
                  <span style={{ color: 'var(--text-dim)' }}>Job</span>
                  <span className="truncate" style={{ color: 'var(--accent-amber)' }}>{currentJobId}</span>
                </div>
              )}
              {lastHeartbeat && (
                <div className="flex justify-between">
                  <span style={{ color: 'var(--text-dim)' }}>Heartbeat</span>
                  <span style={{ color: 'var(--text-primary)' }}>{new Date(lastHeartbeat).toLocaleTimeString()}</span>
                </div>
              )}
              {!model && !currentJobId && !lastHeartbeat && (
                <div className="text-center italic opacity-50">System Process</div>
              )}
            </div>
            {/* Tooltip triangle */}
            <div className="absolute top-full left-1/2 -translate-x-1/2 border-8 border-transparent" style={{ borderTopColor: 'var(--border)' }}></div>
            <div className="absolute top-full left-1/2 -translate-x-1/2 border-8 border-transparent -mt-[1px]" style={{ borderTopColor: 'var(--bg-surface)' }}></div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
