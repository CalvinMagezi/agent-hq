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
      className="md:hidden fixed bottom-0 left-0 right-0 z-40 flex items-stretch glass-heavy"
      style={{
        borderTop: '1px solid rgba(255, 255, 255, 0.06)',
        paddingBottom: 'env(safe-area-inset-bottom)',
        height: 'calc(64px + env(safe-area-inset-bottom))',
      }}
    >
      {/* Left nav items */}
      {NAV_LEFT.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          className="flex-1 flex flex-col items-center justify-center gap-0.5 text-center transition-all active:scale-95"
          style={{ minHeight: 48 }}
          activeProps={{
            style: {
              color: 'var(--accent-green)',
            },
          }}
          inactiveProps={{ style: { color: 'var(--text-dim)' } }}
        >
          <span className="text-lg leading-none">{item.icon}</span>
          <span className="text-[9px] font-mono font-bold tracking-wide">{item.label}</span>
        </Link>
      ))}

      {/* Center chat button — floating glass orb */}
      <div className="flex-1 flex items-center justify-center relative">
        <button
          onClick={() => setChatPanelOpen(!chatPanelOpen)}
          className="absolute -top-5 flex items-center justify-center rounded-full transition-all active:scale-90"
          style={{
            width: 56,
            height: 56,
            background: chatPanelOpen
              ? 'rgba(0, 255, 136, 0.15)'
              : 'rgba(20, 20, 36, 0.7)',
            border: chatPanelOpen
              ? '1.5px solid rgba(0, 255, 136, 0.4)'
              : '1.5px solid rgba(255, 255, 255, 0.1)',
            boxShadow: chatPanelOpen
              ? '0 0 24px rgba(0, 255, 136, 0.2), 0 0 48px rgba(0, 255, 136, 0.05)'
              : '0 4px 20px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.05)',
            backdropFilter: 'blur(20px) saturate(180%)',
            WebkitBackdropFilter: 'blur(20px) saturate(180%)',
          }}
        >
          <img
            src="/hq-agent.svg"
            alt="HQ Agent"
            className="rounded-full"
            style={{
              width: 34,
              height: 34,
              filter: chatPanelOpen ? 'brightness(1.3) drop-shadow(0 0 8px rgba(0,255,136,0.3))' : 'none',
            }}
          />
        </button>
        <span
          className="text-[9px] font-mono font-bold tracking-wide mt-6"
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
          className="flex-1 flex flex-col items-center justify-center gap-0.5 text-center transition-all active:scale-95"
          style={{ minHeight: 48 }}
          activeProps={{
            style: {
              color: 'var(--accent-green)',
            },
          }}
          inactiveProps={{ style: { color: 'var(--text-dim)' } }}
        >
          <span className="text-lg leading-none">{item.icon}</span>
          <span className="text-[9px] font-mono font-bold tracking-wide">{item.label}</span>
        </Link>
      ))}
    </nav>
  )
}
