import { spawn, execSync, ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { BrowserWindow } from 'electron';
import { IPC } from './ipc-channels';
import { DependencyCheckResult } from './types';
import { envManager } from './env-manager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MONOREPO_ROOT = path.resolve(__dirname, '../../..');

export class DaemonManager {
    private daemonProcess: ChildProcess | null = null;
    private relayProcess: ChildProcess | null = null;
    private startTime: number | null = null;
    private mainWindow: BrowserWindow | null = null;
    private statusTimer: ReturnType<typeof setInterval> | null = null;

    async checkDependencies(): Promise<DependencyCheckResult> {
        let bunInstalled = false;
        let bunVersion = null;
        let nodeVersion = process.version;

        try {
            bunVersion = execSync('bun --version', { encoding: 'utf-8' }).trim();
            bunInstalled = true;
        } catch (e) {
            // bun not found
        }

        const config = await envManager.readEnv();
        const envFileExists = Object.keys(config).length > 0;

        // We assume vault path exists if we can resolve it, or we could stat it.
        // In our simplified logic, just true if env exists.
        const vaultPathExists = true;

        return {
            bunInstalled,
            bunVersion,
            nodeVersion,
            envFileExists,
            vaultPathExists,
        };
    }

    /**
     * Check if the relay server is already running externally (port 18900).
     */
    private isRelayRunning(): boolean {
        try {
            const result = execSync('lsof -i :18900 -P -n 2>/dev/null | grep LISTEN', { encoding: 'utf-8' });
            return result.trim().length > 0;
        } catch {
            return false;
        }
    }

    /**
     * Check if the daemon is already running externally via process check.
     */
    private isDaemonRunning(): boolean {
        try {
            const result = execSync('ps aux 2>/dev/null | grep "agent-hq-daemon" | grep -v grep', { encoding: 'utf-8' });
            return result.trim().length > 0;
        } catch {
            return false;
        }
    }

    start(window: BrowserWindow): boolean {
        this.mainWindow = window;

        try {
            // ── Start Relay Server if not already running ────────────
            if (!this.relayProcess && !this.isRelayRunning()) {
                this.sendLog('stdout', '[DaemonManager] Starting relay server...\n');
                this.relayProcess = spawn('bun', ['run', 'relay-server'], {
                    cwd: MONOREPO_ROOT,
                    env: { ...process.env, FORCE_COLOR: '1' }
                });

                this.relayProcess.stdout?.on('data', (data: Buffer) => {
                    this.sendLog('stdout', `[relay] ${data.toString()}`);
                });
                this.relayProcess.stderr?.on('data', (data: Buffer) => {
                    this.sendLog('stderr', `[relay] ${data.toString()}`);
                });
                this.relayProcess.on('exit', (code) => {
                    this.sendLog('stderr', `[relay] Relay server exited with code ${code}\n`);
                    this.relayProcess = null;
                });
            } else {
                this.sendLog('stdout', '[DaemonManager] Relay server already running.\n');
            }

            // ── Start Daemon if not already running ─────────────────
            if (!this.daemonProcess && !this.isDaemonRunning()) {
                this.sendLog('stdout', '[DaemonManager] Starting daemon...\n');
                this.daemonProcess = spawn('bun', ['run', 'daemon'], {
                    cwd: MONOREPO_ROOT,
                    env: { ...process.env, FORCE_COLOR: '1' } // Preserve ANSI colors
                });

                this.startTime = Date.now();

                this.daemonProcess.stdout?.on('data', (data: Buffer) => {
                    this.sendLog('stdout', data.toString());
                });

                this.daemonProcess.stderr?.on('data', (data: Buffer) => {
                    this.sendLog('stderr', data.toString());
                });

                this.daemonProcess.on('exit', (code) => {
                    this.sendLog('stderr', `Daemon exited with code ${code}`);
                    this.daemonProcess = null;
                    this.startTime = null;
                    this.broadcastStatus();
                });
            } else {
                this.sendLog('stdout', '[DaemonManager] Daemon already running.\n');
                if (!this.startTime) this.startTime = Date.now();
            }

            // Start broadcasting status periodically
            if (!this.statusTimer) {
                this.statusTimer = setInterval(() => this.broadcastStatus(), 2000);
            }

            this.broadcastStatus();
            return true;
        } catch (e: any) {
            this.sendLog('stderr', `Failed to start daemon: ${e.message}`);
            return false;
        }
    }

    stop(): boolean {
        try {
            if (this.relayProcess) {
                this.relayProcess.kill('SIGTERM');
                this.relayProcess = null;
            }

            if (this.daemonProcess) {
                this.daemonProcess.kill('SIGTERM');

                // Force kill after 5 seconds if still alive
                const pid = this.daemonProcess.pid;
                setTimeout(() => {
                    if (this.daemonProcess && this.daemonProcess.pid === pid) {
                        try { this.daemonProcess.kill('SIGKILL'); } catch (e) { }
                    }
                }, 5000);
            }

            this.daemonProcess = null;
            this.startTime = null;
            if (this.statusTimer) {
                clearInterval(this.statusTimer);
                this.statusTimer = null;
            }
            this.broadcastStatus();
            return true;
        } catch (e) {
            return false;
        }
    }

    async triggerWorkflow(name: string): Promise<string> {
        return new Promise((resolve) => {
            try {
                const wfProcess = spawn('bun', ['run', `scripts/workflows/${name}.ts`], {
                    cwd: MONOREPO_ROOT,
                    env: { ...process.env, FORCE_COLOR: '1' }
                });

                let output = '';
                wfProcess.stdout?.on('data', (data) => {
                    const chunk = data.toString();
                    output += chunk;
                    this.sendLog('stdout', `[Workflow ${name}] ${chunk}`);
                });
                wfProcess.stderr?.on('data', (data) => {
                    const chunk = data.toString();
                    output += chunk;
                    this.sendLog('stderr', `[Workflow ${name}] ${chunk}`);
                });

                wfProcess.on('close', (code) => {
                    resolve(`Workflow ${name} exited with code ${code}\n${output}`);
                });
            } catch (e: any) {
                resolve(`Failed to trigger workflow: ${e.message}`);
            }
        });
    }

    private sendLog(stream: 'stdout' | 'stderr', data: string) {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send(IPC.DAEMON_LOG, {
                stream,
                data,
                timestamp: Date.now()
            });
        }
    }

    private broadcastStatus() {
        const running = !!this.daemonProcess || this.isDaemonRunning();

        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send(IPC.DAEMON_STATUS, {
                running,
                pid: this.daemonProcess?.pid || null,
                uptime: this.startTime ? Date.now() - this.startTime : null
            });
        }
    }
}

export const daemonManager = new DaemonManager();

