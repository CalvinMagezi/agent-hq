import { useEffect } from 'react';
import { Routes, Route, NavLink } from 'react-router-dom';
import { useWebSocket } from './hooks/useWebSocket';
import { useHQStore } from './store/hqStore';
import CommandCenter from './views/CommandCenter';
import JobsView from './views/JobsView';
import NotesView from './views/NotesView';

function App() {
    useWebSocket();
    const wsConnected = useHQStore(s => s.wsConnected);

    // Initial Data Fetch
    useEffect(() => {
        fetch('/api/daemon').then(res => res.json()).then(data => {
            if (data.tasks) useHQStore.getState().setDaemonTasks(data.tasks);
        }).catch(console.error);

        fetch('/api/agents').then(res => res.json()).then(data => {
            // combine relays + workers
            if (data.relays && data.workers) {
                // Map arrays to unified agent shape for the UI
                useHQStore.getState().setAgents([...data.relays, ...data.workers]);
            }
        }).catch(console.error);

        fetch('/api/jobs').then(res => res.json()).then(data => {
            if (data.jobs) useHQStore.getState().setJobs(data.jobs);
        }).catch(console.error);

        fetch('/api/usage').then(res => res.json()).then(data => {
            if (data) useHQStore.getState().setUsage({ today: data.today, month: data.month, budget: data.budget });
        }).catch(console.error);
    }, []);

    return (
        <div className="flex flex-col h-full bg-[#0a0a0f] text-[#e8e8f0]">
            {/* Header */}
            <header className="flex-shrink-0 flex items-center justify-between px-4 py-3 border-b border-[#2a2a3d] bg-[#111118]">
                <h1 className="font-mono text-sm tracking-widest font-semibold flex items-center gap-2">
                    <span>⚡ HQ CONTROL CENTER</span>
                </h1>
                <div className="flex items-center gap-3">
                    <span className="text-xs text-text-dim">WS: {wsConnected ? <span className="text-accent-green">live</span> : <span className="text-accent-red">dropped</span>}</span>
                    <span className={`status-dot ${wsConnected ? 'active' : 'error'}`}></span>
                </div>
            </header>

            {/* Main Content */}
            <main className="flex-1 overflow-y-auto">
                <Routes>
                    <Route path="/" element={<CommandCenter />} />
                    <Route path="/jobs" element={<JobsView />} />
                    <Route path="/notes" element={<NotesView />} />
                </Routes>
            </main>

            {/* Bottom Tab Bar (Mobile) / Sidebar Desktop - simplified to bottom bar for all for now */}
            <nav className="flex-shrink-0 flex items-center justify-around px-2 py-4 border-t border-[#2a2a3d] bg-[#111118]">
                <NavLink to="/" className={({ isActive }) => `flex flex-col items-center gap-1 ${isActive ? 'text-accent-green' : 'text-text-dim'}`}>
                    <span className="text-xl">🎯</span>
                    <span className="text-xs font-mono uppercase tracking-widest">Center</span>
                </NavLink>
                <NavLink to="/jobs" className={({ isActive }) => `flex flex-col items-center gap-1 ${isActive ? 'text-accent-blue' : 'text-text-dim'}`}>
                    <span className="text-xl">⚙️</span>
                    <span className="text-xs font-mono uppercase tracking-widest">Jobs</span>
                </NavLink>
                <NavLink to="/notes" className={({ isActive }) => `flex flex-col items-center gap-1 ${isActive ? 'text-accent-amber' : 'text-text-dim'}`}>
                    <span className="text-xl">📝</span>
                    <span className="text-xs font-mono uppercase tracking-widest">Notes</span>
                </NavLink>
            </nav>
        </div>
    );
}

export default App;
