import { useEffect } from 'react';
import { TabShell } from './components/TabShell';
import { useSystemStore } from './store/system-store';
import { useRelayStore } from './store/relay-store';
import './styles/index.css';

export default function App() {
  const { setConfig, setDeps, updateDaemonStatus, updateSystemStats, appendLog } = useSystemStore();
  const { connect } = useRelayStore();

  useEffect(() => {
    const bootstrap = async () => {
      const deps = await window.electronAPI.checkDependencies();
      setDeps(deps);

      const config = await window.electronAPI.getEnvConfig();
      setConfig(config);

      // Give the relay server a moment to boot up (auto-started by main process)
      // before attempting the WebSocket connection
      setTimeout(() => {
        connect(config.AGENTHQ_API_KEY || 'local-master-key');
      }, 3000);
    };

    bootstrap();

    const unsubs = [
      window.electronAPI.onDaemonLog(appendLog),
      window.electronAPI.onDaemonStatus(updateDaemonStatus),
      window.electronAPI.onSystemStats(updateSystemStats),
    ];

    return () => {
      unsubs.forEach(unsub => unsub());
    };
  }, []);

  return <TabShell />;
}
