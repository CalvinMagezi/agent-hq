import { app, BrowserWindow, nativeImage, session } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { setupIpcHandlers } from './ipc-handlers'
import { vaultManager } from './vault-manager'
import { daemonManager } from './daemon-manager'
import { IPC } from './ipc-channels'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Set app name and Dock icon (macOS)
app.setName('Agent HQ Control Center')

// The built directory structure
//
// ├─┬─┬ dist
// │ │ └── index.html
// │ │
// │ ├─┬ dist-electron
// │ │ ├── main.js
// │ │ └── preload.mjs
// │
process.env.APP_ROOT = path.join(__dirname, '..')

// 🚧 Use ['ENV_NAME'] avoid vite:define plugin - Vite@2.x
export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

let win: BrowserWindow | null
let statsTimer: ReturnType<typeof setInterval> | null = null

// ─── System Stats Polling ────────────────────────────────────
// Pushes CPU and memory usage to the renderer every 3 seconds
let lastCpuInfo = os.cpus()

function getCpuUsagePercent(): number {
  const cpus = os.cpus()
  let totalIdle = 0, totalTick = 0
  let prevTotalIdle = 0, prevTotalTick = 0

  for (let i = 0; i < cpus.length; i++) {
    const cpu = cpus[i]
    const prev = lastCpuInfo[i]
    for (const type of Object.keys(cpu.times) as (keyof typeof cpu.times)[]) {
      totalTick += cpu.times[type]
      prevTotalTick += prev.times[type]
    }
    totalIdle += cpu.times.idle
    prevTotalIdle += prev.times.idle
  }

  lastCpuInfo = cpus
  const idleDiff = totalIdle - prevTotalIdle
  const totalDiff = totalTick - prevTotalTick
  if (totalDiff === 0) return 0
  return Math.round((1 - idleDiff / totalDiff) * 100)
}

function startSystemStatsPolling(window: BrowserWindow) {
  if (statsTimer) clearInterval(statsTimer)

  statsTimer = setInterval(() => {
    if (window.isDestroyed()) {
      if (statsTimer) clearInterval(statsTimer)
      statsTimer = null
      return
    }

    const totalMem = Math.round(os.totalmem() / (1024 * 1024))
    const freeMem = Math.round(os.freemem() / (1024 * 1024))
    const usedMem = totalMem - freeMem

    window.webContents.send(IPC.SYSTEM_STATS, {
      cpuUsagePercent: getCpuUsagePercent(),
      memUsedMB: usedMem,
      memTotalMB: totalMem
    })
  }, 3000)
}

// ─── Window ──────────────────────────────────────────────────

function createWindow() {
  const iconPath = path.join(process.env.VITE_PUBLIC, 'icon-color.png')
  const appIcon = nativeImage.createFromPath(iconPath)

  // macOS Dock icon
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(appIcon)
  }

  win = new BrowserWindow({
    title: 'Agent HQ Control Center',
    icon: appIcon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      // Security hardening
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })

  // Once the page loads, start stats polling and auto-boot daemon
  win.webContents.on('did-finish-load', () => {
    if (!win) return

    // Start pushing system stats to the renderer
    startSystemStatsPolling(win)

    // Auto-start the daemon so the relay comes up automatically
    console.log('[Main] Auto-starting daemon...')
    daemonManager.start(win)
  })

  // Clear stats timer if window is destroyed
  win.on('closed', () => {
    if (statsTimer) {
      clearInterval(statsTimer)
      statsTimer = null
    }
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }

  setupIpcHandlers(win)
  vaultManager.setMainWindow(win)
  vaultManager.init()
}

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  vaultManager.stop()
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

app.on('before-quit', () => {
  vaultManager.stop()
})

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.whenReady().then(() => {
  // ─── CSP Headers ─────────────────────────────────────────
  // Restrict what the renderer can load to prevent XSS / data exfiltration
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline'",  // unsafe-inline needed for Vite HMR in dev
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
            "font-src 'self' https://fonts.gstatic.com",
            "img-src 'self' data: blob:",
            "connect-src 'self' ws://localhost:18900 http://localhost:18900",
          ].join('; ')
        ]
      }
    })
  })

  createWindow()
})
