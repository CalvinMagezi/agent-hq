import { Link } from '@tanstack/react-router'
import { useHQStore } from '~/store/hqStore'

const NAV_LEFT = [
  { to: '/vault', label: 'Vault', icon: '◈' },
  { to: '/drawit', label: 'Canvas', icon: '✦' },
] as const

const NAV_RIGHT = [
  { to: '/teams', label: 'Teams', icon: '⬡' },
  { to: '/plans', label: 'Plans', icon: '≡' },
] as const

export function BottomNav() {
  const { chatPanelOpen, setChatPanelOpen } = useHQStore()

  return (
    <nav
      className="md:hidden fixed bottom-0 left-0 right-0 z-40 flex items-stretch"
      style={{
        background: 'var(--bg-surface)',
        borderTop: '1px solid var(--border)',
        paddingBottom: 'env(safe-area-inset-bottom)',
        height: 'calc(60px + env(safe-area-inset-bottom))',
      }}
    >
      {/* Left nav items */}
      {NAV_LEFT.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          className="flex-1 flex flex-col items-center justify-center gap-0.5 text-center transition-colors"
          style={{ minHeight: 48 }}
          activeProps={{
            style: {
              color: 'var(--accent-green)',
              background: 'rgba(0,255,136,0.06)',
            },
          }}
          inactiveProps={{ style: { color: 'var(--text-dim)' } }}
        >
          <span className="text-lg leading-none">{item.icon}</span>
          <span className="text-[10px] font-mono font-bold tracking-wide">{item.label}</span>
        </Link>
      ))}

      {/* Center chat button — elevated */}
      <div className="flex-1 flex items-center justify-center relative">
        <button
          onClick={() => setChatPanelOpen(!chatPanelOpen)}
          className="absolute -top-5 flex items-center justify-center rounded-full shadow-lg transition-transform active:scale-95"
          style={{
            width: 56,
            height: 56,
            background: chatPanelOpen
              ? 'linear-gradient(135deg, var(--accent-green), var(--accent-blue))'
              : 'var(--bg-elevated)',
            border: chatPanelOpen
              ? '2px solid var(--accent-green)'
              : '2px solid var(--border)',
            boxShadow: chatPanelOpen
              ? '0 0 20px rgba(0,255,136,0.3)'
              : '0 4px 12px rgba(0,0,0,0.4)',
          }}
        >
          <img
            src="/hq-agent.svg"
            alt="HQ Agent"
            className="rounded-full"
            style={{
              width: 36,
              height: 36,
              filter: chatPanelOpen ? 'brightness(1.2)' : 'none',
            }}
          />
        </button>
        <span
          className="text-[10px] font-mono font-bold tracking-wide mt-6"
          style={{ color: chatPanelOpen ? 'var(--accent-green)' : 'var(--text-dim)' }}
        >
          HQ
        </span>
      </div>

      {/* Right nav items */}
      {NAV_RIGHT.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          className="flex-1 flex flex-col items-center justify-center gap-0.5 text-center transition-colors"
          style={{ minHeight: 48 }}
          activeProps={{
            style: {
              color: 'var(--accent-green)',
              background: 'rgba(0,255,136,0.06)',
            },
          }}
          inactiveProps={{ style: { color: 'var(--text-dim)' } }}
        >
          <span className="text-lg leading-none">{item.icon}</span>
          <span className="text-[10px] font-mono font-bold tracking-wide">{item.label}</span>
        </Link>
      ))}
    </nav>
  )
}
