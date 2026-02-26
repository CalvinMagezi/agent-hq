import { useState } from 'react';
import { Dashboard } from './Dashboard';
import { Terminal } from './Terminal';
import { SetupWizard } from './SetupWizard';
import { VaultGraph } from './VaultGraph';
import { SimulationRoom } from './SimulationRoom';
import { Settings } from './Settings';
import { useSystemStore } from '../store/system-store';
import { STORAGE_KEYS } from '../store/storageKeys';

import hqIcon from '../assets/icon-color.png';

// Component ready

export function TabShell() {
    // Read initial tab from localStorage or default to 'dash'
    const getInitialTab = () => {
        try {
            const saved = localStorage.getItem(STORAGE_KEYS.ACTIVE_TAB);
            if (saved && ['dash', 'terminal', 'sim', 'graph', 'settings'].includes(saved)) {
                return saved as 'dash' | 'terminal' | 'sim' | 'graph' | 'settings';
            }
        } catch { /* ignore */ }
        return 'dash';
    };

    const [activeTab, setActiveTabState] = useState<'dash' | 'terminal' | 'sim' | 'graph' | 'settings'>(getInitialTab);
    const { config } = useSystemStore();

    const setActiveTab = (tab: typeof activeTab) => {
        setActiveTabState(tab);
        try {
            localStorage.setItem(STORAGE_KEYS.ACTIVE_TAB, tab);
        } catch { /* ignore */ }
    };

    // Show setup wizard if missing required keys
    if (!config || !config.OPENROUTER_API_KEY) {
        return <SetupWizard />;
    }

    return (
        <div className="app-container font-sans bg-dark text-main flex flex-col h-screen w-screen overflow-hidden">
            <div className="tab-header flex gap-4 p-3 bg-gray-900 border-b border-gray-800 items-center">
                <div className="flex items-center gap-2 mr-4 ml-2">
                    <img src={hqIcon} alt="Agent HQ" style={{ width: '32px', height: '32px', objectFit: 'contain' }} />
                    <span className="font-bold text-lg text-white tracking-wide">AGENT_HQ</span>
                </div>
                <button
                    className={`tab-btn px-4 py-2 rounded font-medium transition-colors ${activeTab === 'dash' ? 'bg-blue-600 text-black' : 'text-gray-400 hover:bg-gray-800'}`}
                    onClick={() => setActiveTab('dash')}
                >
                    Dashboard
                </button>
                <button
                    className={`tab-btn px-4 py-2 rounded font-medium transition-colors ${activeTab === 'terminal' ? 'bg-blue-600 text-black' : 'text-gray-400 hover:bg-gray-800'}`}
                    onClick={() => setActiveTab('terminal')}
                >
                    Terminal
                </button>
                <button
                    className={`tab-btn px-4 py-2 rounded font-medium transition-colors ${activeTab === 'graph' ? 'bg-blue-600 text-black' : 'text-gray-400 hover:bg-gray-800'}`}
                    onClick={() => setActiveTab('graph')}
                >
                    Graph
                </button>
                <button
                    className={`tab-btn px-4 py-2 rounded font-medium transition-colors ${activeTab === 'sim' ? 'bg-blue-600 text-black' : 'text-gray-400 hover:bg-gray-800'}`}
                    onClick={() => setActiveTab('sim')}
                >
                    Simulation Room
                </button>
                <div className="flex-1"></div>
                <button
                    className={`tab-btn px-4 py-2 rounded font-medium transition-colors ${activeTab === 'settings' ? 'bg-gray-800 text-white border border-gray-700' : 'text-gray-400 hover:bg-gray-800'}`}
                    onClick={() => setActiveTab('settings')}
                >
                    Settings
                </button>
            </div>

            <div className="tab-content flex-1 overflow-auto bg-black">
                {activeTab === 'dash' && <Dashboard />}
                {activeTab === 'terminal' && <Terminal />}
                {activeTab === 'graph' && <VaultGraph />}
                {activeTab === 'sim' && <SimulationRoom />}
                {activeTab === 'settings' && <Settings />}
            </div>
        </div>
    );
}
